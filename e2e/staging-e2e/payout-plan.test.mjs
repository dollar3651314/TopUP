// E05、E08：按链凑批到"待签名"为止，然后作废（不签名、不广播，钱不动）。
//   E05：以太坊没开通打款时 payout-plan 返回明确的错误；开通后用 payout-plan 凑一批 → 待签名 → 作废 → 单回到已审核 → 驳回；
//        TRON 用 withdraw-plan 凑一批 → 待签名 → 作废 → 单回到已审核 → 驳回
//   E08：每批上限临时改成最小金额，两笔已审核的单自动拆成"这一批 1 笔、留到下一轮 1 笔"；作废、上限原样写回、驳回
// TRON 已有没签名的批次时（管理员可能正在签）不凑批：withdraw-plan 会把它作废。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { admin, ok, expectError } from './lib.mjs';
import { newPayout, overview, reason, cleanup, tronPlanBlocker, evmPlanBlocker, withLimits, usdt, units, UNIT, ETH_PAYEE } from './flow.mjs';

after(cleanup);

/** 审核通过（断言这几笔都通过了） */
async function approve(ids) {
  const r = ok(await admin('payout-approve', { body: { ids } }), 'payout-approve');
  assert.ok(ids.every((id) => r.approved?.includes(id)), `${ids.length} 笔都审核通过`);
}

/** 作废没签名的批次，核对它变成 expired、单回到已审核（还没凑批） */
async function voidAndCheck(pt, ids) {
  ok(await admin('payout-void', { body: { id: pt } }), 'payout-void');
  const x = ok(await admin('payout-tx-batch', { query: { id: pt } }), 'payout-tx-batch（作废后）');
  assert.ok(x.status === 'expired' && x.voidable === false, '作废后批次是 expired、不能再作废');
  expectError(await admin('payout-void', { body: { id: pt } }), 409, 'invalid_state', '作废过的批次再作废');
  expectError(await admin('payout-resume', { body: { id: pt } }), 409, 'invalid_state', '作废过的批次不能继续签名');
  const appr = (await overview()).approved || [];
  assert.ok(ids.every((id) => appr.some((a) => a.id === id)), '单回到已审核（还没凑批），下一轮可以重新凑');
}

test('E05 以太坊：没开通时 payout-plan 返回 409 chain_not_enabled；开通后 1 笔 → 凑批到待签名（一笔 BatchPayout 原文、nonce、期望值）→ 继续签名拿回同一批 → 作废 → 回到已审核 → 驳回；不是以太坊 / BSC 的链 422', async (t) => {
  const p = ok(await admin('payout-plans'), 'payout-plans');
  const eth = (p.cards || []).find((c) => c.chain === 'eth');
  assert.ok(eth, '凑批卡片里有以太坊');
  expectError(await admin('payout-plan', { body: { chain: 'tron' } }), 422, 'invalid_param', 'payout-plan 用 TRON（TRON 走 withdraw-plan）');
  if (!eth.enabled) {
    assert.ok(eth.blocked === 'not_enabled', '卡片写明没开通（not_enabled）');
    expectError(await admin('payout-plan', { body: { chain: 'eth' } }), 409, 'chain_not_enabled', 'payout-plan 以太坊');
    return;
  }
  // 开通了：凑批到"待签名"为止，不签名、不广播
  const block = await evmPlanBlocker('eth', UNIT);
  if (block) { t.skip(block); return; }
  const id = await newPayout(t, 'e05-eth', UNIT, 'eth');
  if (!id) return;
  await approve([id]);

  const r = ok(await admin('payout-plan', { body: { chain: 'eth' } }), 'payout-plan 以太坊');
  assert.ok(r.chain === 'eth' && Array.isArray(r.batches), '返回以太坊的批次列表');
  const mineBatches = r.batches.filter((b) => (b.items || []).some((i) => i.id === id));
  const pts = r.batches.map((b) => b.id);
  try {
    assert.ok(r.batches.length === 1 && mineBatches.length === 1, '只凑出 1 批，里面有这一笔');
    const b = mineBatches[0];
    assert.ok(typeof b.id === 'string' && b.id.startsWith('PT-ETH-'), '有打款批次号（PT-ETH-）');
    assert.ok(b.items.length === 1 && b.items[0].to === ETH_PAYEE && units(b.items[0].amount) === UNIT, '批次里就是这一笔：收款地址、金额都对');
    assert.ok(typeof b.rawHex === 'string' && /^(0x)?[0-9a-f]+$/i.test(b.rawHex) && b.rawHex.length > 20, '给了待签名的交易原文（十六进制）');
    assert.ok(/^\d+$/.test(String(b.nonce)) && /^\d+$/.test(String(b.fee_wei)), '给了热钱包 nonce 和预估网络费');
    assert.ok(b.expect?.chainId === '11155111', '期望值里的链 ID 是 Sepolia（11155111）');
    assert.ok(eth.contract && String(b.expect?.contract).toLowerCase() === String(eth.contract).toLowerCase(), '期望值里的合约是登记的 BatchPayout');
    assert.ok(b.expect?.items?.length === 1 && b.expect.items[0].to === ETH_PAYEE, '期望值逐笔列了收款地址');

    const x = ok(await admin('payout-tx-batch', { query: { id: b.id } }), 'payout-tx-batch');
    assert.ok(x.status === 'planned' && x.voidable === true && x.resumable === true && x.count === 1, '批次在"待签名"（planned），能继续签名、能作废');
    assert.ok(x.nonce !== null && String(x.nonce) === String(b.nonce), '批次记了热钱包 nonce（确认作废时核对用）');
    assert.ok(x.withdrawals?.[0]?.id === id && x.withdrawals[0].status === 'signing', '单已凑进批次（signing，商户看到的仍是已审核）');
    expectError(await admin('payout-reject-approved', { body: { id, reason: reason('凑进批次的单') } }), 409, 'invalid_state', '凑进批次的单不能直接驳回');
    const res = ok(await admin('payout-resume', { body: { id: b.id } }), 'payout-resume');
    assert.ok(res.batches?.length === 1 && res.batches[0].id === b.id && res.batches[0].rawHex === b.rawHex, '"继续签名"拿回同一批、同一份原文（只读，不签名）');
  } finally {
    for (const pt of pts) await voidAndCheck(pt, [id]);
  }
  const j = ok(await admin('payout-reject-approved', { body: { id, reason: reason('E05 以太坊作废后驳回') } }), 'payout-reject-approved');
  assert.ok(j?.status === 'rejected', '作废后能驳回');
});

test('E05 TRON withdraw-plan 只收已审核的单：待审核的 409 not_approved，空列表 422', async (t) => {
  expectError(await admin('withdraw-plan', { body: { ids: [] } }), 422, 'invalid_param', 'withdraw-plan 空列表');
  expectError(await admin('withdraw-plan', { body: { ids: ['WD-E2E-NOT-EXIST'] } }), 409, 'not_approved', 'withdraw-plan 不存在的单号');
  const id = await newPayout(t, 'e05-pending');
  if (!id) return;
  expectError(await admin('withdraw-plan', { body: { ids: [id] } }), 409, 'not_approved', 'withdraw-plan 待审核的单');
});

test('E05 TRON 凑批到待签名后作废：1 笔 → 待签名（有交易原文）→ 作废 → 回到已审核 → 驳回', async (t) => {
  const block = await tronPlanBlocker(UNIT);
  if (block) { t.skip(block); return; }
  const id = await newPayout(t, 'e05');
  if (!id) return;
  await approve([id]);

  const r = ok(await admin('withdraw-plan', { body: { ids: [id] } }), 'withdraw-plan');
  assert.ok(r.count === 1 && r.left === 0, '这一批 1 笔，没有留到下一轮的');
  assert.ok(r.steps?.length === 1 && r.steps[0].withdrawal_id === id && typeof r.steps[0].rawHex === 'string' && r.steps[0].rawHex.length > 0, '给了这一笔待签名的交易原文');
  const pt = r.payout_batch;
  assert.ok(typeof pt === 'string' && pt.startsWith('PT-TRON-'), '有打款批次号');
  try {
    const x = ok(await admin('payout-tx-batch', { query: { id: pt } }), 'payout-tx-batch');
    assert.ok(x.status === 'planned' && x.voidable === true && x.count === 1, '批次在"待签名"（planned），可以作废');
    assert.ok(x.withdrawals?.[0]?.id === id && x.withdrawals[0].status === 'signing', '单已凑进批次（signing，商户看到的仍是已审核）');
    expectError(await admin('payout-reject-approved', { body: { id, reason: reason('凑进批次的单') } }), 409, 'invalid_state', '凑进批次的单不能直接驳回');
    const res = ok(await admin('payout-resume', { body: { id: pt } }), 'payout-resume');
    assert.ok(res.steps?.length === 1 && res.payout_batch === pt, '"继续签名"能拿回同一批的交易原文（只读，不签名）');
  } finally {
    await voidAndCheck(pt, [id]);
  }
  const j = ok(await admin('payout-reject-approved', { body: { id, reason: reason('E05 作废后驳回') } }), 'payout-reject-approved');
  assert.ok(j?.status === 'rejected', '作废后能驳回');
});

test('E08 拆批：每批上限临时改成 0.000001，两笔已审核的单拆成"这一批 1 笔 + 留到下一轮 1 笔"；作废、上限写回、驳回', async (t) => {
  const block = await tronPlanBlocker(UNIT);
  if (block) { t.skip(block); return; }
  const a = await newPayout(t, 'e08-a');
  if (!a) return;
  const b = await newPayout(t, 'e08-b');
  if (!b) return;
  await approve([a, b]);

  await withLimits({ perItem: usdt(UNIT), perBatch: usdt(UNIT) }, 'E08 拆批：每批上限临时改成最小金额', async () => {
    const r = ok(await admin('withdraw-plan', { body: { ids: [a, b] } }), 'withdraw-plan');
    try {
      assert.ok(r.count === 1 && r.left === 1, '这一批 1 笔，留到下一轮 1 笔');
      assert.ok(units(r.total) === UNIT, '这一批合计 = 每批上限');
      assert.ok(r.steps?.length === 1 && r.steps[0].withdrawal_id === a, '先审核的那笔先装（按审核先后）');
    } finally {
      await voidAndCheck(r.payout_batch, [a, b]);
    }
  });
});
