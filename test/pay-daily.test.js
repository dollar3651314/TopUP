// 每日任务：对账、其他代币检查、提醒
import test from 'node:test';
import assert from 'node:assert/strict';
import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { createTestDb } from '../server/pay/db.js';
import { migrate } from '../server/pay/schema.js';
import * as core from '../server/pay/core.js';
import { createFakeTron } from '../server/pay/fake-trongrid.js';
import { runDaily } from '../server/pay/daily.js';

const U = 1_000_000;
const XPUB = HDKey.fromMasterSeed(mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')).derive("m/44'/195'/0'").publicExtendedKey;
const HOT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

test('对账一致时不发邮件；链上少了钱时发邮件；发现其他代币记为异常；监控停了提醒', async () => {
  const db = await createTestDb(); await migrate(db);
  await core.setMeta(db, 'xpub', XPUB);
  const tron = createFakeTron();
  const m = await core.createMerchant(db, { id: 'm1', name: 'Acme', feeIn: { ppm: 10_000, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 2 * U, min: 0 } });
  const c = await db.tx((t) => core.ensureCustomer(t, 'm1', 'u1'));
  await core.recordDeposit(db, { txid: 'a'.repeat(64), logIndex: 0, block: 1, to: c.address, amount: 1000 * U, time: new Date() });
  await core.recordDeposit(db, { txid: 'b'.repeat(64), logIndex: 0, block: 1, to: c.address, amount: 500_000, time: new Date() }); // 低于 1 USDT
  const w = await core.requestWithdrawal(db, m, { kind: 'payout', to: HOT, amount: 100 * U, source: 'web' });
  await core.markWithdrawal(db, w.withdrawal_no, 'signing'); await core.markWithdrawal(db, w.withdrawal_no, 'broadcast', { txid: 't' }); await core.settleWithdrawal(db, w.withdrawal_no, true);
  // 链上：客户地址 1000.5，热钱包转出了 100
  tron.accounts.set(c.address, { activated: true, trx: 0, trc20: { [tron.contract]: 1000_500_000 } });
  tron.accounts.set(HOT, { activated: true, trx: 0, trc20: { [tron.contract]: -100 * U } });
  await core.setMeta(db, 'tick_last', { at: new Date().toISOString() });
  const mails = [];
  const notify = async (s, t) => mails.push(t);
  let r = await runDaily({ db, tron, wallets: { hot: HOT, cold: '' }, notify });
  assert.equal(r.recon.diff, 0, JSON.stringify(r.recon));
  assert.equal(mails.length, 0);
  // 地址上少了 5 USDT，并且出现了别的代币；监控 10 分钟没运行
  tron.accounts.set(c.address, { activated: true, trx: 0, trc20: { [tron.contract]: 995_500_000, TOtherTokenxxxxxxxxxxxxxxxxxxxxxx: 7 } });
  await core.setMeta(db, 'tick_last', { at: new Date(Date.now() - 10 * 60_000).toISOString() });
  r = await runDaily({ db, tron, wallets: { hot: HOT, cold: '' }, notify });
  assert.equal(r.recon.diff, -5 * U);
  assert.equal(r.tokens, 1);
  assert.equal(mails.length, 1);
  assert.match(mails[0], /对账不一致/);
  assert.match(mails[0], /USDT 以外的代币/);
  assert.match(mails[0], /超过 5 分钟/);
  assert.equal((await db.query(`select count(*)::int n from anomalies where type = 'token'`))[0].n, 1);
});
