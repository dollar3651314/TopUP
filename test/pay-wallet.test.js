// 运营后台：提币签名、归集 3 步、核对规则
import test from 'node:test';
import assert from 'node:assert/strict';
import { hex } from '@scure/base';
import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { createTestDb } from '../server/pay/db.js';
import { migrate } from '../server/pay/schema.js';
import * as core from '../server/pay/core.js';
import { createFakeTron } from '../server/pay/fake-trongrid.js';
import { createWalletApi, sweepProgress } from '../server/pay/wallet-api.js';
import { derivePayKeys } from '../server/pay/common.js';
import { checkStep } from '../server/pay/verify.js';
import { signTxId, addressOfPrivateKey } from '../server/pay/signing.js';
import { encodeRaw } from '../server/pay/txcodec.js';
import { runTick } from '../server/pay/tick.js';
import { legacyTronCustomer } from './legacy-tron.js'; // K1：新客户不再生成地址；TRON 老地址的用例用已有 TRON 地址的老客户

const U = 1_000_000;
const root = HDKey.fromMasterSeed(mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'));
const XPUB = root.derive("m/44'/195'/0'").publicExtendedKey;
const HOT_KEY = hex.decode('11'.repeat(32));
const HOT = addressOfPrivateKey(HOT_KEY);
const COLD = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const keys = derivePayKeys('test-app-secret-test-app-secret-0123456789');

async function setup() {
  const db = await createTestDb(); await migrate(db);
  await core.setMeta(db, 'xpub', XPUB);
  const tron = createFakeTron();
  const m = await core.createMerchant(db, { id: 'm1', name: 'Acme', feeIn: { ppm: 10_000, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 2 * U, min: 0 } });
  let codeOk = true;
  const api = createWalletApi({ db, tron, keys, wallets: { hot: HOT, cold: COLD }, requireAdmin: async () => {}, verifyAdminCode: async () => codeOk });
  const call = async (a, body) => {
    const res = await api(new Request(`https://x/api/wallet/?a=${a}`, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'x-topup-csrf': '1' } }));
    return { status: res.status, body: await res.json() };
  };
  return { db, tron, m, call, setCode: (v) => (codeOk = v) };
}
const rules = { hot: HOT, cold: COLD, usdt: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf' };
const priv = (i) => root.derive(`m/44'/195'/0'/0/${i}`).privateKey;

test('提币：浏览器核对 → 验证码 → 签名 → 广播 → 链上确认后完成', async () => {
  const { db, tron, m, call } = await setup();
  const c = await legacyTronCustomer(db, 'm1', 'u1');
  await core.recordDeposit(db, { txid: 'a'.repeat(64), logIndex: 0, block: 1, to: c.address, amount: 500 * U, time: new Date() });
  const w = await core.requestWithdrawal(db, m, { kind: 'payout', to: COLD, amount: 100 * U, source: 'web' });
  // 第 3 批：TRON 只凑已审核的单；待审核的直接凑批 409 not_approved（不能绕过逐笔审核：登记地址、第一次付的地址、上限）
  tron.accounts.set(HOT, { activated: true, trx: 100 * U, trc20: { [tron.contract]: 1000 * U } });
  const notYet = await call('withdraw-plan', { ids: [w.withdrawal_no] });
  assert.equal(notYet.status, 409);
  assert.equal(notYet.body.error.code, 'not_approved');
  assert.equal((await core.withdrawalView(db, w.withdrawal_no)).status, 'pending', '凑批被拒后这一笔仍是待审核（没有顺带审核通过）');
  const appr = await call('payout-approve', { ids: [w.withdrawal_no] });
  assert.equal(appr.status, 200);
  assert.deepEqual(appr.body.approved, [w.withdrawal_no]);
  tron.accounts.set(HOT, { activated: true, trx: 100 * U, trc20: { [tron.contract]: 50 * U } });
  assert.equal((await call('withdraw-plan', { ids: [w.withdrawal_no] })).body.error.code, 'hot_wallet_insufficient');
  tron.accounts.set(HOT, { activated: true, trx: 100 * U, trc20: { [tron.contract]: 1000 * U } });
  const plan = (await call('withdraw-plan', { ids: [w.withdrawal_no] })).body;
  const step = plan.steps[0];
  // 浏览器端核对：期望值用审核列表里的收款地址和金额（整数）
  assert.ok(checkStep(step, { to: COLD, amount: 100 * U }, rules).ok);
  assert.equal(checkStep(step, { to: 'TJ1c1YU6Jq3orqQ8mPGkpXt1TTNC3EBK7Q', amount: 100 * U }, rules).ok, false);
  const sigs = { [step.txID]: signTxId(step.txID, HOT_KEY) };
  assert.equal((await call('sign-submit', { batch_id: plan.batch_id, signatures: sigs })).body.error.code, 'verify_required');
  assert.equal((await call('sign-verify', { batch_id: plan.batch_id, code: '123456' })).status, 200);
  // 用错误的私钥签名：服务器核对签名人，拒绝
  const bad = await call('sign-submit', { batch_id: plan.batch_id, signatures: { [step.txID]: signTxId(step.txID, hex.decode('22'.repeat(32))) } });
  assert.equal(bad.body.error.code, 'bad_signature');
  const ok = (await call('sign-submit', { batch_id: plan.batch_id, signatures: sigs })).body;
  assert.equal(ok.results[0].status, 'broadcast');
  tron.confirm(ok.results[0].txid, true);
  await runTick({ db, tron, getTarget: async () => null });
  assert.equal((await core.withdrawalView(db, w.withdrawal_no)).status, 'completed');
});

test('归集：借出能量 → 转出 USDT → 收回能量，每一步确认后才做下一步；新地址改为转 TRX 燃烧', async () => {
  const { db, tron, call } = await setup();
  const a = await legacyTronCustomer(db, 'm1', 'old'), b = await legacyTronCustomer(db, 'm1', 'new');
  for (const [c, amt] of [[a, 300 * U], [b, 80 * U]]) await core.recordDeposit(db, { txid: c.address.padEnd(64, '0').slice(0, 64), logIndex: 0, block: 1, to: c.address, amount: amt, time: new Date() });
  tron.accounts.set(a.address, { activated: true, trx: 0, trc20: { [tron.contract]: 300 * U } });
  tron.accounts.set(b.address, { activated: false, trx: 0, trc20: { [tron.contract]: 80 * U } });
  const list = (await call('sweep-list')).body;
  assert.equal(list.items.length, 2);
  const plan = (await call('sweep-plan', { addresses: [a.address, b.address], to: 'hot' })).body;
  const byAddr = Object.fromEntries(plan.items.map((it) => [it.address, it]));
  assert.deepEqual(byAddr[a.address].steps.map((s) => s.kind), ['delegate', 'sweep_usdt', 'undelegate']);
  assert.deepEqual(byAddr[b.address].steps.map((s) => s.kind), ['fee_trx', 'sweep_usdt']);
  // 浏览器端：按序号用助记词推导地址，核对每一步，再签名
  const sigs = {};
  for (const it of plan.items) {
    const from = addressOfPrivateKey(priv(it.index));
    assert.equal(from, it.address);
    for (const s of it.steps) {
      const expect = s.kind === 'sweep_usdt' ? { from } : { to: from };
      const r = checkStep(s, expect, rules);
      assert.ok(r.ok, `${s.kind}: ${r.error}`);
      sigs[s.txID] = signTxId(s.txID, s.kind === 'sweep_usdt' ? priv(it.index) : HOT_KEY);
    }
  }
  await call('sign-verify', { batch_id: plan.batch_id, code: '123456' });
  assert.equal((await call('sign-submit', { batch_id: plan.batch_id, signatures: sigs })).body.status, 'stage1');
  assert.equal(tron.broadcasts.length, 2); // 只广播了第 1 步
  const confirmAll = () => { for (const d of tron.broadcasts) if (!tron.txs.get(d.txId)?.ok) tron.confirm(d.txId, true); };
  confirmAll(); await sweepProgress(db, tron);
  assert.equal(tron.broadcasts.length, 4); // 第 2 步：两笔 USDT
  confirmAll(); await sweepProgress(db, tron);
  assert.equal(tron.broadcasts.length, 5); // 第 3 步：只有借了能量的那个地址要收回
  confirmAll(); await sweepProgress(db, tron);
  const [bt] = await db.query('select status from sign_batches');
  assert.equal(bt.status, 'done');
  const rows = await db.query('select onchain from customers order by customer_id');
  assert.deepEqual(rows.map((r) => r.onchain), [0, 0]);
  assert.equal((await db.query(`select count(*)::int n from sweeps where status = 'done'`))[0].n, 2);
});

test('核对规则：收款地址不是热钱包或冷钱包、付款地址不对、多签、过期时间异常，都拦下', () => {
  const addr = addressOfPrivateKey(priv(0));
  const mk = (c, o) => ({ kind: 'sweep_usdt', rawHex: encodeRaw({ type: 'TriggerSmartContract', contract: rules.usdt, ...c }, { expiration: Date.now() + 600_000, ...o }) });
  assert.ok(checkStep(mk({ owner: addr, to: HOT, amount: 5 }), { from: addr }, rules).ok);
  assert.match(checkStep(mk({ owner: addr, to: 'TJ1c1YU6Jq3orqQ8mPGkpXt1TTNC3EBK7Q', amount: 5 }), { from: addr }, rules).error, /不是热钱包或冷钱包/);
  assert.match(checkStep(mk({ owner: HOT, to: HOT, amount: 5 }), { from: addr }, rules).error, /推导出的地址不一致/);
  assert.match(checkStep(mk({ owner: addr, to: HOT, amount: 5 }, { expiration: Date.now() + 5 * 3600_000 }), { from: addr }, rules).error, /过期时间/);
  const fee = { kind: 'fee_trx', rawHex: encodeRaw({ type: 'TransferContract', owner: HOT, to: addr, amount: 31 * U }, { expiration: Date.now() + 600_000 }) };
  assert.match(checkStep(fee, { to: addr }, rules).error, /金额过高/);
  const wrongTx = { ...mk({ owner: addr, to: HOT, amount: 5 }), txID: '00'.repeat(32) };
  assert.match(checkStep(wrongTx, { from: addr }, rules).error, /哈希/);
});

test('钱包初始化接口已删除：wallet-init 一律 404 not_found（交私钥、交 xpub 都一样），不写 xpub、不留审计', async () => {
  // 第 3 批：全新系统也没有"初始化主助记词"，按钮先删、接口随后删；删了以后任何请求都不能再写主 xpub
  const { db, call } = await setup();
  await db.query("delete from pay_meta where key = 'xpub'");
  const acc = root.derive("m/44'/195'/0'");
  const auditBefore = (await db.query('select count(*)::int n from pay_audit'))[0].n;
  for (const body of [
    { xpub: acc.privateExtendedKey, first_address: 'x', code: '1' },
    { xpub: XPUB, first_address: HOT, code: '1' },
    { xpub: XPUB, first_address: addressOfPrivateKey(priv(0)), code: '1' },
  ]) {
    const r = await call('wallet-init', body);
    assert.equal(r.status, 404, `wallet-init 应该已删除（404），实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, 'not_found');
  }
  assert.equal((await db.query("select count(*)::int n from pay_meta where key = 'xpub'"))[0].n, 0, '不能写进主 xpub');
  assert.equal((await db.query('select count(*)::int n from pay_audit'))[0].n, auditBefore, '不留审计（接口不存在）');
});

test('归集只转账本上记录过的金额：链上多出来的还没扫到的到账先不动', async () => {
  const { db, tron, call } = await setup();
  const a = await legacyTronCustomer(db, 'm1', 'f6');
  await core.recordDeposit(db, { txid: 'f6'.padEnd(64, '0'), logIndex: 0, block: 1, to: a.address, amount: 100 * U, time: new Date() });
  tron.accounts.set(a.address, { activated: true, trx: 0, trc20: { [tron.contract]: 130 * U } }); // 链上多了 30，还没扫到
  const plan = (await call('sweep-plan', { addresses: [a.address], to: 'hot' })).body;
  assert.equal(plan.items[0].amount, '100.00');
});

test('按商户核对：商户收款合计按账本计算，客户合计被改动时能发现', async () => {
  const { db, call } = await setup();
  const a = await legacyTronCustomer(db, 'm1', 'f7');
  await core.recordDeposit(db, { txid: 'f7'.padEnd(64, '0'), logIndex: 0, block: 1, to: a.address, amount: 10 * U, time: new Date() });
  let m = (await call('recon')).body.merchants[0];
  assert.deepEqual([m.deposits_total, m.customers_total, m.ok], ['10.00', '10.00', true]);
  await db.query(`update customers set total = total + 1 where customer_id = 'f7'`);
  m = (await call('recon')).body.merchants[0];
  assert.equal(m.ok, false);
});

test('同一笔交易里两次低于 1 USDT 的转账，异常到账各记一条', async () => {
  const { db } = await setup();
  const a = await legacyTronCustomer(db, 'm1', 'f8');
  for (const i of [0, 1]) await core.recordDeposit(db, { txid: 'f8'.padEnd(64, '0'), logIndex: i, block: 1, to: a.address, amount: 1, time: new Date() });
  assert.equal((await db.query(`select count(*)::int n from anomalies where type = 'below_min'`))[0].n, 2);
});

test('热钱包一栏可以填私钥或助记词：助记词按 TRON 路径找到热钱包地址（TronLink 的账户）', async () => {
  const { keyForAddress, addressOfPrivateKey } = await import('../server/pay/signing.js');
  const words = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const first = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH'; // 公开测试助记词的第 0 个地址（和 TronLink 一致）
  const r = await keyForAddress(`  ${words.toUpperCase()} `, first);
  assert.equal(addressOfPrivateKey(r.key), first);
  const hexKey = Buffer.from(r.key).toString('hex');
  assert.equal(addressOfPrivateKey((await keyForAddress(hexKey, first)).key), first); // 私钥
  assert.equal((await keyForAddress(hexKey, HOT)).error, 'mismatch');
  assert.equal((await keyForAddress(words, HOT)).error, 'not_found');
  assert.equal((await keyForAddress('abandon about', first)).error, 'format');
  assert.equal((await keyForAddress(words.replace('about', 'abandon'), first)).error, 'mnemonic');
});

test('概览：代收、欠商户、平台资产、利润（现在能转走 / 归集后）、利润来源、待处理、待归集', async () => {
  const { db, tron, call } = await setup();
  const a = await legacyTronCustomer(db, 'm1', 'ov');
  await core.recordDeposit(db, { txid: 'ov'.padEnd(64, '0'), logIndex: 0, block: 1, to: a.address, amount: 100 * U, time: new Date() }); // 收款费 1%
  await core.recordDeposit(db, { txid: 'ov'.padEnd(64, '1'), logIndex: 0, block: 2, to: a.address, amount: 1, time: new Date() }); // 灰尘
  tron.accounts.set(HOT, { activated: true, trx: 300 * U, trc20: { [tron.contract]: 50 * U } });
  tron.accounts.set(COLD, { activated: true, trx: 0, trc20: { [tron.contract]: 20 * U } });
  // 两个接口：数据库统计、链上余额和利润；页面把两批数据合并显示
  const both = async () => {
    const [a1, a2] = [await call('overview'), await call('overview-chain')];
    assert.equal(a1.status, 200); assert.equal(a2.status, 200);
    return { funds: { ...a1.body.funds, ...a2.body.funds }, todo: { ...a1.body.todo, ...a2.body.todo }, sweep: { ...a1.body.sweep, ...a2.body.sweep }, periods: a1.body.periods };
  };
  const r = { body: await both() };
  const f = r.body.funds;
  assert.deepEqual([f.collected_total, f.owed_total, f.owed_available, f.owed_frozen], ['100.00', '99.00', '99.00', '0.00']);
  assert.deepEqual([f.unswept_total, f.hot_usdt, f.cold_usdt, f.assets_total], ['100.000001', '50.00', '20.00', '170.000001']);
  assert.deepEqual([f.profit_total, f.profit_now, f.profit_after_sweep], ['71.000001', '0.00', '71.000001']); // 钱包 70 < 欠商户 99：现在不能转走
  assert.deepEqual([f.income_fee_in, f.income_fee_out, f.income_dust], ['1.00', '0.00', '0.000001']);
  assert.equal(r.body.todo.anomalies, 1);
  assert.deepEqual([r.body.sweep.address_count, r.body.sweep.over_threshold, r.body.sweep.hot_trx], [1, 1, '300.00']);
  assert.deepEqual([r.body.periods.today.amount, r.body.periods.today.count, r.body.periods.d30.fees_in], ['100.00', 1, '1.00']);
  // 钱包里的钱多于欠商户时，多出来的部分现在就能转走
  tron.accounts.set(HOT, { activated: true, trx: 300 * U, trc20: { [tron.contract]: 150 * U } });
  const f2 = (await both()).funds;
  assert.deepEqual([f2.profit_total, f2.profit_now, f2.profit_after_sweep], ['171.000001', '71.00', '100.000001']);
});
