// E09：归集凑批到"待确认"后作废（不点确认：确认会让发起账户真的发交易、花测试币）。
//   只动这次自己凑出来的批次（slot = manual、凑批前不存在的）；某条链已经有待确认的批次时不凑（那是定时凑批或管理员的），跳过这条链。
// E10：对账：立即运行每日任务，对账记录里有最近一天；商户名打码。运行每日任务会照常检查、需要时给管理员发"每日检查需要处理"的邮件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { admin, ok, expectError, RUN } from './lib.mjs';

const why = (w) => `staging-e2e ${RUN}：${w}`;

test('E09 不凑批也能测的：没开通的链凑批 409 chain_not_enabled；作废不存在的批次 409', async () => {
  expectError(await admin('wallet-sweep-propose', { body: { chain: 'e2e-no-such-chain' } }), 409, 'chain_not_enabled', '不存在的链');
  const s = ok(await admin('wallet-sweep'), 'wallet-sweep');
  const off = (s.chains || []).find((c) => !c.enabled);
  if (off) expectError(await admin('wallet-sweep-propose', { body: { chain: off.chain } }), 409, 'chain_not_enabled', `没开通的链（${off.chain}）`);
  expectError(await admin('wallet-sweep-cancel', { body: { id: 'e2e-no-such-batch', reason: why('不存在的批次') } }), 409, 'batch_state', '作废不存在的批次');
});

test('E09 归集凑批 → 待确认 → 作废（原因必填）→ 已作废；不点确认', { timeout: 300_000 }, async (t) => {
  const s = ok(await admin('wallet-sweep'), 'wallet-sweep');
  const on = (s.chains || []).filter((c) => c.enabled);
  if (!on.length) { t.skip('没有开通归集的链：跳过，算未验证'); return; }
  const notes = [];
  let done = 0;
  for (const c of on) {
    const busy = (c.batches || []).filter((b) => b.status === 'awaiting_approval');
    if (busy.length) { notes.push(`${c.chain} 已有待确认的批次（不是这次造的，不动）`); continue; }
    const r = await admin('wallet-sweep-propose', { body: { chain: c.chain }, timeoutMs: 120_000 });
    if (r.status !== 200) { notes.push(`${c.chain} 凑批 HTTP ${r.status} ${r.body?.error?.code || ''}`); continue; }
    const mine = (r.body.batches || []).filter((b) => b.slot === 'manual' && b.status === 'awaiting_approval');
    if (!mine.length) { notes.push(`${c.chain} 没有够门槛的地址余额，凑不出批次`); continue; }
    for (const b of mine) {
      assert.ok(b.chain === c.chain && b.address_count > 0 && (b.items || []).length > 0, `${c.chain} 凑出的批次有地址`);
      expectError(await admin('wallet-sweep-cancel', { body: { id: b.id, reason: ' ' } }), 422, 'reason_required', '作废不写原因');
      const x = ok(await admin('wallet-sweep-cancel', { body: { id: b.id, reason: why('E09 凑批后作废（不确认，不花测试币）') } }), 'wallet-sweep-cancel');
      assert.ok(x.status === 'cancelled', '作废后是 cancelled');
      const v = ok(await admin('wallet-sweep-batch', { query: { id: b.id } }), 'wallet-sweep-batch');
      assert.ok(v.status === 'cancelled' && (v.items || []).every((i) => i.status === 'released'), '批次已作废，地址都放回去了（下次还能凑）');
      expectError(await admin('wallet-sweep-cancel', { body: { id: b.id, reason: why('再作废一次') } }), 409, 'batch_state', '作废过的批次再作废');
      done++;
    }
  }
  if (!done) t.skip(`没有凑出批次：${notes.join('；')}。算未验证`);
});

test('E10 对账：立即运行每日任务 → 对账记录有最近一天、数字都是 USDT 字符串；商户名打码', { timeout: 300_000 }, async () => {
  const r = ok(await admin('recon-run', { body: {}, timeoutMs: 240_000 }), 'recon-run');
  assert.ok(r?.ok === true, '每日任务跑完');
  const rc = ok(await admin('recon'), 'recon');
  const d = rc.days?.[0];
  assert.ok(d, '有对账记录');
  const age = Date.now() - Date.parse(`${d.day}T00:00:00Z`);
  assert.ok(age >= -86_400_000 && age < 2 * 86_400_000, '最近一条对账记录是今天（按服务器的日期，前后差不过一天）');
  assert.ok(['balances', 'chain', 'fees', 'diff'].every((k) => typeof d[k] === 'string' && /^-?\d+(\.\d+)?$/.test(d[k])), '对账的金额都是 USDT 字符串（不是没换算的整数）');
  assert.ok(Array.isArray(rc.merchants), '有按商户的核对');
  for (const m of rc.merchants) {
    assert.ok(typeof m.ok === 'boolean', '每个商户都有"对得上"的结论');
    assert.ok(!m.name || /^.\*\*\*$/u.test(m.name), '商户名已打码');
  }
});

test('E10 异常到账列表能读，商户名打码', async () => {
  const a = ok(await admin('anomalies'), 'anomalies');
  assert.ok(Array.isArray(a.items), '有列表（可以是空的）');
  assert.ok(a.items.every((x) => !x.merchant || /^.\*\*\*$/u.test(x.merchant)), '商户名已打码');
});
