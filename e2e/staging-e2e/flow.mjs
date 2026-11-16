// 业务验收用例（E02～E11）共用的步骤：造打款单、按自己造的单号收尾、改上限后原样写回、金额换算。
// 和 lib.mjs 一样：不打印接口返回；失败信息只有动作名、HTTP 状态和错误码。
//   - 造单只能用测试商户的开放 API（测试管理员不能建单）：没配 API Key、出网地址不在商户的来源地址白名单、商户余额不够时，
//     调用方的用例跳过并写明原因（算"未验证"，不算通过）
//   - 每一笔都只用最小金额（0.000001 USDT 起），只到"待签名"为止，不签名
//   - 造的单记在 mine 里，用例结束时 cleanup() 逐笔驳回（待审核的用 withdraw-reject，已审核的用 payout-reject-approved）
import assert from 'node:assert/strict';
import { admin, merchant, hasMerchant, ok, RUN } from './lib.mjs';

/** 收款地址：随便算出来的一个合法 TRON 地址（没有人有它的私钥；用例只到待签名，不会真的打款） */
export const PAYEE = 'TNQ6owQCmCBpsd3YjbtnRRHDpJ3dg4PgCs';
/** 以太坊收款地址：随机 20 字节算出的合法地址（带校验大小写，没有人有它的私钥；用例只到待签名，不会真的打款） */
export const ETH_PAYEE = '0x56d16a25629B59d572Dc77618FE247819a37c509';
const PAYEES = { tron: PAYEE, eth: ETH_PAYEE };
/** 最小金额：1 = 0.000001 USDT */
export const UNIT = 1;

const SCALE = 1_000_000;
/** "12.5" → 12500000（0.000001 USDT 为单位的整数）；格式不对、不是字符串（接口漏了金额转换）返回 NaN */
export function units(s) {
  if (typeof s !== 'string') return NaN;
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(String(s ?? '').replace(/,/g, ''));
  return m ? Number(m[1]) * SCALE + Number((m[2] || '').padEnd(6, '0')) : NaN;
}
/** 12500000 → "12.500000" */
export const usdt = (n) => `${Math.floor(n / SCALE)}.${String(n % SCALE).padStart(6, '0')}`;

/** 不能造单时的原因（null = 能造） */
export const noMerchantReason = () => (hasMerchant ? null : '没有测试商户的 API Key（STAGING_E2E_MERCHANT_KEY、STAGING_E2E_MERCHANT_SECRET 没填）：要建打款单的步骤跳过，算未验证');

/** 造单失败里属于"环境没准备好"的错误码 → 跳过的原因；其余的照常判失败 */
const ENV_REASONS = {
  ip_not_allowed: '这次运行的出网地址不在测试商户的来源地址白名单（ip_whitelist）里（建单接口要白名单）：要建打款单的步骤跳过，算未验证',
  insufficient_balance: '测试商户的可用余额不够（金额 + 付款手续费）：要建打款单的步骤跳过，算未验证',
  merchant_disabled: '测试商户被停用了：要建打款单的步骤跳过，算未验证',
};

/** 这个文件里造的单：用例结束时 cleanup() 收尾 */
export const mine = new Set();
let seq = 0;
const tag = (label) => `${RUN}-${label}-${++seq}`.slice(0, 64);

/**
 * 测试商户建一笔单笔代付（默认 TRON，chain 可以是 'eth'；待审核）。返回单号；环境没准备好时调用 t.skip(原因) 并返回 null（调用方直接 return）
 */
export async function newPayout(t, label, amount = UNIT, chain = 'tron') {
  const why = noMerchantReason();
  if (why) { t.skip(why); return null; }
  const ref = tag(label);
  const r = await merchant('POST', 'withdrawals/', { kind: 'payout', chain, to: PAYEES[chain], amount: usdt(amount), merchant_ref: ref }, { idem: ref });
  const code = r.body?.error?.code;
  if (r.status !== 200 && ENV_REASONS[code]) { t.skip(ENV_REASONS[code]); return null; }
  const w = ok(r, `开放 API 建单（${label}）`);
  assert.ok(typeof w?.withdrawal_no === 'string' && w.withdrawal_no, '建单返回了单号');
  assert.ok(w.status === 'pending', '新单是待审核');
  mine.add(w.withdrawal_no);
  return w.withdrawal_no;
}

/** 测试商户提交一个商户批量（TRON，每行金额见 amounts）。返回 { batchNo, ids }；环境没准备好时 t.skip 并返回 null */
export async function newPayoutBatch(t, label, amounts) {
  const why = noMerchantReason();
  if (why) { t.skip(why); return null; }
  const ref = tag(label);
  const items = amounts.map((a, i) => ({ chain: 'tron', to: PAYEE, amount: usdt(a), merchant_ref: `${ref}-${i + 1}`.slice(0, 64) }));
  const r = await merchant('POST', 'payouts/batch/', { items }, { idem: ref });
  const code = r.body?.error?.code;
  if (r.status !== 200 && ENV_REASONS[code]) { t.skip(ENV_REASONS[code]); return null; }
  const b = ok(r, `开放 API 批量打款（${label}）`);
  const ids = (b?.items || []).map((x) => x.withdrawal_no);
  assert.ok(typeof b?.batch_no === 'string' && b.batch_no, '批量打款返回了批次号');
  assert.ok(ids.length === amounts.length && ids.every((x) => typeof x === 'string' && x), '每行都有单号');
  for (const id of ids) mine.add(id);
  return { batchNo: b.batch_no, ids };
}

/** 商户看到的这笔单的状态（pending / approved / rejected …） */
export async function statusOf(id) {
  const w = ok(await merchant('GET', `withdrawals/?withdrawal_no=${encodeURIComponent(id)}`), '商户查单');
  return w?.status;
}

/** 打款审核页（测试管理员视角） */
export const overview = async () => ok(await admin('payout-overview'), 'payout-overview');

/** 驳回原因：带运行号，审计里能认出是用例造的 */
export const reason = (what) => `staging-e2e ${RUN}：${what}`;

/**
 * 收尾：把这个文件造的单逐笔驳回（待审核的 withdraw-reject；已审核没凑批的 payout-reject-approved）。
 * 已经是终态（rejected、cancelled）的跳过；收不了的（例如还在没作废的批次里）断言失败，提醒人工处理
 */
export async function cleanup() {
  if (!mine.size) return;
  const left = [];
  for (const id of mine) {
    let r = await admin('withdraw-reject', { body: { id, reason: reason('收尾驳回') } });
    if (r.status === 409) r = await admin('payout-reject-approved', { body: { id, reason: reason('收尾驳回') } });
    if (r.status !== 200) left.push(id);
  }
  // 两种驳回都 409 的：用例里已经驳回过的（终态）没问题；其余（例如还在没作废的批次里）要人工处理。状态从运营后台的提币列表看（不调商户接口，免得撞限流）
  if (left.length) {
    const w = ok(await admin('withdrawals', { query: { all: '1' } }), 'withdrawals');
    const st = new Map((w.items || []).map((x) => [x.id, x.status]));
    const stuck = left.filter((id) => !['rejected', 'cancelled'].includes(st.get(id)));
    assert.ok(!stuck.length, `有单没能收尾，要在后台手工驳回：${stuck.map((id) => `${id}（${st.get(id) || '查不到'}）`).join('，')}`);
  }
  mine.clear();
}

/** 读出现在的上限（USDT 字符串） */
export const readLimits = async () => ok(await admin('payout-limits'), 'payout-limits');

/** 改上限（values 是 USDT 字符串）；测试管理员免动态码，code 随便填 */
export const saveLimits = (values, why) => admin('payout-limits-save', { body: { values, reason: reason(why), code: '000000' } });

/**
 * 临时改上限跑 fn，结束（含失败）后把读出的原值原样写回，并核对写回后和原来一样。
 * changes：{ perItem?, perBatch?, perDay? }（USDT 字符串）
 */
export async function withLimits(changes, why, fn) {
  const before = await readLimits();
  try {
    ok(await saveLimits({ ...before, ...changes }, why), '临时改上限');
    const now = await readLimits();
    assert.ok(Object.keys(changes).every((k) => units(now[k]) === units(changes[k])), '改完能读到新的上限');
    return await fn(before);
  } finally {
    ok(await saveLimits(before, `${why}：原值写回`), '上限原值写回');
    const after = await readLimits();
    assert.ok(Object.keys(before).every((k) => units(after[k]) === units(before[k])), '上限已原样写回');
  }
}

/** TRON 的凑批卡片；还有没签名的 TRON 批次时返回原因（withdraw-plan 会把它们作废，那是管理员手上的东西，不能动） */
export async function tronPlanBlocker(minHot) {
  const p = ok(await admin('payout-plans'), 'payout-plans');
  const card = (p.cards || []).find((c) => c.chain === 'tron');
  if (!card?.enabled) return 'TRON 打款没开通（没有热钱包）：凑批步骤跳过';
  if (card.planned_batches > 0) return 'TRON 已有没签名的打款批次（可能是管理员正在签）：凑批会把它作废，这一步跳过，算未验证';
  if (card.blocked === 'rpc') return '查不到 TRON 热钱包余额（节点不通）：凑批步骤跳过，算未验证';
  if (!(units(card.hot_balance) >= minHot)) return 'TRON 热钱包的测试 USDT 不够：凑批步骤跳过，算未验证';
  return null;
}

/**
 * 以太坊 / BSC 的凑批卡片：凑不了或不该凑时返回原因（null = 可以凑）。
 * payout-plan 会把这条链所有已审核的单一起装批、并作废没签名的批次，所以有别人的已审核单或没签名的批次时不凑（那是管理员手上的东西）
 */
export async function evmPlanBlocker(chain, minCap) {
  const p = ok(await admin('payout-plans'), 'payout-plans');
  const card = (p.cards || []).find((c) => c.chain === chain);
  if (!card?.enabled) return `${chain} 批量打款没开通：凑批步骤跳过`;
  if (card.planned_batches > 0) return `${chain} 已有没签名的打款批次（可能是管理员正在签）：凑批会把它作废，这一步跳过，算未验证`;
  if (card.approved_count > 0) return `${chain} 已有别的已审核单：凑批会把它们一起装进来，这一步跳过，算未验证`;
  if (card.blocked) return `${chain} 凑批卡片写明凑不了（${card.blocked}）：这一步跳过，算未验证`;
  if (!(units(card.cap) >= minCap)) return `${chain} 每批实际上限（热钱包、授权额度、每批上限取最小）不够：凑批步骤跳过，算未验证`;
  return null;
}
