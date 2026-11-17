// 测试先写（第 3 批）：批量打款的规则——凑批"三者取最小"和自动拆批、上限可改（原因 + 动态码 + 审计）、一次最多 500 笔、处理时段提示。
// 依据：已定 Q-B1（每批取"每批上限 20,000、热钱包余额、授权额度"三者最小，超了自动拆批；这些上限 管理员能在后台改，要原因 + 动态码 + 审计）、
//   Q-B6（一张表 / 一次 API 最多 500 笔）、TRON 每批 20 笔（原型待决第 C 组）、TU-6（时效东八区 8:00–23:00）、Q-B7（23:00 后商户页写第二天 8:00 后处理）、
//   技术方案 06 页第 2 节（单笔 5,000 / 每批 20,000 / 每天 30,000；热钱包上限 10,000、低于 2,000 提醒）、05 页（ETH / BSC 每笔交易最多 100 笔）、
//   原型偏离第 8 条（单笔超上限只能驳回或先改上限，不自动拆）。
//
// 期望的新模块 server/pay/payout.js（金额一律是 0.000001 USDT 为单位的整数；返回的 bigint / number 都行，用例按 String() 比较）：
//   PAYOUT_DEFAULTS = { perItem, perBatch, perDay, hotMax, hotLow }（默认 5,000 / 20,000 / 30,000 / 10,000 / 2,000 USDT）
//   MAX_ITEMS_PER_REQUEST = 500；MAX_ITEMS_PER_TX = { eth: 100, bsc: 100, tron: 20 }
//   getPayoutLimits(db) / updatePayoutLimits(db, { actor, reason, values, code, verifyCode })：同 sweep.js 的 updateSweepSettings——
//     动态码不对 bad_code、原因空 reason_required、数字不对 invalid_param（带 field），审计动作 payout.limits，detail 里有 reason、before、after（USDT 字符串）
//   effectiveBatchCap({ perBatch, hotBalance, allowance }) → { cap, by }：by 是 'per_batch' | 'hot_balance' | 'allowance'；allowance 为 null（TRON 不用授权）时只比前两个
//   planPayoutBatches(items, { chain, perBatch, hotBalance, allowance, perItem }) → { cap, by, batches: [{ items, total }], held: [{ id, reason }] }
//     items 按审核通过的先后排好（[{ id, amount }]）；按顺序装批，一批的合计不超过 cap、笔数不超过 MAX_ITEMS_PER_TX[chain]，装不下就开下一批（自动拆批）；
//     这一轮的总额不超过热钱包余额和授权额度（钱不够的留到下一轮，不是每批都能用满余额）；
//     单笔大于 cap 的不拆，放进 held，reason 是 exceeds_batch_cap / exceeds_hot_balance / exceeds_allowance（看是哪个数挡住）；
//     单笔大于单笔上限的放进 held，reason exceeds_per_item_limit（原型偏离第 8 条：不拆，只能驳回或先改上限）
//   serviceWindow(nowMs) → { open, next_open_at }：东八区 8:00（含）～23:00（不含）open = true；不在时段内 next_open_at 是下一个东八区 8:00（ISO）
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDb } from './wallet-helpers.js';

const U = 1_000_000;
const MOD = new URL('../server/pay/payout.js', import.meta.url).href;
const load = () => import(MOD);
const S = (x) => String(x);
const items = (...usdt) => usdt.map((a, i) => ({ id: `WD-${i + 1}`, amount: a * U }));
const ids = (b) => b.items.map((i) => i.id);

test('默认上限：单笔 5,000、每批 20,000、每天 30,000、热钱包上限 10,000、低于 2,000 提醒；一次最多 500 笔；每笔交易 ETH / BSC 100 笔、TRON 20 笔', async () => {
  const p = await load();
  assert.deepEqual(Object.fromEntries(Object.entries(p.PAYOUT_DEFAULTS).map(([k, v]) => [k, S(v)])),
    { perItem: S(5000 * U), perBatch: S(20000 * U), perDay: S(30000 * U), hotMax: S(10000 * U), hotLow: S(2000 * U) });
  assert.equal(p.MAX_ITEMS_PER_REQUEST, 500);
  assert.deepEqual({ ...p.MAX_ITEMS_PER_TX }, { eth: 100, bsc: 100, tron: 20 });
});

test('Q-B1 三者取最小：每批上限、热钱包余额、授权额度，谁小用谁，并说出是哪个；TRON 没有授权额度只比前两个', async () => {
  const p = await load();
  const c = (perBatch, hotBalance, allowance) => { const r = p.effectiveBatchCap({ perBatch: perBatch * U, hotBalance: hotBalance * U, allowance: allowance === null ? null : allowance * U }); return [Number(r.cap) / U, r.by]; };
  assert.deepEqual(c(20000, 10000, 10000), [10000, 'hot_balance'], '默认情况：热钱包 10,000 < 每批 20,000（一样大时先报热钱包余额）');
  assert.deepEqual(c(20000, 9000, 10000), [9000, 'hot_balance']);
  assert.deepEqual(c(20000, 15000, 6000), [6000, 'allowance']);
  assert.deepEqual(c(5000, 15000, 12000), [5000, 'per_batch']);
  assert.deepEqual(c(20000, 7000, null), [7000, 'hot_balance'], 'TRON');
  assert.deepEqual(c(3000, 7000, null), [3000, 'per_batch'], 'TRON');
  assert.deepEqual(c(20000, 0, 10000), [0, 'hot_balance'], '热钱包空了');
});

test('自动拆批：按审核顺序装，一批合计不超过上限；总额不超过热钱包余额，装不下的留到下一轮', async () => {
  const p = await load();
  // 每批 5,000（改小了），热钱包 12,000，额度足够：4,000 + 1,000 | 3,000 + 2,000 | 1,500（合计 11,500）；1,000 留下一轮（钱不够）
  const r = p.planPayoutBatches(items(4000, 1000, 3000, 2000, 1500, 1000), { chain: 'eth', perBatch: 5000 * U, hotBalance: 12000 * U, allowance: 50000 * U, perItem: 5000 * U });
  assert.equal(r.by, 'per_batch');
  assert.deepEqual(r.batches.map(ids), [['WD-1', 'WD-2'], ['WD-3', 'WD-4'], ['WD-5']]);
  assert.deepEqual(r.batches.map((b) => Number(b.total) / U), [5000, 5000, 1500]);
  assert.ok(r.batches.every((b) => BigInt(b.total) <= 5000n * BigInt(U)));
  assert.deepEqual(r.held.map((h) => [h.id, h.reason]), [['WD-6', 'exceeds_hot_balance']]);
  // 空的
  const e = p.planPayoutBatches([], { chain: 'bsc', perBatch: 20000 * U, hotBalance: 10000 * U, allowance: 10000 * U, perItem: 5000 * U });
  assert.deepEqual([e.batches.length, e.held.length], [0, 0]);
});

test('只有 1 笔、正好等于上限、比上限多 0.000001：边界', async () => {
  const p = await load();
  const opt = { chain: 'eth', perBatch: 20000 * U, hotBalance: 10000 * U, allowance: 10000 * U, perItem: 20000 * U };
  assert.deepEqual(p.planPayoutBatches(items(10000), opt).batches.map(ids), [['WD-1']], '正好等于三者最小');
  const over = p.planPayoutBatches([{ id: 'WD-X', amount: 10000 * U + 1 }], opt);
  assert.equal(over.batches.length, 0);
  assert.deepEqual(over.held.map((h) => h.reason), ['exceeds_hot_balance']);
  const al = p.planPayoutBatches([{ id: 'WD-Y', amount: 6000 * U }], { ...opt, hotBalance: 15000 * U, allowance: 5000 * U });
  assert.deepEqual(al.held.map((h) => h.reason), ['exceeds_allowance'], '额度挡住：提示去改授权额度');
});

test('原型偏离第 8 条：单笔超单笔上限的不拆、不进批，只能驳回或先改上限', async () => {
  const p = await load();
  const r = p.planPayoutBatches(items(5001, 100), { chain: 'bsc', perBatch: 20000 * U, hotBalance: 10000 * U, allowance: 10000 * U, perItem: 5000 * U });
  assert.deepEqual(r.batches.map(ids), [['WD-2']]);
  assert.deepEqual(r.held.map((h) => [h.id, h.reason]), [['WD-1', 'exceeds_per_item_limit']]);
});

test('每笔交易的笔数上限：ETH 一批最多 100 笔、TRON 最多 20 笔，多了自动拆', async () => {
  const p = await load();
  const many = (n) => Array.from({ length: n }, (_, i) => ({ id: `WD-${i + 1}`, amount: 1 * U }));
  const e = p.planPayoutBatches(many(250), { chain: 'eth', perBatch: 20000 * U, hotBalance: 10000 * U, allowance: 10000 * U, perItem: 5000 * U });
  assert.deepEqual(e.batches.map((b) => b.items.length), [100, 100, 50]);
  const t = p.planPayoutBatches(many(45), { chain: 'tron', perBatch: 20000 * U, hotBalance: 10000 * U, allowance: null, perItem: 5000 * U });
  assert.deepEqual(t.batches.map((b) => b.items.length), [20, 20, 5]);
});

test('上限 管理员能在后台改：动态码、原因必填，审计记修改前后；没成功的不生效', async () => {
  const p = await load();
  const db = await setupDb();
  const before = await p.getPayoutLimits(db);
  assert.equal(S(before.perBatch), S(20000 * U), '没改过时是默认值');
  const values = { perItem: S(3000 * U), perBatch: S(8000 * U), perDay: S(25000 * U), hotMax: S(10000 * U), hotLow: S(2000 * U) };
  const ok = async (c) => c === '123456';
  await assert.rejects(p.updatePayoutLimits(db, { actor: 'admin', reason: '先收紧', values, code: '000000', verifyCode: ok }), (e) => e.code === 'bad_code');
  await assert.rejects(p.updatePayoutLimits(db, { actor: 'admin', reason: '  ', values, code: '123456', verifyCode: ok }), (e) => e.code === 'reason_required');
  await assert.rejects(p.updatePayoutLimits(db, { actor: 'admin', reason: 'x', values: { ...values, perBatch: '-1' }, code: '123456', verifyCode: ok }), (e) => e.code === 'invalid_param' && e.field === 'perBatch');
  await assert.rejects(p.updatePayoutLimits(db, { actor: 'admin', reason: 'x', values: { ...values, perItem: S(9000 * U) }, code: '123456', verifyCode: ok }), (e) => e.code === 'invalid_param' && e.field === 'perItem', '单笔不能大于每批');
  assert.equal((await db.query(`select count(*)::int n from pay_audit where action = 'payout.limits'`))[0].n, 0, '没成功的不记审计、不生效');
  await p.updatePayoutLimits(db, { actor: 'admin', reason: '先收紧', values, code: '123456', verifyCode: ok });
  const now = await p.getPayoutLimits(db);
  assert.equal(S(now.perBatch), S(8000 * U));
  assert.equal(S(now.perItem), S(3000 * U));
  const [a] = await db.query(`select actor, detail from pay_audit where action = 'payout.limits'`);
  assert.equal(a.actor, 'admin');
  assert.equal(a.detail.reason, '先收紧');
  assert.equal(Number(a.detail.before.perBatch), 20000, '审计里是 USDT（不是 0.000001 单位）');
  assert.equal(Number(a.detail.after.perBatch), 8000);
});

test('TU-6 / Q-B7 处理时段：东八区 8:00～23:00；23:00 以后、8:00 以前不在时段内，给出下一个 8:00', async () => {
  const p = await load();
  const w = (iso) => p.serviceWindow(Date.parse(iso));
  assert.equal(w('2026-11-14T00:00:00Z').open, true, '东八区 8:00 整');
  assert.equal(w('2026-11-14T14:59:59Z').open, true, '东八区 22:59:59');
  const late = w('2026-11-14T15:00:00Z'); // 东八区 23:00
  assert.equal(late.open, false);
  assert.equal(late.next_open_at, '2026-11-15T00:00:00.000Z', '第二天 8:00');
  const early = w('2026-11-14T22:30:00Z'); // 东八区 11/15 6:30
  assert.equal(early.open, false);
  assert.equal(early.next_open_at, '2026-11-15T00:00:00.000Z', '当天 8:00');
  assert.equal(w('2026-11-14T03:00:00Z').next_open_at ?? null, null, '时段内不给 next_open_at');
});
