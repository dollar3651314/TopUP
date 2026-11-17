// E06、E07：改单笔上限、每天上限（测试管理员免动态码；每次都是读出原值、临时改、原样写回，并核对写回后和原来一样）。
//   不建单也能测的：改了能读到新值、写回原值；单笔 > 每批、每批 > 每天、0、没写原因都拒绝（拒绝时什么都不改）
//   要建单的（测试商户的开放 API）：超单笔上限的单审核不通过、留在待审核；超每天上限的单审核不通过；收尾全部驳回
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { admin, ok, expectError } from './lib.mjs';
import { newPayout, overview, cleanup, readLimits, saveLimits, withLimits, usdt, units, UNIT } from './flow.mjs';

after(cleanup);

/** 上限没变（拒绝的修改不能改动任何一项） */
async function unchanged(before, what) {
  const now = await readLimits();
  assert.ok(Object.keys(before).every((k) => units(now[k]) === units(before[k])), `${what}：上限一项都没变`);
}

test('E06 改单笔上限：改成"原值 − 0.000001"能读到新值，再原样写回', async () => {
  const before = await readLimits();
  assert.ok(['perItem', 'perBatch', 'perDay', 'hotMax', 'hotLow'].every((k) => units(before[k]) > 0), '五项上限都是 USDT 字符串、大于 0');
  const next = units(before.perItem) - UNIT;
  assert.ok(next > 0, '单笔上限大于最小金额，能往下改');
  await withLimits({ perItem: usdt(next) }, 'E06 改单笔上限', async () => {});
});

test('E06 单笔上限不合规的修改都拒绝（422），什么都不改', async () => {
  const before = await readLimits();
  const r1 = await saveLimits({ perItem: usdt(units(before.perBatch) + UNIT) }, 'E06 单笔上限大于每批上限（应当被拒绝）');
  expectError(r1, 422, 'invalid_param', '单笔 > 每批');
  expectError(await saveLimits({ perItem: '0' }, 'E06 单笔上限为 0（应当被拒绝）'), 422, 'invalid_param', '单笔 = 0');
  expectError(await saveLimits({ perItem: 'abc' }, 'E06 单笔上限不是数字（应当被拒绝）'), 422, 'invalid_param', '单笔不是数字');
  expectError(await admin('payout-limits-save', { body: { values: { perItem: before.perItem }, reason: '  ', code: '000000' } }), 422, 'reason_required', '没写原因');
  await unchanged(before, '拒绝的修改');
});

test('E06 超单笔上限：单笔上限临时改成 0.000001，0.000002 的单审核不通过（exceeds_per_item_limit）、留在待审核', async (t) => {
  const id = await newPayout(t, 'e06', 2 * UNIT);
  if (!id) return;
  await withLimits({ perItem: usdt(UNIT) }, 'E06 超单笔上限', async () => {
    const r = ok(await admin('payout-approve', { body: { ids: [id] } }), 'payout-approve');
    assert.ok(!r.approved?.includes(id), '没有通过');
    assert.ok(r.refused?.find((x) => x.id === id)?.reason === 'exceeds_per_item_limit', '原因是超单笔上限');
    assert.ok((await overview()).singles?.some((x) => x.id === id), '还在待审核里');
  });
});

test('E07 改每天上限：改成"原值 + 0.000001"能读到新值，再原样写回；每批 > 每天拒绝', async () => {
  const before = await readLimits();
  await withLimits({ perDay: usdt(units(before.perDay) + UNIT) }, 'E07 改每天上限', async () => {});
  expectError(await saveLimits({ perDay: usdt(units(before.perBatch) - UNIT) }, 'E07 每天上限小于每批上限（应当被拒绝）'), 422, 'invalid_param', '每批 > 每天');
  await unchanged(before, '拒绝的修改');
});

test('E07 超每天上限：每天上限临时改成"今天已通过 + 0.000001"，第一笔通过、第二笔不通过（exceeds_daily_limit；测试商户今天的已通过和全平台一样多时先碰到商户每天上限 exceeds_merchant_daily_limit）', async (t) => {
  const a = await newPayout(t, 'e07-a');
  if (!a) return;
  const b = await newPayout(t, 'e07-b');
  if (!b) return;
  const o = await overview();
  const today = units(o.today_approved);
  assert.ok(Number.isFinite(today), '审核页给了今天已通过的合计（USDT 字符串）');
  // v1.1：每个商户每天上限不能大于全平台每天，一起设；测试商户今天已通过（merchants_today）决定第二笔先碰到哪道上限
  const mid = o.singles?.find((x) => x.id === b)?.merchant_id;
  const mToday = units(o.merchants_today?.find((m) => m.merchant_id === mid)?.approved ?? '0');
  const want = mToday + 2 * UNIT > today + UNIT ? 'exceeds_merchant_daily_limit' : 'exceeds_daily_limit';
  // 单笔 ≤ 每批 ≤ 每天、商户每天 ≤ 全平台每天：四项都设成同一个数
  const cap = usdt(today + UNIT);
  await withLimits({ perItem: cap, perBatch: cap, perDay: cap, perMerchantDay: cap }, 'E07 超每天上限', async () => {
    const r1 = ok(await admin('payout-approve', { body: { ids: [a] } }), 'payout-approve 第一笔');
    assert.ok(r1.approved?.includes(a), '第一笔通过（刚好到每天上限；这期间没有别人审核通过别的单）');
    const r2 = ok(await admin('payout-approve', { body: { ids: [b] } }), 'payout-approve 第二笔');
    assert.ok(r2.refused?.find((x) => x.id === b)?.reason === want, `第二笔超每天上限、不通过（${want}）`);
    const o2 = await overview();
    assert.ok(o2.singles?.some((x) => x.id === b), '第二笔还在待审核里');
  });
});
