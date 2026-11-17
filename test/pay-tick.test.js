// 每分钟任务：扫链、回调（签名、重试、内网拦截）、提币确认、通知邮件合并
import test from 'node:test';
import assert from 'node:assert/strict';
import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { createTestDb } from '../server/pay/db.js';
import { migrate } from '../server/pay/schema.js';
import * as core from '../server/pay/core.js';
import { createFakeTron } from '../server/pay/fake-trongrid.js';
import { scan, runTick, notifyWithdrawals } from '../server/pay/tick.js';
import { signCallback, checkCallbackUrl, isPrivateIp, RETRY_MIN, resend } from '../server/pay/callbacks.js';
import { legacyTronCustomer } from './legacy-tron.js'; // K1：新客户不再生成地址；TRON 老地址的用例用已有 TRON 地址的老客户

const U = 1_000_000;
const XPUB = HDKey.fromMasterSeed(mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')).derive("m/44'/195'/0'").publicExtendedKey;
const HOT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const publicDns = async () => [{ address: '93.184.216.34' }];

async function setup() {
  const db = await createTestDb(); await migrate(db);
  await core.setMeta(db, 'xpub', XPUB);
  const m = await core.createMerchant(db, { id: 'm1', name: 'Acme', feeIn: { ppm: 10_000, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 2 * U, min: 0 } });
  const tron = createFakeTron({ pageSize: 3 });
  return { db, m, tron };
}

test('扫链：只入账转到客户地址的转账，翻页、游标前进，重复扫描不会重复入账', async () => {
  const { db, tron } = await setup();
  const c = await legacyTronCustomer(db, 'm1', 'u1');
  const now = Date.now();
  await core.setMeta(db, 'scan_cursor', now - 120_000);
  for (let i = 0; i < 7; i++) tron.pay({ to: i % 2 ? c.address : HOT, amount: 10 * U, time: now - 60_000 + i * 1000 });
  const r = await scan(db, tron, { now });
  assert.equal(r.credited, 3);
  assert.ok(r.pages >= 3);
  assert.equal(r.complete, true);
  const again = await scan(db, tron, { now: now + 1000 });
  assert.equal(again.credited, 0);
  assert.equal((await db.query('select count(*)::int n from deposits'))[0].n, 3);
});

test('回调：带签名；失败按 1 分钟、5 分钟……重试；24 小时后停止；可以手动重发', async () => {
  const { db, tron } = await setup();
  const c = await legacyTronCustomer(db, 'm1', 'u1');
  await core.setMeta(db, 'scan_cursor', Date.now() - 60_000);
  tron.pay({ to: c.address, amount: 20 * U, time: Date.now() - 1000 });
  const got = [];
  let reply = 500;
  const fetchImpl = async (url, init) => { got.push({ url, init }); return new Response('', { status: reply }); };
  const getTarget = async () => ({ url: 'https://merchant.example/cb', secret: 's3cret' });
  await runTick({ db, tron, getTarget, fetchImpl, resolve: publicDns });
  assert.equal(got.length, 1);
  const h = got[0].init.headers;
  assert.equal(h['X-TopUP-Signature'], signCallback('s3cret', h['X-TopUP-Timestamp'], got[0].init.body));
  assert.equal(JSON.parse(got[0].init.body).type, 'deposit');
  // 回调里的金额是字符串，和开放 API 一致
  assert.equal(JSON.parse(got[0].init.body).data.amount, '20.00');
  let [cb] = await db.query('select * from callbacks');
  assert.equal(cb.attempts, 1);
  assert.ok(Math.abs(new Date(cb.next_at) - Date.now() - RETRY_MIN[0] * 60_000) < 5000);
  // 把它推到"所有重试都用完"
  await db.query(`update callbacks set attempts = $1, next_at = now()`, [RETRY_MIN.length]);
  await runTick({ db, tron, getTarget, fetchImpl, resolve: publicDns });
  [cb] = await db.query('select * from callbacks');
  assert.equal(cb.status, 'failed');
  assert.ok(await resend(db, 'm1', cb.id));
  reply = 200;
  await runTick({ db, tron, getTarget, fetchImpl, resolve: publicDns });
  [cb] = await db.query('select * from callbacks');
  assert.equal(cb.status, 'ok');
});

test('回调地址：只允许 https，不允许内网地址', async () => {
  assert.equal(await checkCallbackUrl('http://merchant.example/cb', publicDns), 'https_required');
  assert.equal(await checkCallbackUrl('https://127.0.0.1/cb'), 'private_address');
  assert.equal(await checkCallbackUrl('https://internal.example/cb', async () => [{ address: '10.1.2.3' }]), 'private_address');
  assert.equal(await checkCallbackUrl('https://merchant.example/cb', publicDns), null);
  assert.ok(isPrivateIp('169.254.169.254') && isPrivateIp('::1') && isPrivateIp('fd00::1') && !isPrivateIp('8.8.8.8'));
});

test('提币：广播后链上确认才扣除冻结；新申请合并成一封邮件', async () => {
  const { db, m, tron } = await setup();
  const c = await legacyTronCustomer(db, 'm1', 'u1');
  await core.recordDeposit(db, { txid: 'a'.repeat(64), logIndex: 0, block: 1, to: c.address, amount: 500 * U, time: new Date() });
  const w1 = await core.requestWithdrawal(db, m, { kind: 'payout', to: HOT, amount: 100 * U, source: 'web' });
  const w2 = await core.requestWithdrawal(db, m, { kind: 'payout', to: HOT, amount: 50 * U, source: 'api' });
  const mails = [];
  const notify = async (subject, text) => mails.push({ subject, text });
  assert.equal(await notifyWithdrawals(db, notify, 'https://x/admin/'), 2);
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /2 笔/);
  assert.equal(await notifyWithdrawals(db, notify, 'https://x/admin/'), 0);
  await core.markWithdrawal(db, w1.withdrawal_no, 'signing');
  await core.markWithdrawal(db, w1.withdrawal_no, 'broadcast', { txid: 'tx1' });
  await runTick({ db, tron, getTarget: async () => null, notify });
  assert.equal((await core.withdrawalView(db, w1.withdrawal_no)).status, 'broadcast'); // 还没确认
  tron.confirm('tx1', true);
  await runTick({ db, tron, getTarget: async () => null, notify });
  assert.equal((await core.withdrawalView(db, w1.withdrawal_no)).status, 'completed');
  const [b] = await db.query('select available, frozen from balances');
  assert.deepEqual(b, { available: 495 * U - 102 * U - 52 * U, frozen: 52 * U });
  void w2;
});

test('扫链只读到已确认的区块：还没确认的转账，游标不会越过它，确认后能扫到', async () => {
  const { db, tron } = await setup();
  const c = await legacyTronCustomer(db, 'm1', 'u9');
  const now = Date.now();
  await core.setMeta(db, 'scan_cursor', now - 60_000);
  tron.solidBlock = async () => ({ number: 1, time: now - 70_000 }); // 最新已确认区块在 70 秒前
  tron.pay({ to: c.address, amount: 7 * U, time: now - 20_000 }); // 20 秒前的转账，还没确认
  const r1 = await scan(db, tron, { now });
  assert.equal(r1.credited, 0);
  assert.ok(r1.cursor <= now - 70_000 + 1, '游标不能越过已确认区块');
  tron.solidBlock = async () => ({ number: 2, time: now + 60_000 }); // 确认了
  const r2 = await scan(db, tron, { now: now + 90_000 });
  assert.equal(r2.credited, 1);
});

test('一笔到账处理失败不会卡住扫链：记为异常，后面的照常入账', async () => {
  const { db, tron } = await setup();
  const a = await legacyTronCustomer(db, 'm1', 'ua'), b = await legacyTronCustomer(db, 'm1', 'ub');
  await core.setMeta(db, 'scan_cursor', Date.now() - 60_000);
  tron.pay({ to: a.address, amount: 3 * U, time: Date.now() - 2000 });
  tron.pay({ to: b.address, amount: 4 * U, time: Date.now() - 1000 });
  const orig = db.tx;
  let n = 0;
  db.tx = (fn) => (++n === 1 ? Promise.reject(new Error('boom')) : orig(fn)); // 第一笔处理时出错
  const errs = [];
  const r = await scan(db, tron, { onError: (ids) => errs.push(...ids) });
  db.tx = orig;
  assert.equal(r.credited, 1);
  assert.equal(r.failed, 1);
  assert.equal(errs.length, 1);
  assert.equal((await db.query(`select count(*)::int n from anomalies where type = 'process_error'`))[0].n, 1);
});

test('回调重试：从第一次发送算起，最后一次在 24 小时', async () => {
  const gaps = RETRY_MIN.map((m, i) => m - (RETRY_MIN[i - 1] ?? 0));
  assert.equal(gaps.reduce((a, b) => a + b, 0), 24 * 60);
  assert.ok(gaps.every((g) => g > 0));
});

test('回调地址：内网地址的各种写法都被拒绝', async () => {
  for (const ip of ['127.0.0.1', '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:10.0.0.1', 'not-an-ip'])
    assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946', '::ffff:93.184.216.34', '64:ff9b::5db8:d822'])
    assert.equal(isPrivateIp(ip), false, ip);
  for (const u of ['https://[::ffff:7f00:1]/cb', 'https://[::ffff:a9fe:a9fe]/', 'https://[64:ff9b::7f00:1]/'])
    assert.equal(await checkCallbackUrl(u), 'private_address', u);
});

test('回调发送时再检查一次解析结果（F4，DNS 重绑定）：连接时解析到内网就不发送', async () => {
  const { pinnedFetch } = await import('../server/pay/callbacks.js');
  await assert.rejects(pinnedFetch('https://merchant.example/cb', { body: '{}' }, async () => [{ address: '127.0.0.1', family: 4 }]), /private_address/);
});
