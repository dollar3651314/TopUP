// 测试先写（v1.1）：每天打款上限按商户算 + 保留全平台每天总上限，两者取小。
// 依据：v1.1 开放 API 补接口需求的"每天打款上限按商户算"一节（已定：每家各一个"每个商户每天上限"默认 30,000，另保留全平台每天总上限默认 30,000，
//   一笔要同时不超过这家商户今天的余量和全平台今天的余量）；原型已通过（总上限改到低于今天已通过的合计：允许保存、只提醒）。
//
// 给研发的接口约定（需求没写死的地方由测试定，照着做）：
//   - 上限多一项 perMerchantDay（server/pay/payout.js 的 LIMIT_KEYS、PAYOUT_DEFAULTS，默认 30,000 USDT，对所有商户一起生效）；perDay 仍是全平台每天总上限。
//   - 审核（approvePayouts、reviewPayoutBatch）：这家商户东八区今天已通过 + 这笔 > perMerchantDay → 留在待审核，原因 'exceeds_merchant_daily_limit'；
//     全平台今天已通过 + 这笔 > perDay → 原因 'exceeds_daily_limit'（沿用原来的码，指全平台）。"今天已通过"的口径不变
//     （approved_at ≥ 东八区今天 0 点，状态 approved / signing / broadcast / completed）。保留现有审核锁。
//   - 改上限（payout-limits-save）：perMerchantDay > perDay → 422 invalid_param，field 'perMerchantDay'，rows[0].rule = 'per_merchant_day_le_per_day'；
//     perBatch ≤ perDay 照旧按全平台；新的 perDay 低于全平台今天已通过 → 照样保存，返回里 warnings 含 'per_day_below_today_approved'（没有时 warnings 为空数组或不给）。
//     审计 payout.limits 的 before / after 带 perMerchantDay。
//   - 打款审核页（payout-overview）：today_approved（全平台）、per_day 照旧，加 per_merchant_day（USDT 字符串）、
//     merchants_today: [{ merchant_id, merchant, approved }]（今天有已通过或有待审核的商户，approved 是这家今天已通过，USDT 字符串）；
//     待审核的每一笔（singles[]、groups[].items[]）加 limit_check：'ok' | 'exceeds_per_item_limit' | 'exceeds_merchant_daily_limit' | 'exceeds_daily_limit'
//     （按"现在单独审这一笔"算）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, U, TO, DAY, HOUR, wire } from './qa-v11-helpers.js';
import * as core from '../server/pay/core.js';
import * as payout from '../server/pay/payout.js';
import { payoutAdminActions } from '../server/pay/payout-admin.js';

async function setup({ limits } = {}) {
  const w = await world({ fund: 100_000 });
  let clock = Date.now();
  const acts = payoutAdminActions({ db: w.db, tron: null, verifyAdminCode: async () => true, now: () => clock });
  const save = async (values, reason = '测试') => acts['payout-limits-save']({ values, reason, code: '123456' }, 'admin');
  if (limits) await save(limits);
  const req = async (mid, amount) => (await core.requestWithdrawal(w.db, await core.getMerchant(w.db, mid), { kind: 'payout', chain: 'tron', to: TO, amount: amount * U, source: 'api' })).withdrawal_no;
  const approve = (ids, at = clock) => payout.approvePayouts(w.db, { ids: [].concat(ids), actor: 'admin', now: at });
  const status = async (id) => (await w.db.query('select status from withdrawals where id = $1', [id]))[0].status;
  return { ...w, acts, save, req, approve, status, clock: () => clock, setClock: (v) => (clock = v) };
}
/** 验收用例 ① 的上限：商户每天 1,000、全平台每天 1,500（每批不能大于每天，一起改小） */
const CASE1 = { perItem: '1000', perBatch: '1500', perDay: '1500', perMerchantDay: '1000' };

test('TG-3 默认值：每个商户每天上限 30,000，全平台每天仍 30,000；接口返回带 perMerchantDay', async () => {
  const t = await setup();
  const l = await payout.getPayoutLimits(t.db);
  assert.equal(payout.PAYOUT_DEFAULTS.perMerchantDay, 30_000 * U);
  assert.equal(l.perMerchantDay, 30_000 * U);
  assert.equal(l.perDay, 30_000 * U);
  assert.ok(payout.LIMIT_KEYS.includes('perMerchantDay'));
  const out = wire(await t.acts['payout-limits']());
  assert.equal(out.perMerchantDay, '30000.00');
  await t.db.end();
});

test('TG-3 ① 商户 1,000 / 全平台 1,500：A 过 900 后 A 的 200 留待审核（超商户每天），B 的 500 能过，B 再来 200 被留（超全平台每天）', async () => {
  const t = await setup({ limits: CASE1 });
  const a900 = await t.req('ma', 900), a200 = await t.req('ma', 200), b500 = await t.req('mb', 500), b200 = await t.req('mb', 200);
  assert.deepEqual((await t.approve(a900)).approved, [a900]);
  const r1 = await t.approve(a200);
  assert.deepEqual(r1.refused, [{ id: a200, reason: 'exceeds_merchant_daily_limit' }], JSON.stringify(r1));
  assert.equal(await t.status(a200), 'pending', '超限的留在待审核，不自动驳回');
  assert.deepEqual((await t.approve(b500)).approved, [b500], 'B 自己的额度还够、全平台 900 + 500 ≤ 1,500');
  const r2 = await t.approve(b200);
  assert.deepEqual(r2.refused, [{ id: b200, reason: 'exceeds_daily_limit' }], JSON.stringify(r2));
  assert.equal(await t.status(b200), 'pending');
  await t.db.end();
});

test('TG-3 ① 一次审几笔也按两道上限逐笔算；商户批量逐行勾选（payout-review）超商户每天整个审核不生效', async () => {
  const t = await setup({ limits: CASE1 });
  const ids = [await t.req('ma', 600), await t.req('ma', 300), await t.req('ma', 200)];
  const r = await t.approve(ids);
  assert.deepEqual(r.approved, ids.slice(0, 2));
  assert.deepEqual(r.refused, [{ id: ids[2], reason: 'exceeds_merchant_daily_limit' }]);
  // 商户 B 的批量：两行 600 + 500 > 1,000（商户每天）
  const m = await core.getMerchant(t.db, 'mb');
  const s = await payout.submitPayoutBatch(t.db, m, { rows: [{ chain: 'tron', to: TO, amount: '600' }, { chain: 'tron', to: TO, amount: '500' }], source: 'api' });
  const all = s.accepted.map((x) => x.withdrawal_no);
  await assert.rejects(() => payout.reviewPayoutBatch(t.db, { batchNo: s.batch_no, approve: all, actor: 'admin', now: t.clock() }),
    (e) => e.status === 409 && e.code === 'exceeds_merchant_daily_limit', '批量里有一笔超商户每天：409 exceeds_merchant_daily_limit');
  for (const id of all) assert.equal(await t.status(id), 'pending');
  await t.db.end();
});

test('TG-3 ② 东八区 0 点后两个额度都重置', async () => {
  const t = await setup({ limits: CASE1 });
  const tomorrow0 = payout.dayStart(Date.now()) + DAY;
  const late = tomorrow0 - 30_000; // 东八区今天 23:59:30
  t.setClock(late);
  const a = await t.req('ma', 1000), b = await t.req('mb', 500);
  assert.equal((await t.approve([a, b], late)).approved.length, 2, '今天：A 用满商户额度、全平台用满 1,500');
  const a2 = await t.req('ma', 100), b2 = await t.req('mb', 100);
  assert.deepEqual((await t.approve(a2, late)).refused, [{ id: a2, reason: 'exceeds_merchant_daily_limit' }]);
  assert.equal((await t.approve(b2, late)).refused[0].reason, 'exceeds_daily_limit');
  const next = tomorrow0 + 30_000; // 东八区明天 00:00:30
  t.setClock(next);
  const r = await t.approve([a2, b2], next);
  assert.deepEqual(r.approved, [a2, b2], `0 点后重置：${JSON.stringify(r)}`);
  const ov = wire(await t.acts['payout-overview']());
  assert.equal(ov.today_approved, '200.00', '全平台今天已通过从 0 算');
  const mt = Object.fromEntries(ov.merchants_today.map((x) => [x.merchant_id, x.approved]));
  assert.equal(mt.ma, '100.00');
  assert.equal(mt.mb, '100.00');
  await t.db.end();
});

test('TG-3 ③ 两个审核同时提交：合计不超商户每天、不超全平台每天（保留审核锁）', async () => {
  const t = await setup({ limits: CASE1 });
  const a1 = await t.req('ma', 600), a2 = await t.req('ma', 600);
  const rs = await Promise.all([t.approve(a1), t.approve(a2)]);
  assert.equal(rs.flatMap((r) => r.approved).length, 1, `同一商户 600 + 600 > 1,000，只能过一笔：${JSON.stringify(rs)}`);
  assert.equal(rs.flatMap((r) => r.refused)[0].reason, 'exceeds_merchant_daily_limit');
  const b1 = await t.req('mb', 800), c = await t.req('mb', 300);
  // 全平台：已过 600；B 800 和 A 再来的都同时到
  const a3 = await t.req('ma', 300);
  const rs2 = await Promise.all([t.approve(b1), t.approve(a3), t.approve(c)]);
  const [{ v }] = await t.db.query(`select coalesce(sum(amount), 0)::bigint v from withdrawals where status = 'approved'`);
  assert.ok(Number(v) <= 1500 * U, `全平台合计 ${Number(v) / U} 超了 1,500：${JSON.stringify(rs2)}`);
  for (const mid of ['ma', 'mb']) {
    const [{ v: mv }] = await t.db.query(`select coalesce(sum(amount), 0)::bigint v from withdrawals where status = 'approved' and merchant_id = $1`, [mid]);
    assert.ok(Number(mv) <= 1000 * U, `${mid} 合计 ${Number(mv) / U} 超了商户每天 1,000`);
  }
  await t.db.end();
});

test('TG-3 ④ 改上限：每个商户每天 > 全平台每天被挡（rule per_merchant_day_le_per_day）；每批 ≤ 每天照旧按全平台；保存记审计', async () => {
  const t = await setup();
  await assert.rejects(() => t.save({ perMerchantDay: '40000' }), (e) => e.status === 422 && e.field === 'perMerchantDay' && e.rows?.[0]?.rule === 'per_merchant_day_le_per_day');
  await assert.rejects(() => t.save({ perDay: '20000', perMerchantDay: '25000' }), (e) => e.rows?.[0]?.rule === 'per_merchant_day_le_per_day');
  // 每批 20,000 > 全平台每天 15,000：照旧挡（按全平台）；商户每天小于每批不挡
  await assert.rejects(() => t.save({ perDay: '15000', perMerchantDay: '10000' }), (e) => e.rows?.[0]?.rule === 'per_batch_le_per_day');
  const ok = wire(await t.save({ perMerchantDay: '10000' }, '给每家商户收紧'));
  assert.equal(ok.perMerchantDay, '10000.00');
  assert.equal((await payout.getPayoutLimits(t.db)).perMerchantDay, 10_000 * U, '保存后立刻生效');
  const [au] = await t.db.query(`select detail from pay_audit where action = 'payout.limits' order by id desc limit 1`);
  assert.equal(au.detail.before.perMerchantDay, '30000.00');
  assert.equal(au.detail.after.perMerchantDay, '10000.00');
  // 改不了的时候数字不变
  assert.equal((await payout.getPayoutLimits(t.db)).perDay, 30_000 * U);
  await t.db.end();
});

test('TG-3 ④ 全平台每天总上限改到低于今天已通过：允许保存、返回提醒；今天剩下的单都留在待审核', async () => {
  const t = await setup();
  const a = await t.req('ma', 3000), b = await t.req('mb', 3000);
  assert.equal((await t.approve([a, b])).approved.length, 2); // 今天已通过 6,000
  const r = wire(await t.save({ perItem: '2000', perBatch: '5000', perDay: '5000', perMerchantDay: '5000' }, '临时收紧'));
  assert.equal(r.perDay, '5000.00', '低于今天已通过也能保存');
  assert.ok(Array.isArray(r.warnings) && r.warnings.includes('per_day_below_today_approved'), `要返回提醒：${JSON.stringify(r)}`);
  const c = await t.req('mb', 10);
  assert.deepEqual((await t.approve(c)).refused, [{ id: c, reason: 'exceeds_daily_limit' }]);
  // 没低于今天已通过时不提醒
  const r2 = wire(await t.save({ perDay: '30000' }, '恢复'));
  assert.ok(!r2.warnings || !r2.warnings.includes('per_day_below_today_approved'));
  await t.db.end();
});

test('TG-3 ⑤ 打款审核页：显示全平台今天已通过和每家商户今天已通过；待审核每笔给出上限检查结果', async () => {
  const t = await setup({ limits: CASE1 });
  const a900 = await t.req('ma', 900), b500 = await t.req('mb', 500);
  await t.approve([a900, b500]);
  const a200 = await t.req('ma', 200), b200 = await t.req('mb', 200), b50 = await t.req('mb', 50);
  const ov = wire(await t.acts['payout-overview']());
  assert.equal(ov.today_approved, '1400.00', '全平台');
  assert.equal(ov.per_day, '1500.00');
  assert.equal(ov.per_merchant_day, '1000.00');
  assert.ok(Array.isArray(ov.merchants_today), `要有 merchants_today：${Object.keys(ov)}`);
  const mt = Object.fromEntries(ov.merchants_today.map((x) => [x.merchant_id, x]));
  assert.equal(mt.ma.approved, '900.00');
  assert.equal(mt.mb.approved, '500.00');
  assert.equal(mt.ma.merchant, 'Name ma');
  const check = Object.fromEntries(ov.singles.map((x) => [x.id, x.limit_check]));
  assert.equal(check[a200], 'exceeds_merchant_daily_limit');
  assert.equal(check[b200], 'exceeds_daily_limit');
  assert.equal(check[b50], 'ok');
  await t.db.end();
});
