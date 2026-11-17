// 核心服务：账本、到账、双向匹配、提币（在内嵌 Postgres 上运行，和生产同一份建表脚本）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { createTestDb } from '../server/pay/db.js';
import { migrate } from '../server/pay/schema.js';
import * as core from '../server/pay/core.js';
import { deriveAddress } from '../server/pay/tron.js';
import { legacyTronCustomer } from './legacy-tron.js';

const U = 1_000_000;
const XPUB = HDKey.fromMasterSeed(mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')).derive("m/44'/195'/0'").publicExtendedKey;
const HOT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
let seq = 0;
const tx = () => `tx${String(++seq).padStart(62, '0')}`;

async function setup(mode = core.DEFAULT_MODE) {
  const db = await createTestDb();
  await migrate(db);
  await core.setMeta(db, 'xpub', XPUB);
  const m = await core.createMerchant(db, { id: 'm1', name: 'Acme', feeIn: { ppm: 10_000, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 2 * U, min: 0 }, mode, cashoutWallets: [HOT] });
  return { db, m };
}
const bal = async (db) => (await db.query('select available, frozen from balances where merchant_id = $1', ['m1']))[0];
// 到账、匹配、提币这些用例和链无关，用已有 TRON 地址的老客户（K1：新客户不再生成地址，见 test/legacy-tron.js）
const cust = (db, id) => legacyTronCustomer(db, 'm1', id);

test('客户（K1）：新建客户不生成任何地址（address 为空），同一个标识永远是同一个客户；没初始化 TRON 主助记词也能建；老客户的 TRON 地址仍按序号从公钥推导', async () => {
  const { db } = await setup();
  const mk = (id) => db.tx((t) => core.ensureCustomer(t, 'm1', id));
  const a = await mk('user_1'), b = await mk('user_1'), c = await mk('user_2');
  assert.equal(a.address, null);
  assert.equal(c.address, null);
  assert.equal(a.seq, b.seq);
  assert.notEqual(a.seq, c.seq);
  assert.equal((await db.query(`select count(*)::int n from customer_addresses where customer_id in ('user_1', 'user_2')`))[0].n, 0);
  await assert.rejects(mk('bad id!'), /invalid_param/);
  // 没初始化 TRON 主助记词：照样能建客户（不再 503）
  const db2 = await createTestDb(); await migrate(db2);
  await core.createMerchant(db2, { id: 'm1', name: 'Acme', feeIn: { ppm: 0, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 0, min: 0 }, mode: core.DEFAULT_MODE });
  const d = await db2.tx((t) => core.ensureCustomer(t, 'm1', 'no_xpub'));
  assert.equal(d.customer_id, 'no_xpub');
  assert.equal(d.address, null);
  // 老客户（升级前就有的 TRON 地址）：地址照旧按序号从公钥推导
  const old = await cust(db, 'old_1');
  assert.equal(old.address, deriveAddress(XPUB, old.hd_index));
});

test('到账：扣收款费入账，写两条账本；重复的转账忽略；低于 1 USDT 不入账', async () => {
  const { db } = await setup();
  const c = await cust(db, 'u1');
  const id = tx();
  const r = await core.recordDeposit(db, { txid: id, logIndex: 0, block: 1, to: c.address, amount: 1000 * U, time: new Date() });
  assert.equal(r.status, 'credited');
  assert.equal((await bal(db)).available, 990 * U);
  assert.equal((await core.recordDeposit(db, { txid: id, logIndex: 0, block: 1, to: c.address, amount: 1000 * U, time: new Date() })).status, 'duplicate');
  assert.equal((await core.recordDeposit(db, { txid: tx(), logIndex: 0, block: 2, to: c.address, amount: 999_999, time: new Date() })).status, 'below_min');
  assert.equal((await core.recordDeposit(db, { txid: tx(), logIndex: 0, block: 2, to: HOT, amount: 5 * U, time: new Date() })).status, 'ignored');
  assert.equal((await bal(db)).available, 990 * U);
  const led = await db.query('select type, amount from ledger order by id');
  assert.deepEqual(led.map((x) => [x.type, x.amount]), [['deposit', 1000 * U], ['fee_in', -10 * U]]);
  const [cs] = await db.query('select total, count, fees, unmatched from customers where customer_id = $1', ['u1']);
  assert.deepEqual(cs, { total: 1000 * U, count: 1, fees: 10 * U, unmatched: 1000 * U });
  assert.equal((await db.query("select count(*)::int n from callbacks where event = 'deposit'"))[0].n, 1);
  await assert.rejects(db.query('delete from ledger'), /append-only/);
});

test('先建订单后到账：两笔累计达到下限即完成，匹配通知带到账列表', async () => {
  const { db, m } = await setup();
  const c = await cust(db, 'u1');
  const o = await core.createOrder(db, m, { customerId: 'u1', merchantOrderNo: 'A-1', amount: 100 * U });
  assert.equal(o.status, 'pending');
  await core.recordDeposit(db, { txid: tx(), logIndex: 0, block: 1, to: c.address, amount: 50 * U, time: new Date() });
  assert.equal((await core.orderView(db, o.order_no)).status, 'partial');
  await core.recordDeposit(db, { txid: tx(), logIndex: 0, block: 2, to: c.address, amount: 45 * U, time: new Date() });
  const v = await core.orderView(db, o.order_no);
  assert.equal(v.status, 'completed');
  assert.equal(v.matched, 95 * U);
  assert.equal(v.deposits.length, 2);
  const cbs = await db.query("select payload from callbacks where event = 'order.matched' order by created_at");
  assert.equal(cbs.at(-1).payload.data.status, 'completed');
  await assert.rejects(core.createOrder(db, m, { customerId: 'u1', merchantOrderNo: 'A-1', amount: 1 * U }), /duplicate_merchant_order_no/);
});

test('先到账后建订单：回看时间内、落在下限和上限之间才自动匹配', async () => {
  const { db, m } = await setup();
  const c = await cust(db, 'u2');
  await core.recordDeposit(db, { txid: tx(), logIndex: 0, block: 1, to: c.address, amount: 75 * U, time: new Date(Date.now() - 10 * 3600_000) });
  await core.recordDeposit(db, { txid: tx(), logIndex: 0, block: 1, to: c.address, amount: 250 * U, time: new Date(Date.now() - 26 * 3600_000) });
  const o = await core.createOrder(db, m, { customerId: 'u2', merchantOrderNo: 'B-1', amount: 80 * U });
  assert.equal(o.status, 'completed');
  assert.equal(o.deposits[0].matched_by, 'order');
  const o2 = await core.createOrder(db, m, { customerId: 'u2', merchantOrderNo: 'B-2', amount: 250 * U });
  assert.equal(o2.status, 'pending'); // 26 小时前的到账超出回看时间
  // 手动匹配、解除匹配
  const [d] = await db.query("select id from deposits where amount = $1", [250 * U]);
  const after = await core.setMatch(db, 'm1', o2.order_no, d.id, true, 'merchant:m1');
  assert.equal(after.status, 'completed');
  const back = await core.setMatch(db, 'm1', o2.order_no, d.id, false, 'merchant:m1');
  assert.equal(back.status, 'pending');
  const [cs] = await db.query('select unmatched from customers where customer_id = $1', ['u2']);
  assert.equal(cs.unmatched, 250 * U);
  assert.equal((await bal(db)).available, (75 + 250) * U * 0.99); // 匹配不改余额
});

test('订单模式关闭时不能建订单；订单过期处理', async () => {
  const { db, m } = await setup({ ...core.DEFAULT_MODE, enabled: false });
  await assert.rejects(core.createOrder(db, m, { customerId: 'u1', merchantOrderNo: 'X', amount: U }), /order_mode_disabled/);
  const { db: db2, m: m2 } = await setup();
  const c2 = await cust(db2, 'u1');
  const o = await core.createOrder(db2, m2, { customerId: 'u1', merchantOrderNo: 'E-1', amount: 100 * U });
  await core.recordDeposit(db2, { txid: tx(), logIndex: 0, block: 1, to: c2.address, amount: 10 * U, time: new Date() });
  // 过期后再等 5 分钟才处理：这段时间扫到的、过期前付的钱还能匹配
  assert.equal(await core.expireOrders(db2, new Date(Date.now() + 33 * 60_000)), 0);
  await core.recordDeposit(db2, { txid: tx(), logIndex: 0, block: 2, to: c2.address, amount: 5 * U, time: new Date(Date.now() + 29 * 60_000) });
  assert.equal((await core.orderView(db2, o.order_no)).matched, 15 * U);
  assert.equal(await core.expireOrders(db2, new Date(Date.now() + 36 * 60_000)), 1);
  assert.equal((await core.orderView(db2, o.order_no)).status, 'expired_partial');
});

test('收款手续费最多等于到账金额：最低收费大于到账金额时入账 0，不会让余额变成负数', async () => {
  const db = await createTestDb(); await migrate(db);
  await core.setMeta(db, 'xpub', XPUB);
  await core.createMerchant(db, { id: 'mf', name: 'Fee', feeIn: { ppm: 0, fixed: 0, min: 2 * U }, feeOut: { ppm: 0, fixed: 0, min: 0 }, mode: core.DEFAULT_MODE });
  const c = await legacyTronCustomer(db, 'mf', 'u1');
  const r = await core.recordDeposit(db, { txid: tx(), logIndex: 0, block: 1, to: c.address, amount: 1.5 * U, time: new Date() });
  assert.equal(r.status, 'credited');
  assert.equal(r.deposit.fee, 1.5 * U);
  assert.deepEqual(await db.query('select available from balances where merchant_id = $1', ['mf']), [{ available: 0 }]);
  await core.recordDeposit(db, { txid: tx(), logIndex: 0, block: 2, to: c.address, amount: 50 * U, time: new Date() });
  assert.deepEqual(await db.query('select available from balances where merchant_id = $1', ['mf']), [{ available: 48 * U }]);
});

test('同一个客户：建订单和到账同时发生，不会重复匹配', async () => {
  const { db, m } = await setup();
  const c = await cust(db, 'u3');
  await core.recordDeposit(db, { txid: tx(), logIndex: 0, block: 1, to: c.address, amount: 100 * U, time: new Date(Date.now() - 60_000) });
  const [a, b] = await Promise.all([
    core.createOrder(db, m, { customerId: 'u3', merchantOrderNo: 'C-1', amount: 100 * U }),
    core.createOrder(db, m, { customerId: 'u3', merchantOrderNo: 'C-2', amount: 100 * U }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), ['completed', 'pending']);
  assert.equal((await db.query('select count(*)::int n from deposits where order_id is not null'))[0].n, 1);
});

test('提币：冻结 → 取消解冻；驳回解冻；完成后从冻结中扣除；余额不够时拒绝', async () => {
  const { db, m } = await setup();
  const c = await cust(db, 'u1');
  await core.recordDeposit(db, { txid: tx(), logIndex: 0, block: 1, to: c.address, amount: 1000 * U, time: new Date() });
  const w = await core.requestWithdrawal(db, m, { kind: 'payout', to: HOT, amount: 100 * U, source: 'web', customerId: 'u1' });
  assert.equal(w.fee, 2 * U);
  assert.deepEqual(await bal(db), { available: 888 * U, frozen: 102 * U });
  await core.cancelWithdrawal(db, 'm1', w.withdrawal_no);
  assert.deepEqual(await bal(db), { available: 990 * U, frozen: 0 });
  await assert.rejects(core.cancelWithdrawal(db, 'm1', w.withdrawal_no), /invalid_state/);
  const w2 = await core.requestWithdrawal(db, m, { kind: 'cashout', to: HOT, amount: 500 * U, source: 'api' });
  await core.rejectWithdrawal(db, w2.withdrawal_no, '测试驳回', 'admin');
  assert.deepEqual(await bal(db), { available: 990 * U, frozen: 0 });
  const w3 = await core.requestWithdrawal(db, m, { kind: 'payout', to: HOT, amount: 300 * U, source: 'web' });
  await core.markWithdrawal(db, w3.withdrawal_no, 'signing', { batchId: 'B1' });
  await core.markWithdrawal(db, w3.withdrawal_no, 'broadcast', { txid: 'abc' });
  await core.settleWithdrawal(db, w3.withdrawal_no, true);
  assert.deepEqual(await bal(db), { available: 688 * U, frozen: 0 });
  await assert.rejects(core.requestWithdrawal(db, m, { kind: 'payout', to: HOT, amount: 700 * U, source: 'web' }), /insufficient_balance/);
  await assert.rejects(core.requestWithdrawal(db, m, { kind: 'cashout', to: c.address, amount: U, source: 'web' }), /address_not_registered/);
  const types = (await db.query('select type from ledger order by id')).map((x) => x.type);
  assert.deepEqual(types.slice(-3), ['freeze', 'withdraw', 'fee_out']);
});
