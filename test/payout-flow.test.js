// 测试先写（第 3 批）：打款单从申请到记账——按链申请、逐笔审核、商户批量逐行勾选一次审完、驳回退冻结逐笔回调、
// 商户取消还没审的、以太坊 / BSC 一批失败整批回滚、TRON 逐笔记账、网络费不另收、23:00 以后照发邮件并告诉商户第二天 8:00 后处理。
// 依据：已定 TU-6（每笔都由管理员审）、Q15（ETH / BSC 一批一笔失败整批回滚，回到"已审核"重签）、Q-B2（TRON 逐笔记账，失败的回到已审核待签名）、
//   Q-B3（单笔一单一审；商户批量在一个弹窗里逐行勾选、一次通过勾选的）、Q-B4（驳回的退冻结、逐笔发回调，其余照付；批次显示"部分被驳回"）、
//   Q-B5（网络费不另收，含在付款手续费里）、Q-B7、P5（商户余额一个数、提币时选链）、原型偏离第 6 条（商户可以取消还没审核的批量打款）、
//   技术方案 05 页（cashout 必须是登记地址、代付没有白名单；ETH / BSC 地址校验和、TRON Base58）。
//
// 期望（给研发）：
//   withdrawals 加 chain 列（eth / bsc / tron）；core.requestWithdrawal(db, merchant, { kind, chain = 'tron', to, amount, ... })：
//     地址按链校验（ETH / BSC 必须是 EIP-55 校验和正确的 0x 地址，TRON 是 Base58），不对 invalid_address；
//     cashout 必须是该链登记过的地址：merchants.cashout_wallets 元素是 { chain, address }（老数据里的字符串当作 TRON），
//     同一串 0x 地址登记在以太坊不等于登记在 BSC，不对 address_not_registered；withdrawalView 多返回 chain
//   新模块 server/pay/payout.js：
//     approvePayouts(db, { ids, actor, now }) → { approved: [id], refused: [{ id, reason }] }：pending → approved（对外状态 approved）；
//       单笔超单笔上限 exceeds_per_item_limit、当天（东八区）已通过的合计加上这笔超每天上限 exceeds_daily_limit，这两种留在 pending；审计 payout.approve
//     reviewPayoutBatch(db, { batchNo, approve: [id], reason, actor }) → 批次视图：approve 里的通过，这一批里其余还在 pending 的全部驳回（原因必填 reason_required）；
//       驳回的逐笔退冻结、逐笔回调 withdrawal.updated（status rejected）；批次 status 'partially_rejected'（全通过 'approved'，全驳回 'rejected'）
//     submitPayoutBatch(db, merchant, { rows, source, onlyValid = false, now, notify }) → { batch_no, accepted, rejected_rows, totals, service }
//       rows：[{ chain, to, amount（USDT 字符串）, customer_id?, merchant_ref? }]；最多 500 行（too_many_items）；有问题的行默认整张不收（invalid_rows，
//       error.rows 列出行号和原因），onlyValid = true 时只收没问题的行；每笔都是一条 withdrawals（kind payout、batch_ref = batch_no、status pending），
//       一次冻结 sum(金额 + 付款手续费)，不另收网络费；totals 按链 { count, amount, fee, total }；
//       service = serviceWindow(now)：不在时段内照样调 notify（给管理员发邮件），service.open = false、service.next_open_at = 下一个 8:00
//     cancelPayoutBatch(db, merchantId, batchNo) → { cancelled, kept }：只取消还没审核（pending）的，退冻结、逐笔回调；已通过的不动；别的商户的批次 not_found
//     createPayoutTxBatch(db, { chain, ids }) → 批次号：approved → signing（对外仍是 approved），记 batch_id
//     settlePayoutBatch(db, id, { success, txid })：ETH / BSC 一笔交易。成功：每笔 completed，冻结里扣金额和手续费，逐笔回调；
//       失败：整批回滚——每笔回到 approved、batch_id 清空、冻结不动、账本不动，批次 failed
//     settlePayoutItem(db, withdrawalId, { success, txid })：TRON 逐笔。成功同上；失败回到 approved（已审核待签名）、冻结不动
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setupDb } from './wallet-helpers.js';
import * as core from '../server/pay/core.js';
import { toChecksumAddress } from '../server/wallet/create2.js';

const U = 1_000_000;
const load = () => import(new URL('../server/pay/payout.js', import.meta.url).href);
const evm = () => toChecksumAddress('0x' + randomBytes(20).toString('hex'));
const TRON_A = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TRON_B = 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7';
const FEE_OUT = { ppm: 0, fixed: 1 * U, min: 0 }; // 每笔 1 USDT 付款手续费

async function setup({ cashout = [] } = {}) {
  const db = await setupDb({ customers: [], merchants: ['m1', 'm2'] });
  await db.query(`update merchants set fee_out = $1::jsonb, cashout_wallets = $2::jsonb`, [JSON.stringify(FEE_OUT), JSON.stringify(cashout)]);
  for (const m of ['m1', 'm2']) {
    await db.query('update balances set available = available + $2 where merchant_id = $1', [m, 100_000 * U]);
    await db.query(`insert into ledger (merchant_id, type, amount, available_after, frozen_after, ref) values ($1, 'deposit', $2, $2, 0, 'seed')`, [m, 100_000 * U]);
  }
  const m1 = await core.getMerchant(db, 'm1');
  return { db, m1 };
}
const bal = async (db, m = 'm1') => (await db.query('select available::bigint a, frozen::bigint f from balances where merchant_id = $1', [m])).map((r) => [Number(r.a) / U, Number(r.f) / U])[0];
const st = async (db, id) => (await db.query('select status, batch_id from withdrawals where id = $1', [id]))[0];
const cbs = async (db, id) => (await db.query(`select payload from callbacks where event = 'withdrawal.updated' and payload->'data'->>'withdrawal_no' = $1 order by created_at, id`, [id])).map((r) => r.payload.data.status);
const ledgerN = async (db) => (await db.query('select count(*)::int n from ledger'))[0].n;
const req = (db, m, o) => core.requestWithdrawal(db, m, { kind: 'payout', source: 'web', ...o });

test('按链申请：ETH / BSC 地址要校验和、TRON 要 Base58；withdrawalView 带 chain', async () => {
  const { db, m1 } = await setup();
  const to = evm();
  const w = await req(db, m1, { chain: 'eth', to, amount: 10 * U });
  assert.equal(w.chain, 'eth');
  assert.equal((await req(db, m1, { chain: 'bsc', to, amount: 10 * U })).chain, 'bsc');
  assert.equal((await req(db, m1, { chain: 'tron', to: TRON_A, amount: 10 * U })).chain, 'tron');
  const bad = to.slice(0, 2) + (to[2] === to[2].toLowerCase() ? to[2].toUpperCase() : to[2].toLowerCase()) + to.slice(3);
  if (bad !== to && /[a-fA-F]/.test(to[2])) await assert.rejects(req(db, m1, { chain: 'eth', to: bad, amount: U }), (e) => e.code === 'invalid_address', '校验和不对');
  await assert.rejects(req(db, m1, { chain: 'eth', to: TRON_A, amount: U }), (e) => e.code === 'invalid_address');
  await assert.rejects(req(db, m1, { chain: 'tron', to, amount: U }), (e) => e.code === 'invalid_address');
  await assert.rejects(req(db, m1, { chain: 'btc', to, amount: U }), (e) => e.code === 'invalid_param');
  // 不带 chain 的老调用方照旧是 TRON
  assert.equal((await req(db, m1, { to: TRON_B, amount: U })).chain, 'tron');
});

test('P5 提币选链：cashout 只能提到该链登记过的地址；同一串 0x 登记在以太坊不算登记在 BSC；老数据的字符串算 TRON', async () => {
  const to = evm();
  const { db, m1 } = await setup({ cashout: [{ chain: 'eth', address: to }, TRON_A] });
  assert.equal((await core.requestWithdrawal(db, m1, { kind: 'cashout', chain: 'eth', to, amount: 5 * U, source: 'web' })).chain, 'eth');
  await assert.rejects(core.requestWithdrawal(db, m1, { kind: 'cashout', chain: 'bsc', to, amount: 5 * U, source: 'web' }), (e) => e.code === 'address_not_registered');
  assert.equal((await core.requestWithdrawal(db, m1, { kind: 'cashout', chain: 'tron', to: TRON_A, amount: 5 * U, source: 'web' })).chain, 'tron');
  await assert.rejects(core.requestWithdrawal(db, m1, { kind: 'cashout', chain: 'tron', to: TRON_B, amount: 5 * U, source: 'web' }), (e) => e.code === 'address_not_registered');
  // 代付没有白名单（技术方案 05 页：照搬旧系统，靠审核）
  assert.equal((await req(db, m1, { chain: 'bsc', to: evm(), amount: 5 * U })).status, 'pending');
});

test('Q-B3 单笔一单一审：通过后对外 approved；超单笔上限的不通过（只能驳回或先改上限）；超每天上限的不通过；审计', async () => {
  const p = await load();
  const { db, m1 } = await setup();
  const w = await req(db, m1, { chain: 'eth', to: evm(), amount: 100 * U });
  const big = await req(db, m1, { chain: 'eth', to: evm(), amount: 5000 * U + 1 });
  const r = await p.approvePayouts(db, { ids: [w.withdrawal_no, big.withdrawal_no], actor: 'admin' });
  assert.deepEqual(r.approved, [w.withdrawal_no]);
  assert.deepEqual(r.refused, [{ id: big.withdrawal_no, reason: 'exceeds_per_item_limit' }]);
  assert.equal((await core.withdrawalView(db, w.withdrawal_no)).status, 'approved');
  assert.equal((await st(db, big.withdrawal_no)).status, 'pending', '没通过的留在待审核');
  assert.ok((await db.query(`select 1 from pay_audit where action = 'payout.approve' and target = $1`, [w.withdrawal_no])).length, '审计');
  // 每天 30,000（东八区一天）：已通过 100，再通过 5 笔 5,000 = 25,100；第 6 笔 5,000 超了
  const five = [];
  for (let i = 0; i < 6; i++) five.push((await req(db, m1, { chain: 'bsc', to: evm(), amount: 5000 * U })).withdrawal_no);
  const r2 = await p.approvePayouts(db, { ids: five, actor: 'admin' });
  assert.equal(r2.approved.length, 5);
  assert.deepEqual(r2.refused.map((x) => x.reason), ['exceeds_daily_limit']);
});

test('Q-B4 商户批量：逐行勾选一次审完——勾的通过、其余驳回（原因必填），驳回的逐笔退冻结、逐笔回调，批次"部分被驳回"', async () => {
  const p = await load();
  const { db, m1 } = await setup();
  const rows = [1, 2, 3, 4].map((i) => ({ chain: 'bsc', to: evm(), amount: `${i * 10}` }));
  const b = await p.submitPayoutBatch(db, m1, { rows, source: 'web', now: Date.parse('2026-11-14T03:00:00Z') });
  assert.equal(b.accepted.length, 4);
  // 冻结 = 金额 + 每笔 1 USDT 手续费：100 + 4
  assert.deepEqual(await bal(db), [100_000 - 104, 104]);
  const [w1, w2, w3, w4] = b.accepted.map((x) => x.withdrawal_no);
  await assert.rejects(p.reviewPayoutBatch(db, { batchNo: b.batch_no, approve: [w1, w3], reason: '', actor: 'admin' }), (e) => e.code === 'reason_required');
  const v = await p.reviewPayoutBatch(db, { batchNo: b.batch_no, approve: [w1, w3], reason: '收款地址存疑', actor: 'admin' });
  assert.equal(v.status, 'partially_rejected');
  assert.deepEqual([await st(db, w1), await st(db, w2), await st(db, w3), await st(db, w4)].map((x) => x.status), ['approved', 'rejected', 'approved', 'rejected']);
  // 退回 w2（20 + 1）、w4（40 + 1）
  assert.deepEqual(await bal(db), [100_000 - 104 + 62, 104 - 62]);
  // 驳回的逐笔回调（建单时要不要逐笔回调 pending 不在这里定，只看最后一条和次数）
  for (const w of [w2, w4]) { const c = await cbs(db, w); assert.equal(c.at(-1), 'rejected', '驳回的逐笔回调'); assert.equal(c.filter((x) => x === 'rejected').length, 1); }
  for (const w of [w1, w3]) assert.ok(!(await cbs(db, w)).includes('rejected'));
  assert.equal((await core.withdrawalView(db, w2)).reason, '收款地址存疑');
  // 全通过 / 全驳回
  const b2 = await p.submitPayoutBatch(db, m1, { rows: rows.slice(0, 2), source: 'web' });
  assert.equal((await p.reviewPayoutBatch(db, { batchNo: b2.batch_no, approve: b2.accepted.map((x) => x.withdrawal_no), reason: '', actor: 'admin' })).status, 'approved', '全通过不用填原因');
  const b3 = await p.submitPayoutBatch(db, m1, { rows: rows.slice(0, 2), source: 'web' });
  assert.equal((await p.reviewPayoutBatch(db, { batchNo: b3.batch_no, approve: [], reason: '重复提交', actor: 'admin' })).status, 'rejected');
});

test('原型偏离第 6 条：商户可以取消还没审核的批量打款；已通过的不动；别的商户取消不了', async () => {
  const p = await load();
  const { db, m1 } = await setup();
  const b = await p.submitPayoutBatch(db, m1, { rows: [1, 2, 3].map(() => ({ chain: 'eth', to: evm(), amount: '10' })), source: 'web' });
  const [w1, w2, w3] = b.accepted.map((x) => x.withdrawal_no);
  await p.approvePayouts(db, { ids: [w1], actor: 'admin' });
  await assert.rejects(p.cancelPayoutBatch(db, 'm2', b.batch_no), (e) => e.code === 'not_found');
  const r = await p.cancelPayoutBatch(db, 'm1', b.batch_no);
  assert.deepEqual([r.cancelled, r.kept], [2, 1]);
  assert.deepEqual([(await st(db, w1)).status, (await st(db, w2)).status, (await st(db, w3)).status], ['approved', 'cancelled', 'cancelled']);
  assert.deepEqual(await bal(db), [100_000 - 11, 11], '只剩通过的那笔冻结着');
  assert.equal((await cbs(db, w2)).at(-1), 'cancelled', '取消的逐笔回调');
});

test('Q-B6 一次最多 500 笔；有问题的行默认整张不收，onlyValid 只收没问题的行（原型偏离第 4 条）', async () => {
  const p = await load();
  const { db, m1 } = await setup();
  const row = () => ({ chain: 'tron', to: TRON_A, amount: '1' });
  await assert.rejects(p.submitPayoutBatch(db, m1, { rows: Array.from({ length: 501 }, row), source: 'web' }), (e) => e.code === 'too_many_items');
  assert.deepEqual(await bal(db), [100_000, 0], '超了一笔都不冻结');
  const ok500 = await p.submitPayoutBatch(db, m1, { rows: Array.from({ length: 500 }, row), source: 'web' });
  assert.equal(ok500.accepted.length, 500);
  const mixed = [row(), { chain: 'eth', to: 'nope', amount: '1' }, { chain: 'bsc', to: evm(), amount: '1.0000001' }, row()];
  const before = await bal(db);
  await assert.rejects(p.submitPayoutBatch(db, m1, { rows: mixed, source: 'web' }), (e) => e.code === 'invalid_rows' && JSON.stringify(e.rows ?? e.detail ?? '').includes('2'));
  assert.deepEqual(await bal(db), before, '整张不收时不冻结');
  const part = await p.submitPayoutBatch(db, m1, { rows: mixed, source: 'web', onlyValid: true });
  assert.equal(part.accepted.length, 2);
  assert.deepEqual(part.rejected_rows.map((r) => r.line), [2, 3]);
});

test('Q-B5 网络费不另收：冻结 = 金额 + 付款手续费；按链汇总 { count, amount, fee, total }', async () => {
  const p = await load();
  const { db, m1 } = await setup();
  const b = await p.submitPayoutBatch(db, m1, { rows: [{ chain: 'eth', to: evm(), amount: '100' }, { chain: 'eth', to: evm(), amount: '50.5' }, { chain: 'tron', to: TRON_A, amount: '20' }], source: 'web' });
  const t = Object.fromEntries(Object.entries(b.totals).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([a, x]) => [a, String(x)]))]));
  assert.deepEqual(t.eth, { count: '2', amount: '150.50', fee: '2.00', total: '152.50' });
  assert.deepEqual(t.tron, { count: '1', amount: '20.00', fee: '1.00', total: '21.00' });
  assert.deepEqual(await bal(db), [100_000 - 173.5, 173.5]);
});

test('Q-B7 东八区 23:00 以后提交：照样发邮件给管理员，返回第二天 8:00 后处理', async () => {
  const p = await load();
  const { db, m1 } = await setup();
  const mails = [];
  const notify = async (m) => { mails.push(m); };
  const late = await p.submitPayoutBatch(db, m1, { rows: [{ chain: 'bsc', to: evm(), amount: '5' }], source: 'web', now: Date.parse('2026-11-14T15:30:00Z'), notify });
  assert.equal(late.service.open, false);
  assert.equal(late.service.next_open_at, '2026-11-15T00:00:00.000Z');
  assert.equal(mails.length, 1, '23:00 以后照发邮件');
  const day = await p.submitPayoutBatch(db, m1, { rows: [{ chain: 'bsc', to: evm(), amount: '5' }], source: 'web', now: Date.parse('2026-11-14T03:00:00Z'), notify });
  assert.equal(day.service.open, true);
  assert.equal(mails.length, 2);
});

test('Q15 以太坊 / BSC 一批一笔交易：成功逐笔扣冻结、逐笔回调；失败整批回到已审核，冻结和账本都不动', async () => {
  const p = await load();
  const { db, m1 } = await setup();
  const ids = [];
  for (const a of [10, 20, 30]) ids.push((await req(db, m1, { chain: 'eth', to: evm(), amount: a * U })).withdrawal_no);
  await p.approvePayouts(db, { ids, actor: 'admin' });
  const bad = await p.createPayoutTxBatch(db, { chain: 'eth', ids });
  assert.deepEqual((await Promise.all(ids.map((i) => st(db, i)))).map((x) => [x.status, x.batch_id]), ids.map(() => ['signing', bad]));
  const n0 = await ledgerN(db), b0 = await bal(db);
  await p.settlePayoutBatch(db, bad, { success: false, txid: '0x' + 'ab'.repeat(32) });
  assert.deepEqual((await Promise.all(ids.map((i) => st(db, i)))).map((x) => [x.status, x.batch_id]), ids.map(() => ['approved', null]), '整批回滚到已审核、可以重新凑批');
  assert.equal(await ledgerN(db), n0, '账本不动');
  assert.deepEqual(await bal(db), b0, '冻结不动');
  assert.deepEqual(await Promise.all(ids.map(async (i) => (await core.withdrawalView(db, i)).status)), ['approved', 'approved', 'approved']);
  // 重新凑批、成功
  const ok = await p.createPayoutTxBatch(db, { chain: 'eth', ids });
  await p.settlePayoutBatch(db, ok, { success: true, txid: '0x' + 'cd'.repeat(32) });
  assert.deepEqual(await Promise.all(ids.map(async (i) => (await core.withdrawalView(db, i)).status)), ['completed', 'completed', 'completed']);
  assert.deepEqual(await bal(db), [100_000 - 63, 0]);
  for (const i of ids) assert.equal((await cbs(db, i)).at(-1), 'completed', '逐笔回调');
  assert.equal((await core.withdrawalView(db, ids[0])).txid, '0x' + 'cd'.repeat(32));
  // 已结束的批次不能再结算一次
  await assert.rejects(p.settlePayoutBatch(db, ok, { success: false }), (e) => e.code === 'invalid_state');
});

test('Q-B2 TRON 逐笔记账：成功的照记，失败的回到已审核待签名（冻结不动）；不能混进以太坊的批次', async () => {
  const p = await load();
  const { db, m1 } = await setup();
  const ids = [];
  for (const a of [10, 20, 30]) ids.push((await req(db, m1, { chain: 'tron', to: TRON_A, amount: a * U })).withdrawal_no);
  const eth = (await req(db, m1, { chain: 'eth', to: evm(), amount: U })).withdrawal_no;
  await p.approvePayouts(db, { ids: [...ids, eth], actor: 'admin' });
  await assert.rejects(p.createPayoutTxBatch(db, { chain: 'tron', ids: [...ids, eth] }), (e) => e.code === 'invalid_param' || e.code === 'chain_mismatch');
  await p.createPayoutTxBatch(db, { chain: 'tron', ids });
  await p.settlePayoutItem(db, ids[0], { success: true, txid: 'aa'.repeat(32) });
  await p.settlePayoutItem(db, ids[1], { success: false, txid: 'bb'.repeat(32) });
  await p.settlePayoutItem(db, ids[2], { success: true, txid: 'cc'.repeat(32) });
  assert.deepEqual(await Promise.all(ids.map(async (i) => (await st(db, i)).status)), ['completed', 'approved', 'completed']);
  // 冻结：10+1、30+1 扣掉；20+1 还冻着；eth 那笔 1+1 也还冻着
  assert.deepEqual(await bal(db), [100_000 - 63 - 2, 21 + 2]);
  assert.equal((await st(db, ids[1])).batch_id, null, '失败的那笔可以重新凑批');
});
