// E02～E04：打款审核。单笔审核通过后驳回、驳回待审核的单、商户批量逐行勾选一次审完。
// 要建单的步骤用测试商户的开放 API（没配 Key 或出网地址不在来源地址白名单时跳过，算未验证）；自己造的单最后全部驳回，冻结退回。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { admin, merchant, ok, expectError } from './lib.mjs';
import { newPayout, newPayoutBatch, statusOf, overview, reason, cleanup, noMerchantReason } from './flow.mjs';

after(cleanup);

test('E02 不建单也能测的：单号不存在的审核不通过（not_found），空列表 422', async () => {
  const r = ok(await admin('payout-approve', { body: { ids: ['WD-E2E-NOT-EXIST'] } }), 'payout-approve 不存在的单号');
  assert.ok(!r.approved?.length, '没有一笔被通过');
  assert.ok(r.refused?.[0]?.reason === 'not_found', '不通过的原因是 not_found');
  expectError(await admin('payout-approve', { body: { ids: [] } }), 422, 'invalid_param', 'payout-approve 空列表');
  expectError(await admin('payout-reject-approved', { body: { id: 'WD-E2E-NOT-EXIST', reason: reason('不存在的单') } }), 409, 'invalid_state', 'payout-reject-approved 不存在的单号');
});

test('E02 单笔打款：待审核 → 审核通过 → 已审核里能看到 → 驳回（原因必填），商户看到 rejected', async (t) => {
  const id = await newPayout(t, 'e02');
  if (!id) return;
  const o = await overview();
  const row = (o.singles || []).find((x) => x.id === id);
  assert.ok(row, '新单出现在打款审核页的单笔待审核里');
  assert.ok(!row.merchant || /^.\*\*\*$/u.test(row.merchant), '商户名已打码');

  const r = ok(await admin('payout-approve', { body: { ids: [id] } }), 'payout-approve');
  assert.ok(r.approved?.includes(id), '这一笔审核通过');
  assert.ok(await statusOf(id) === 'approved', '商户看到已审核');
  const again = ok(await admin('payout-approve', { body: { ids: [id] } }), 'payout-approve 再审一次');
  assert.ok(again.refused?.find((x) => x.id === id)?.reason === 'invalid_state', '已审核的单不能再审（invalid_state）');
  assert.ok((await overview()).approved?.some((x) => x.id === id), '已审核（还没凑批）的列表里有这一笔');

  expectError(await admin('payout-reject-approved', { body: { id, reason: '' } }), 422, 'reason_required', '驳回不写原因');
  const j = ok(await admin('payout-reject-approved', { body: { id, reason: reason('E02 审核后驳回') } }), 'payout-reject-approved');
  assert.ok(j?.status === 'rejected', '驳回后是 rejected');
  assert.ok(await statusOf(id) === 'rejected', '商户看到已驳回');
  expectError(await admin('payout-reject-approved', { body: { id, reason: reason('再驳回一次') } }), 409, 'invalid_state', '已驳回的不能再驳回');
});

test('E03 驳回待审核的单：原因必填；驳回后冻结退回、不能再审、不能再驳回', async (t) => {
  const why = noMerchantReason();
  if (why) { t.skip(why); return; }
  const b0 = ok(await merchant('GET', 'balance/'), '商户余额（建单前）');
  const id = await newPayout(t, 'e03');
  if (!id) return;
  const b1 = ok(await merchant('GET', 'balance/'), '商户余额（建单后）');
  assert.ok(b1.frozen !== b0.frozen, '建单后冻结变了');

  expectError(await admin('withdraw-reject', { body: { id } }), 422, 'invalid_param', 'withdraw-reject 不写原因');
  const j = ok(await admin('withdraw-reject', { body: { id, reason: reason('E03 驳回待审核') } }), 'withdraw-reject');
  assert.ok(j?.status === 'rejected', '驳回后是 rejected');
  assert.ok(await statusOf(id) === 'rejected', '商户看到已驳回');
  const b2 = ok(await merchant('GET', 'balance/'), '商户余额（驳回后）');
  assert.ok(b2.available === b0.available && b2.frozen === b0.frozen, '驳回后可用余额和冻结都回到建单前（这期间测试商户没有别的进出账）');

  expectError(await admin('withdraw-reject', { body: { id, reason: reason('再驳回一次') } }), 409, 'invalid_state', '已驳回的不能再驳回');
  const r = ok(await admin('payout-approve', { body: { ids: [id] } }), 'payout-approve 已驳回的单');
  assert.ok(r.refused?.find((x) => x.id === id)?.reason === 'invalid_state', '已驳回的单不能再审核');
  assert.ok(!(await overview()).singles?.some((x) => x.id === id), '待审核列表里没有它了');
});

test('E04 不建单也能测的：商户批量的批次号不存在 404', async () => {
  expectError(await admin('payout-review', { body: { batch_no: 'PB-E2E-NOT-EXIST', approve: [], reason: reason('不存在的批次') } }), 404, 'not_found', 'payout-review 不存在的批次');
});

test('E04 商户批量逐行审：勾一行通过、其余驳回（原因必填）；只能审一次；收尾驳回通过的那行', async (t) => {
  const b = await newPayoutBatch(t, 'e04', [1, 2]);
  if (!b) return;
  const [keep, drop] = b.ids;
  const g = ((await overview()).groups || []).find((x) => x.batch_no === b.batchNo);
  assert.ok(g && g.count === 2, '打款审核页的商户批量里有这一批，2 行');
  assert.ok(!g.merchant || /^.\*\*\*$/u.test(g.merchant), '商户名已打码');

  expectError(await admin('payout-review', { body: { batch_no: b.batchNo, approve: [keep] } }), 422, 'reason_required', '有驳回的行却不写原因');
  expectError(await admin('payout-review', { body: { batch_no: b.batchNo, approve: ['WD-E2E-NOT-IN-BATCH'], reason: reason('不在批次里') } }), 422, 'invalid_param', '勾了不在这一批里的单号');
  assert.ok(await statusOf(keep) === 'pending' && await statusOf(drop) === 'pending', '上面两次失败都没改动任何一行');

  const v = ok(await admin('payout-review', { body: { batch_no: b.batchNo, approve: [keep], reason: reason('E04 逐行审：驳回第 2 行') } }), 'payout-review');
  assert.ok(v?.status === 'partially_rejected', '批次是部分驳回');
  const st = Object.fromEntries((v.items || []).map((x) => [x.withdrawal_no, x.status]));
  assert.ok(st[keep] === 'approved' && st[drop] === 'rejected', '勾的那行通过、没勾的驳回');
  expectError(await admin('payout-review', { body: { batch_no: b.batchNo, approve: [], reason: reason('再审一次') } }), 409, 'invalid_state', '审完的批次不能再审');

  ok(await admin('payout-reject-approved', { body: { id: keep, reason: reason('E04 收尾') } }), '驳回通过的那行');
  const m = ok(await merchant('GET', `payouts/batch/?batch_no=${encodeURIComponent(b.batchNo)}`), '商户查批次');
  assert.ok(m?.status === 'rejected', '收尾后商户看到整批已驳回');
});
