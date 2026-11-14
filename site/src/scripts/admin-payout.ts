// 运营后台：打款审核（第 3 批，原"提币审核"）和钱包设置（P4：每条链一张卡、授权额度）。
// 签名在浏览器里：页面自己解码服务器给的交易原文（server/wallet/evm-payout-codec.js，和服务器同一份），逐笔和审核通过的对比，
// 合约、代币、热钱包地址只认 config/wallets.json，链 ID 和网络费上限用页面自己的常量；热钱包私钥只在这个页面内存里用一次，签完清空，只把签名交给服务器。
import wallets from '../../../config/wallets.json';
import { checkPayoutTx, checkApproveTx, decodeUnsignedLegacyTx, decodePayCall, signUnsigned, addressOfKeyBytes } from '../../../server/wallet/evm-payout-codec.js';
import { fmtUsdt, parseUsdt, shortAddr } from '../lib/money';
import { copyBtn, field, fieldErr, fmtTime, h, mono, secretInput, status, table } from './ui';
import { CHAIN_NAME, STD, chainTag, hero, type WalletUi } from './admin-wallet';

const root = document.getElementById('admin-root')!;
const ENV = (root.dataset.walletEnv || 'local') as 'production' | 'staging' | 'local';
const EVM_RULES: Record<string, { hot?: string; payout?: string; usdt?: string }> = ((wallets as any)[ENV]?.evm) || {};
const TRON_HOT: string = (wallets as any)[ENV]?.hot || '';
/** 页面自己的常量：链 ID（防止以太坊签的拿到别的链重放）、每笔交易的网络费上限（wei），不用服务器给的 */
const CHAIN_ID: Record<string, Record<string, number>> = { production: { eth: 1, bsc: 56 }, staging: { eth: 11155111, bsc: 97 }, local: { eth: 31337, bsc: 31337 } };
const MAX_FEE_WEI: Record<string, bigint> = { eth: 2n * 10n ** 17n, bsc: 5n * 10n ** 16n };
const DECIMALS: Record<string, number> = { eth: 6, bsc: 18 };
const NATIVE: Record<string, string> = { eth: 'ETH', bsc: 'BNB' };
const t = (iso?: string | null) => (iso ? fmtTime(iso, 'zh') : '—');
const u = (v: unknown) => parseUsdt(String(v ?? '0')) ?? 0;
const usd = (v: unknown) => fmtUsdt(u(v));
const rawOf = (chain: string, usdtText: unknown) => BigInt(u(usdtText)) * 10n ** BigInt(DECIMALS[chain] - 6);
const fromRaw = (chain: string, raw: bigint) => fmtUsdt(Number(raw / 10n ** BigInt(DECIMALS[chain] - 6)));
const minsOf = (iso: string) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
const waitText = (m: number) => (m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`);
const waitAttr = (m: number) => (m > 60 ? 'late' : m > 30 ? 'warn' : 'ok');
const BY: Record<string, string> = { hot_balance: '热钱包余额', allowance: '授权额度', per_batch: '每批上限' };
const HELD: Record<string, string> = { exceeds_per_item_limit: '超过单笔上限（只能驳回，或先改上限）', exceeds_batch_cap: '超过每批上限', exceeds_hot_balance: '热钱包余额不够', exceeds_allowance: '授权额度不够', transfer_failed: '收款地址转不了（代币拒收），已挂起', zero_address: '收款地址是全 0 地址，已挂起' };
/** 挂起的原因（已审核但不再进批，只能驳回） */
const HOLD: Record<string, string> = { transfer_failed: '收款地址转不了（代币拒收，例如被 USDT 拉黑）', zero_address: '收款地址是全 0 地址' };
/** 单的内部状态 → 中文（批次详情里用） */
const WST: Record<string, string> = { pending: '待审核', approved: '已审核，等凑批', signing: '已凑批，等签名', broadcast: '已广播，等链上确认', completed: '已完成', rejected: '已驳回', cancelled: '商户已取消', failed: '失败，已退回' };
const PERR: Record<string, string> = {
  exceeds_per_item_limit: '这笔超过单笔上限：只能驳回，或者先改上限。', exceeds_daily_limit: '今天（东八区）通过的合计会超过每天上限：明天再审，或者先改上限。', reason_required: '有不勾的笔，要填驳回原因。',
  wrong_signer: '签名人不是这条链的热钱包，服务器没广播。', broadcast_rejected: '节点拒绝了这笔交易：这一批已回到"已审核"，钱没动，可以重新凑批签名。', allowance_in_progress: '正在改授权额度，两笔签完之前这条链的打款暂停。',
  broadcast_unreachable: '节点暂时连不上，这一笔没算签完：稍后用同一个窗口再签一次同一笔（同一笔交易，不会重复）。', rpc_unreachable: '节点暂时连不上（以太坊 / BSC 节点），稍后再试。', estimate_reverted: '节点试算这一批会失败（合约回滚），没出交易：检查热钱包余额、授权额度和收款地址后再试。',
  too_many_bad_items: '这一轮有多笔收款地址转不了，已逐笔挂起；请先处理挂起的，再凑批。', exceeds_hot_max: '新额度不能超过热钱包上限：先改上限，或者调低额度。',
  payout_contract_mismatch: '这条链的批量打款合约核对不一致（代码、付款人或所有者不对），打款已停用。请研发核对配置后重启。', payout_contract_unverified: '这条链的批量打款合约还没核对上（节点暂时连不上），先不出交易，稍后再试。',
  not_approved: '只能签已审核的打款：先在上面逐笔审核通过。', plan_expired: '这一批交易原文已经快过期了：点"作废重凑"重新凑批再签。', invalid_state: '状态已经变化（可能已经签过或已作废），请刷新后再看。',
  fee_too_high: '现在的网络费超过上限，先不签，稍后再试。', chain_not_enabled: '这条链还没开通批量打款（config/wallets.json 没写热钱包和 BatchPayout）。', not_applicable: 'TRON 打款不走合约，不用授权额度。',
};
/** 上限之间的约束（服务器 updatePayoutLimits 的 rows[0].rule） */
const LIMIT_RULE: Record<string, string> = { per_item_le_per_batch: '单笔上限不能大于每批上限：调低单笔，或先调高每批', per_batch_le_per_day: '每批上限不能大于每天上限：调低每批，或先调高每天', hot_low_le_hot_max: '提醒线不能高于热钱包上限：调低提醒线，或先调高热钱包上限' };
const errOf = (ui: WalletUi, e: any) => PERR[e?.code] || ui.errText(e);
const kv = (rows: [string, Node | string][]) => h('dl', { class: 'kv kv-tight' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
const steps4 = (names: string[], on: number) => h('ol', { class: 'stepper-4' }, ...names.map((x, i) => h('li', { 'data-sign-step': String(i + 1), class: i < on ? 'done' : i === on ? 'on' : '' }, x)));
const okBtn = () => document.querySelector<HTMLButtonElement>('[data-pdialog-ok]');
/** 64 位十六进制私钥 → 字节；格式不对返回 null */
function keyBytes(s: string): Uint8Array | null {
  const x = s.trim().replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(x)) return null;
  return Uint8Array.from(x.match(/../g)!.map((b) => parseInt(b, 16)));
}

// ============ 打款审核 ============
/** legacyTron：TRON 的签名窗口在 admin-pay-real.ts（resume 给了就是继续签一个没签完的批次） */
export type TronSign = (ids: string[], resume?: any) => void;
export async function renderPayoutReview(ui: WalletUi, p: HTMLElement, legacyTron: TronSign) {
  const r = await ui.call('withdrawals');
  const rows = [...r.singles.map((x: any) => ({ ...x, group: false })), ...r.groups.map((g: any) => ({ ...g, group: true, id: g.batch_no }))]
    .sort((a: any, b: any) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const oldest = rows[0];
  const open = (x: any) => (x.group ? reviewGroup(ui, x, r) : reviewOne(ui, x, r));
  const top = oldest
    ? hero(minsOf(oldest.created_at) > 60 ? 'bad' : 'warn', `${r.pending_count} 笔打款等你审，最早一笔已等 ${waitText(minsOf(oldest.created_at))}`, '对外承诺：东八区 8:00–23:00 内 1 小时处理。每一笔都要你看过才能付。', { label: '去审最早的一笔', onClick: () => open(oldest) })
    : hero('ok', '现在没事要做', '有新的打款申请时会发邮件给你（1 分钟内的合并成一封）。对外承诺：东八区 8:00–23:00 内 1 小时处理。');
  top.querySelector('button')?.setAttribute('data-payout-oldest', '');
  const pend = table(['单号', '商户', '类型 · 来源', '链', '收款地址', '金额 USDT', '等了多久', ''], rows.map((x: any) => {
    const m = minsOf(x.created_at);
    const wait = h('span', { class: m > 60 ? 'wait-late' : m > 30 ? 'wait-warn' : '' }, `等了 ${waitText(m)}`);
    if (x.group) {
      const chains = [...new Set(x.items.map((i: any) => i.chain))] as string[];
      return [mono(x.batch_no), x.merchant, `商户批量 · ${x.source === 'api' ? 'API' : '后台上传'}`, h('span', { class: 'row-actions' }, ...chains.map(chainTag)), `${x.count} 笔`, h('b', {}, usd(x.total)), wait,
        h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: (e: Event) => { e.stopPropagation(); open(x); } }, '逐行审')];
    }
    return [mono(x.id), x.merchant, `${x.kind === 'payout' ? '代付' : '提币'} · ${x.source === 'api' ? 'API' : '后台'}`, chainTag(x.chain), h('span', { class: 'cell-2' }, mono(shortAddr(x.to), x.to),
      h('span', { class: 'hint muted' }, x.registered ? '✓ 登记的提币地址' : x.first_time ? '代付：第一次给这个地址付' : '代付：付过这个地址')), h('b', {}, usd(x.amount)), wait,
      h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: (e: Event) => { e.stopPropagation(); open(x); } }, '去审这笔')];
  }), '现在没有等你审的打款。', { onRow: (i) => open(rows[i]), rowAttrs: (i) => (rows[i].group ? { 'data-payout-group': rows[i].batch_no, 'data-wait': waitAttr(minsOf(rows[i].created_at)) } : { 'data-payout-row': rows[i].id, 'data-wait': waitAttr(minsOf(rows[i].created_at)) }) });

  const batches = r.batches as any[];
  const cards = r.cards.map((c: any) => planCard(ui, c, legacyTron, batches.filter((b) => b.chain === c.chain && b.status === 'planned')));
  const recs = table(['批次', '链', '笔数', '金额 USDT', '状态', '时间'], batches.map((b) => [mono(b.id), chainTag(b.chain), String(b.count), usd(b.total), batchState(b), t(b.created_at)]),
    '还没有签名批次。', { rowAttrs: (i) => ({ 'data-payout-batch': batches[i].id }), onRow: (i) => batchDetail(ui, batches[i], legacyTron) });
  // 已审核、还没凑进批次的单：可以驳回（退冻结、回调）；挂起的（收款地址转不了）排最前、标红
  const appr = (r.approved || []) as any[];
  const held = appr.filter((x) => x.hold).length;
  const approvedT = table(['单号', '商户', '链', '收款地址', '金额 USDT', '情况', ''], appr.map((x) => [mono(x.id), x.merchant, chainTag(x.chain), mono(shortAddr(x.to), x.to), usd(x.amount),
    x.hold ? h('span', { class: 'bad' }, `已挂起：${HOLD[x.hold] || x.hold}`) : h('span', { class: 'muted' }, x.batch_no ? `批量 ${x.batch_no} · 等凑批` : '等凑批'),
    h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-reject-approved': x.id, onclick: (e: Event) => { e.stopPropagation(); rejectApproved(ui, x); } }, '驳回')]),
    '没有已审核待凑批的单。', { rowAttrs: (i) => ({ 'data-approved-row': appr[i].id, ...(appr[i].hold ? { class: 'row-over' } : {}) }) });
  const L = r.limits;
  const limits = h('section', { class: 'card stack', 'data-payout-limits': '' },
    kv([['单笔', `≤ ${usd(L.perItem)} USDT（超过的只能驳回，或先改上限）`], ['每批', `≤ ${usd(L.perBatch)} USDT；以太坊、BSC 每笔交易 ≤ 100 笔，TRON ≤ 20 笔（Nile 实测后再定）`],
      ['每天', `≤ ${usd(L.perDay)} USDT（东八区自然日）· 今天已通过 ${usd(r.today_approved)}`], ['热钱包', `每条链 ≤ ${usd(L.hotMax)} USDT，低于 ${usd(L.hotLow)} 提醒补款；授权额度不超过热钱包上限`]]),
    h('p', { class: 'hint muted m0' }, '每批实际付多少取"每批上限、热钱包余额、授权额度"三者最小，超了系统自动拆成几批。'),
    h('div', {}, h('button', { type: 'button', class: 'btn btn-outline', 'data-edit-limits': '', onclick: () => editLimits(ui, L) }, '改上限')));
  p.replaceChildren(
    h('div', { class: 'toolbar' }, h('h1', { class: 'm0' }, '打款审核'), h('span', { class: 'muted' }, '提币、代付、批量打款都在这里逐笔审，审完按链凑批签名')),
    top,
    h('h2', { class: 'h-sm' }, `等你审（${r.pending_count} 笔）`), h('p', { class: 'hint muted m0' }, '按等了多久排，最早的在最上面；超 30 分钟标橙、超 1 小时标红。'), pend,
    h('h2', { class: 'h-sm' }, '已审核待签名（按链凑批）'), h('div', { class: 'plan-grid' }, ...cards),
    h('p', { class: 'hint muted' }, '签名在你的浏览器里做：页面先把要签的交易解码，逐笔和审核通过的收款人、金额对一遍，对不上就不签；热钱包私钥只在页面内存里用一次，不上服务器。'),
    h('details', { class: 'card', 'data-approved-list': '', ...(held ? { open: true } : {}) }, h('summary', {}, `已审核待凑批的单（${appr.length} 笔${held ? `，其中 ${held} 笔已挂起` : ''}）· 可以在这里驳回`), approvedT),
    h('h2', { class: 'h-sm' }, '签名批次'), recs,
    h('h2', { class: 'h-sm' }, '上限（后台可改：原因 + 动态码 + 审计）'), limits,
  );
}

function batchState(b: any): HTMLElement {
  const box = h('span', { class: 'cell-2 cell-start' });
  const ST: Record<string, [string, string]> = { planned: ['submitted', '没签完（等签名）'], broadcast: ['in', b.rebroadcast_at ? '还没上链，已重发' : '链上确认中'], confirmed: ['approved', '已完成'], partial: ['needs_info', '部分成功'], failed: ['bad', b.chain === 'tron' ? '失败' : '整批回滚'], expired: ['expired', '没签名，已作废'] };
  const [cls, text] = ST[b.status] || ['submitted', b.status];
  box.append(status(cls, text));
  if (b.status === 'failed' && b.chain !== 'tron') box.append(h('span', { class: 'hint muted' }, '整批回滚：每笔回到已审核，可以重新凑批签名；商户余额没动'));
  if (b.status === 'partial') box.append(h('span', { class: 'hint muted' }, `${b.ok} 笔成功，失败的 ${b.failed} 笔回到已审核待签名`));
  if (b.status === 'planned') box.append(h('span', { class: 'hint muted' }, '这批的单都锁在里面：点开继续签名，或作废重凑'));
  if (b.status === 'broadcast' && b.rebroadcast_at) box.append(h('span', { class: 'hint muted' }, '30 分钟没上链：nonce 还没被用掉，不退回（防止付两次），系统用原来签好的交易重发'));
  if (b.chain === 'tron') box.append(h('span', { class: 'hint muted', 'data-energy-line': '' }, energyText(b.energy)));
  return box;
}
/** TRON 的能量一行（归集批次和打款批次共用） */
export function energyText(e: any): string {
  if (!e || !e.mode) return '能量：确认后才租（租不到改烧 TRX）';
  const n = e.energy ? Number(e.energy).toLocaleString('en') : '—';
  if (e.mode === 'rented') return `能量：租到 ${n}${e.cost_trx ? `，花 ${e.cost_trx} TRX` : ''}`;
  if (!e.reason && !e.energy) return '能量：直接烧 TRX（不租能量）';
  return `能量：${e.reason ? '租失败，已改烧 TRX' : '直接烧 TRX'}（约 ${n}）`;
}

function planCard(ui: WalletUi, c: any, legacyTron: TronSign, planned: any[] = []): HTMLElement {
  const evm = c.chain !== 'tron';
  const why: Record<string, Node | string> = {
    allowance: h('span', {}, `授权额度不够：现在额度 ${usd(c.allowance)} USDT，挡住了要付的钱。先改授权额度再签。`),
    hot_balance: `热钱包余额不够（${usd(c.hot_balance)} USDT）：先往热钱包补 USDT。`,
    per_batch: '有一笔超过每批上限：先改上限，或者驳回。',
    allowance_in_progress: '正在改授权额度：两笔签完之前这条链的打款暂停。',
    not_enabled: evm ? '这条链还没开通批量打款（config/wallets.json 没写热钱包和 BatchPayout，或者链没开通）。' : '没有配置 TRON 热钱包。',
    rpc: '节点暂时连不上，读不到热钱包余额和额度。稍后再试。',
    contract_mismatch: '批量打款合约核对不一致（代码、付款人或所有者不对），这条链的打款已停用。请研发核对配置后重启。',
    contract_unverified: '批量打款合约还没核对上（节点暂时连不上），先不能签。稍后再试。',
  };
  const disabled = !c.approved_count || Boolean(c.blocked);
  const sign = h('button', { type: 'button', class: 'btn btn-primary', 'data-payout-sign': c.chain, disabled, onclick: () => (evm ? signEvm(ui, c.chain) : legacyTron([])) }, c.approved_count ? `核对并签名这 ${c.approved_count} 笔` : '没有要签的') as HTMLButtonElement;
  return h('article', { class: 'card stack-sm plan-card', 'data-payout-plan': c.chain },
    h('div', { class: 'batch-head' }, chainTag(c.chain), h('span', { class: 'muted' }, `${c.approved_count} 笔已审核`)),
    h('div', { class: 'batch-amt' }, usd(c.approved_total), h('small', {}, ' USDT')),
    kv([
      ['怎么付', evm ? '批量合约一笔交易付完（BatchPayout），失败整批回滚' : `N 笔普通转账（每批 ≤ ${c.max_items} 笔），逐笔记账`],
      ['热钱包', c.hot_balance === null ? '—' : `${usd(c.hot_balance)} USDT${evm ? ` · 授权额度 ${c.allowance === null ? '—' : usd(c.allowance)}` : ''}`],
      ['每批实际上限', c.cap === null ? '—' : `${usd(c.cap)} USDT（${BY[c.by] || '—'}最小）`],
    ]),
    c.blocked && c.approved_count ? h('p', { class: 'warn-box m0', 'data-plan-why': c.blocked }, why[c.blocked] || c.blocked) : c.blocked === 'not_enabled' ? h('p', { class: 'hint muted m0' }, why.not_enabled) : null,
    c.blocked === 'allowance' ? h('div', {}, h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-goto-allowance': '', onclick: () => ui.go('p-wallet') }, '去改授权额度')) : null,
    // 上次凑好了没签完（窗口关了）：这些单锁在批次里，给"继续签名"和"作废重凑"
    planned.length ? h('div', { class: 'warn-box stack-sm', 'data-plan-unsigned': c.chain }, h('span', {}, `有 ${planned.length} 批凑好了还没签（${planned.reduce((a, b) => a + b.count, 0)} 笔，${fmtUsdt(planned.reduce((a, b) => a + u(b.total), 0))} USDT），这些单锁在批次里。`),
      h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-batch-resume': planned[0].id, onclick: () => resumeBatch(ui, planned[0], legacyTron) }, '继续签名'),
        h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-batch-void': planned[0].id, onclick: () => voidBatch(ui, planned[0]) }, '作废重凑'))) : null,
    sign);
}

function batchDetail(ui: WalletUi, b: any, legacyTron: TronSign) {
  ui.call('payout-tx-batch', undefined, `&id=${encodeURIComponent(b.id)}`).then((d: any) => {
    const acts = d.voidable ? h('div', { class: 'row-actions' },
      d.resumable ? h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-batch-resume': d.id, onclick: () => resumeBatch(ui, d, legacyTron) }, '继续签名') : null,
      h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-batch-void': d.id, onclick: () => voidBatch(ui, d) }, '作废重凑'),
      d.resumable ? null : h('span', { class: 'hint muted' }, '交易原文快过期了，只能作废重凑')) : null;
    ui.dialog(`签名批次 ${b.id}`, h('div', { class: 'stack' }, kv([['链', chainTag(d.chain)], ['状态', batchState(d)], ['交易', d.tx_hash ? mono(d.tx_hash) : '—']]), acts,
      table(['单号', '商户', '收款地址', '金额', '状态'], d.withdrawals.map((w: any) => [mono(w.id), w.merchant, mono(shortAddr(w.to), w.to), usd(w.amount),
        h('span', { class: w.hold ? 'bad' : '' }, `${WST[w.status] || w.status}${w.hold ? `，已挂起（${HOLD[w.hold] || w.hold}）` : ''}${w.reason ? `（${w.reason}）` : ''}`)]), '—')), '关闭', null, false, true);
  }).catch((e) => ui.say(errOf(ui, e)));
}
/** 继续签一个没签完的批次：以太坊 / BSC 回到四步签名；TRON 打开 TRON 签名窗口 */
async function resumeBatch(ui: WalletUi, b: any, legacyTron: TronSign) {
  let r: any;
  try { r = await ui.call('payout-resume', { id: b.id }); } catch (e) { ui.say(errOf(ui, e)); ui.rerender(); return; }
  if (b.chain === 'tron') legacyTron([], r); else signBatch(ui, b.chain, r, 0);
}
/** 作废重凑：只作废还没签名的批次（服务器只认 planned；已经交了签名的一律不动），单回到已审核 */
function voidBatch(ui: WalletUi, b: any) {
  const msg = h('div');
  ui.dialog(`作废 ${b.id}`, h('div', { class: 'stack' }, h('p', { class: 'm0' }, `作废这一批还没签名的交易（${b.count} 笔，${usd(b.total)} USDT）：单回到"已审核"，之后可以重新凑批签名。已经交了签名的批次不能作废。`), msg), '作废', async () => {
    try { await ui.call('payout-void', { id: b.id }); } catch (e) { msg.replaceChildren(h('p', { class: 'alert m0' }, errOf(ui, e))); return false; }
    ui.say(`已作废 ${b.id}，${b.count} 笔回到已审核`); ui.rerender(); return true;
  }, true);
}
/** 已审核（还没凑进批次）的驳回：原因必填，退冻结、发回调 */
function rejectApproved(ui: WalletUi, x: any) {
  const reason = h('textarea', { rows: '2' }) as HTMLTextAreaElement;
  if (x.hold) reason.value = HOLD[x.hold] || '';
  const msg = h('div');
  ui.dialog(`驳回 ${x.id}`, h('div', { class: 'stack' }, kv([['商户', x.merchant], ['链', chainTag(x.chain)], ['收款地址', mono(x.to)], ['金额', `${usd(x.amount)} USDT`]]),
    x.hold ? h('p', { class: 'warn-box m0' }, `这笔已挂起：${HOLD[x.hold] || x.hold}。驳回后冻结的金额退回商户，商户会收到回调。`) : h('p', { class: 'hint muted m0' }, '这笔已经审核通过、还没付。驳回后冻结的金额退回商户，商户会收到回调。'),
    field('ra-reason', '驳回原因（商户能看到）', reason), msg), '驳回这笔', async () => {
    if (fieldErr(reason, reason.value.trim() ? null : '请填写驳回原因')) return false;
    try { await ui.call('payout-reject-approved', { id: x.id, reason: reason.value.trim() }); } catch (e) { msg.replaceChildren(h('p', { class: 'alert m0' }, errOf(ui, e))); return false; }
    ui.say(`已驳回 ${x.id}，冻结金额已退回商户`); ui.rerender(); return true;
  }, true);
}

function reviewOne(ui: WalletUi, x: any, r: any) {
  const reason = h('textarea', { rows: '2' }) as HTMLTextAreaElement;
  const reasonBox = field('pr-reason', '驳回原因（商户能看到）', reason); reasonBox.hidden = true;
  let rejecting = false;
  const msg = h('div');
  const rej = h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-payout-reject': '', onclick: () => { rejecting = true; reasonBox.hidden = false; rej.hidden = true; const b = okBtn(); if (b) { b.textContent = '驳回这笔'; b.className = 'btn btn-danger'; b.disabled = false; } reason.focus(); } }, '驳回这笔');
  const L = r.limits;
  const over = u(x.amount) > u(L.perItem);
  const body = h('div', { class: 'stack' },
    kv([['单号', mono(x.id)], ['商户', x.merchant], ['类型', `${x.kind === 'payout' ? '代付' : '提币（商户提现）'} · ${x.source === 'api' ? 'API' : '后台'}`], ['链', chainTag(x.chain)],
      ['收款地址', h('span', { class: 'stack-sm' }, mono(x.to), h('span', { class: x.registered ? 'ok' : 'hint' }, x.registered ? '✓ 登记地址：商户在这条链登记过的提币地址' : x.first_time ? '代付：第一次给这个地址付（代付没有白名单，靠你审核）' : '代付：以前付过这个地址'))],
      ['金额', h('b', {}, `${usd(x.amount)} USDT`)], ['手续费', `${usd(x.fee)} USDT（已和金额一起冻结）`],
      ['上限检查', h('span', { class: over ? 'bad' : '' }, `${over ? '✗' : '✓'} 单笔 ≤ ${usd(L.perItem)} · 今天已通过 ${usd(r.today_approved)} / ${usd(L.perDay)}`)]]),
    over ? h('p', { class: 'alert m0', 'data-over-limit': '' }, `这笔超过单笔上限（${usd(L.perItem)} USDT），不能通过：驳回，或者先改上限再审。`) : null,
    msg, rej, reasonBox);
  ui.dialog(`审核 ${x.id}`, body, '通过', async () => {
    if (rejecting) {
      if (fieldErr(reason, reason.value.trim() ? null : '请填写驳回原因')) return false;
      try { await ui.call('withdraw-reject', { id: x.id, reason: reason.value.trim() }); } catch (e) { msg.replaceChildren(h('p', { class: 'alert m0' }, errOf(ui, e))); return false; }
      ui.say('已驳回，冻结金额已退回商户'); ui.rerender(); return true;
    }
    try {
      const res = await ui.call('payout-approve', { ids: [x.id] });
      if (res.refused.length) { msg.replaceChildren(h('p', { class: 'alert m0' }, PERR[res.refused[0].reason] || res.refused[0].reason)); return false; }
    } catch (e) { msg.replaceChildren(h('p', { class: 'alert m0' }, errOf(ui, e))); return false; }
    ui.say(`已通过 ${x.id}，等按链凑批签名`); ui.rerender(); return true;
  });
  // 超过单笔上限：不能点"通过"（服务器也会拒），只能驳回
  const ok = okBtn(); if (ok && over) ok.disabled = true;
}

function reviewGroup(ui: WalletUi, g: any, r: any) {
  const reason = h('textarea', { rows: '2' }) as HTMLTextAreaElement;
  const msg = h('div');
  const overOf = (i: any) => u(i.amount) > u(r.limits.perItem);
  // 超过单笔上限的行：标红、默认不勾（勾上服务器也会拒，整批审核不生效）
  const boxes = g.items.map((i: any) => h('input', { type: 'checkbox', class: 'check', checked: !overOf(i), 'data-review-item': i.id, 'aria-label': `通过 ${i.id}` }) as HTMLInputElement);
  const body = h('div', { class: 'stack' },
    h('p', { class: 'm0' }, `${g.merchant} 的批量打款 ${g.batch_no}：${g.count} 笔，合计 ${usd(g.total)} USDT。勾上的通过，不勾的驳回（驳回的退冻结、逐笔发回调，其余照付）。`),
    table(['通过', '单号', '链', '收款地址', '金额', '检查'], g.items.map((i: any, k: number) => [boxes[k], mono(i.id), chainTag(i.chain), mono(shortAddr(i.to), i.to), usd(i.amount),
      overOf(i) ? h('span', { class: 'bad' }, '超过单笔上限，只能驳回') : i.first_time ? h('span', { class: 'hint' }, '第一次给这个地址付') : '✓']), '—', { rowAttrs: (k) => (overOf(g.items[k]) ? { class: 'row-over', 'data-over-limit': g.items[k].id } : {}) }),
    field('pr-reason', '驳回原因（有不勾的要填，商户能看到）', reason), msg);
  ui.dialog(`逐行审 ${g.batch_no}`, body, '通过勾选的、驳回其余', async () => {
    const approve = g.items.filter((_: any, k: number) => boxes[k].checked).map((i: any) => i.id);
    if (approve.length < g.items.length && fieldErr(reason, reason.value.trim() ? null : '有不勾的笔，要填驳回原因')) return false;
    try { await ui.call('payout-review', { batch_no: g.batch_no, approve, reason: reason.value.trim() }); }
    catch (e: any) { msg.replaceChildren(h('p', { class: 'alert m0' }, errOf(ui, e))); return false; }
    ui.say(`已审完 ${g.batch_no}：通过 ${approve.length} 笔，驳回 ${g.items.length - approve.length} 笔`); ui.rerender(); return true;
  });
}

function editLimits(ui: WalletUi, L: any) {
  const names: [string, string][] = [['perItem', '单笔上限'], ['perBatch', '每批上限'], ['perDay', '每天上限（东八区）'], ['hotMax', '热钱包上限'], ['hotLow', '热钱包低于多少提醒']];
  const ins = Object.fromEntries(names.map(([k]) => [k, h('input', { inputmode: 'decimal', value: usd(L[k]).replace(/,/g, '') }) as HTMLInputElement]));
  const reason = h('input', { maxlength: '200' }) as HTMLInputElement;
  const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6' }) as HTMLInputElement;
  ui.dialog('改上限', h('div', { class: 'stack' }, ...names.map(([k, l]) => field(`pl-${k}`, `${l}（USDT）`, ins[k])), field('pl-reason', '原因（记进审计）', reason), field('pl-code', '验证器动态码（6 位）', code)), '保存', async () => {
    let bad = false;
    for (const [k] of names) bad = fieldErr(ins[k], parseUsdt(ins[k].value) ? null : '请输入大于 0 的金额') || bad;
    bad = fieldErr(reason, reason.value.trim() ? null : '请写原因') || bad;
    bad = fieldErr(code, /^\d{6}$/.test(code.value.trim()) ? null : '请输入 6 位动态码') || bad;
    if (bad) return false;
    // 几个上限之间的关系，保存前就指出是哪一条不满足（和服务器同一套规则）
    const v = Object.fromEntries(names.map(([k]) => [k, parseUsdt(ins[k].value) ?? 0]));
    for (const [k, r] of [['perItem', 'per_item_le_per_batch'], ['perBatch', 'per_batch_le_per_day'], ['hotLow', 'hot_low_le_hot_max']] as const) {
      const broken = r === 'per_item_le_per_batch' ? v.perItem > v.perBatch : r === 'per_batch_le_per_day' ? v.perBatch > v.perDay : v.hotLow > v.hotMax;
      if (broken) { fieldErr(ins[k], LIMIT_RULE[r]); return false; }
    }
    try { await ui.call('payout-limits-save', { values: Object.fromEntries(names.map(([k]) => [k, ins[k].value.replace(/,/g, '')])), reason: reason.value.trim(), code: code.value.trim() }); }
    catch (e: any) { const f = e?.field && ins[e.field] ? ins[e.field] : e?.code === 'bad_code' ? code : reason; fieldErr(f, e?.code === 'invalid_param' ? LIMIT_RULE[e?.rows?.[0]?.rule] || '请输入大于 0 的金额，最多 6 位小数' : errOf(ui, e)); return false; }
    ui.say('上限已改，审计已记录'); ui.rerender(); return true;
  });
}

// ---------- 签名四步（以太坊、BSC） ----------
const SIGN_STEPS = ['核对每一笔', '动态码 + 热钱包私钥', '签名并提交', '链上确认'];
async function signEvm(ui: WalletUi, chain: string) {
  let plan: any;
  try { plan = await ui.call('payout-plan', { chain }); } catch (e) { ui.say(errOf(ui, e)); return; }
  if (!plan.batches.length) { ui.say(plan.held.length ? `这次凑不出批：${HELD[plan.held[0].reason] || plan.held[0].reason}` : '没有要签的'); ui.rerender(); return; }
  signBatch(ui, chain, plan, 0);
}
function signBatch(ui: WalletUi, chain: string, plan: any, idx: number) {
  const b = plan.batches[idx];
  const rules = EVM_RULES[chain] || {};
  const title = `签名 ${CHAIN_NAME[chain]} 打款 ${b.id}${plan.batches.length > 1 ? `（第 ${idx + 1} / ${plan.batches.length} 批）` : ''}`;
  // 期望值：合约、代币来自 config/wallets.json，链 ID、网络费上限是页面常量，收款人和金额来自审核通过的列表
  const expect = { chainId: CHAIN_ID[ENV]?.[chain], contract: rules.payout || '', token: rules.usdt || '', batchId: b.expect.batchId, maxFeeWei: MAX_FEE_WEI[chain],
    items: b.items.map((i: any) => ({ to: i.to, amount: rawOf(chain, i.amount) })) };
  let passed = true, why = '';
  try { checkPayoutTx(b.rawHex, expect); } catch (e: any) { passed = false; why = e?.code || 'noncanonical'; }
  let decoded: { to: string; amount: bigint }[] = [], tx: any = null;
  try { tx = decodeUnsignedLegacyTx(b.rawHex); decoded = decodePayCall(tx.data).items; } catch { decoded = []; }
  const n = Math.max(decoded.length, expect.items.length);
  const rowsT = Array.from({ length: n }, (_, i) => {
    const want = expect.items[i], got = decoded[i];
    const same = want && got && want.to.toLowerCase() === got.to.toLowerCase() && want.amount === got.amount;
    return [String(i + 1), want ? mono(shortAddr(want.to), want.to) : '—', want ? b.items[i].amount : '—', got ? mono(shortAddr(got.to), got.to) : '—', got ? fromRaw(chain, got.amount) : '—',
      h('span', { class: same ? 'ok' : 'bad' }, same ? '✓ 一致' : '✗ 不一致')];
  });
  const WHY: Record<string, string> = { wrong_chain: '链 ID 不对', wrong_contract: '交易不是发给 BatchPayout（config/wallets.json）', value_nonzero: '交易带了原生币', wrong_method: '不是打款函数', wrong_token: '代币不是 USDT（config/wallets.json）', wrong_batch: '批次号不对', item_mismatch: '收款人或金额和审核通过的不一致', fee_too_high: '网络费超过页面的上限', noncanonical: '交易原文写法不标准' };
  const next = h('button', { type: 'button', class: 'btn btn-primary', 'data-sign-next': '', disabled: !passed, onclick: () => step2() }, '核对无误，下一步') as HTMLButtonElement;
  const body1 = h('div', { class: 'stack' }, steps4(SIGN_STEPS, 0),
    h('p', { class: 'hint muted m0' }, '下面"解码出来的"是浏览器自己从交易原文里解出来的，和"审核通过的"逐笔对比；合约、代币、热钱包只认 config/wallets.json。'),
    h('div', { class: 'decoded-table' }, table(['#', '审核通过的收款人', '金额', '解码出来的收款人', '金额', '对比'], rowsT, '—', { rowAttrs: () => ({ 'data-decoded-row': '' }) })),
    kv([['合约', mono(rules.payout || '（没有配置）')], ['热钱包（付款）', mono(rules.hot || '（没有配置）')], ['网络费上限', `${Number(MAX_FEE_WEI[chain]) / 1e18} ${NATIVE[chain]}`], ['这笔网络费', tx ? `${Number(tx.gas * tx.gasPrice) / 1e18} ${NATIVE[chain]}` : '—']]),
    passed ? h('p', { class: 'ok m0' }, `✓ ${b.items.length} 笔全部一致`) : h('p', { class: 'alert m0' }, `✗ 核对不通过：${WHY[why] || why}。页面已拦下，不能签名，请不要继续，把这个提示截图给研发。`),
    h('p', { class: 'hint muted m0', 'data-sign-scope': '' }, '页面能拦下的：合约、代币（只认 config/wallets.json）、链 ID、网络费上限（页面自己的常量）。收款人和金额是和服务器给的审核列表对比，以服务器为准；万一服务器被人改了，最多付出热钱包里的钱、并且不超过授权额度——这两个上限就是兜底。'),
    h('div', {}, next));
  ui.dialog(title, body1, '关闭', null, false, true);

  function step2() {
    const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6' }) as HTMLInputElement;
    const hot = secretInput() as HTMLInputElement;
    const msg = h('div');
    const body2 = h('div', { class: 'stack' }, steps4(SIGN_STEPS, 1),
      kv([['这一批', `${b.items.length} 笔，合计 ${b.total} USDT`], ['付款', `热钱包 ${shortAddr(rules.hot || '')}`]]),
      field('ps-code', '验证器动态码（6 位）', code),
      field('ps-hot', '热钱包私钥（64 位十六进制；只在本页面使用，签名后立即清除，不发给服务器）', hot), msg);
    ui.dialog(title, body2, '签名并提交', async () => {
      let bad = fieldErr(code, /^\d{6}$/.test(code.value.trim()) ? null : '请输入 6 位动态码');
      const key = keyBytes(hot.value);
      bad = fieldErr(hot, key ? null : '请输入 64 位十六进制的私钥') || bad;
      if (bad || !key) { key?.fill(0); return false; } // 动态码格式不对时，已经解析出来的私钥字节也清零
      if (addressOfKeyBytes(key).toLowerCase() !== String(rules.hot || '').toLowerCase()) { key.fill(0); fieldErr(hot, `这个私钥对应的地址不是热钱包（${rules.hot || '没有配置'}）`); return false; }
      let signature: string;
      try { signature = signUnsigned(b.rawHex, key); } finally { key.fill(0); hot.value = ''; } // 签名出错也清空
      const body3 = h('div', { class: 'stack' }, steps4(SIGN_STEPS, 2), h('p', { class: 'm0' }, '已在浏览器里签名，正在交给服务器广播……'));
      ui.dialog(title, body3, '关闭', null, false, true);
      try {
        const out = await ui.call('payout-submit', { id: b.id, code: code.value.trim(), signature });
        step4(out.tx_hash);
      } catch (e) {
        body3.replaceChildren(steps4(SIGN_STEPS, 2), h('p', { class: 'alert m0' }, errOf(ui, e)));
        ui.rerender();
      }
      return false;
    });
  }
  function step4(txHash: string) {
    const state = h('p', { class: 'm0', 'data-chain-state': '' }, '等链上确认……（worker 每 15 秒查一次）');
    const more = idx + 1 < plan.batches.length ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => signBatch(ui, chain, plan, idx + 1) }, `签下一批（还有 ${plan.batches.length - idx - 1} 批）`) : null;
    const body4 = h('div', { class: 'stack' }, steps4(SIGN_STEPS, 3), h('p', { class: 'info-box m0' }, h('b', { class: 'ok-title' }, '已广播。'), ' 你可以关掉这个窗口，结果会出现在"签名批次"里。'),
      kv([['交易', mono(txHash)]]), state, more);
    ui.dialog(title, body4, '关闭', null, false, true);
    ui.rerender();
    const dlg = document.querySelector<HTMLDialogElement>('[data-pdialog]');
    const poll = async () => {
      if (!dlg?.open || !body4.isConnected) return;
      try {
        const d = await ui.call('payout-tx-batch', undefined, `&id=${encodeURIComponent(b.id)}`);
        // 链上确认后完成：关掉弹窗（还有下一批时留着让你接着签）
        if (d.status === 'confirmed') { state.textContent = `已完成：${d.count} 笔都已付出`; ui.say(`${b.id} 已完成：${d.count} 笔都已付出`); if (!more) dlg.close(); ui.rerender(); return; }
        if (d.status === 'failed') { state.textContent = d.error === 'dropped' ? '没上链：热钱包的这个 nonce 已被别的交易用掉，每笔回到已审核，商户余额没动，可以重新凑批签名' : '整批回滚：交易在链上失败，每笔回到已审核，商户余额没动，可以重新凑批签名'; state.className = 'alert m0'; ui.rerender(); return; }
        if (d.rebroadcast_at) state.textContent = '30 分钟还没上链：为了不付两次不会退回，系统已用原来签好的交易重发（通常是网络费出低了，等网络费回落）。';
      } catch { /* 稍后再查 */ }
      setTimeout(poll, 3000);
    };
    setTimeout(poll, 3000);
  }
}

// ============ 钱包设置（P4：每条链一张卡） ============
export async function renderWalletCards(ui: WalletUi, p: HTMLElement, legacy: { initialized: boolean; xpub_fingerprint?: string; customers: number }) {
  const r = await ui.call('payout-wallets');
  const addr = (a: string | null, none = '没有配置（config/wallets.json）') => (a ? h('span', { class: 'copy-row' }, mono(a), copyBtn(() => a, '复制', '已复制', 'link-copy')) : h('span', { class: 'muted' }, none));
  const sec = (title: string, note: string, ...kids: (Node | string | null)[]) => h('div', { class: 'wl-sec' }, h('div', {}, h('b', {}, title), ' ', h('span', { class: 'hint muted' }, note)), ...kids);
  const meter = (v: unknown, max: unknown) => h('meter', { class: 'meter-row', min: '0', max: String(u(max) || 1), value: String(u(v)) });
  const cards = r.cards.map((c: any) => {
    const evm = c.chain !== 'tron';
    return h('article', { class: 'card stack-sm wallet-card', 'data-wallet-card': c.chain },
      h('div', { class: 'batch-head' }, h('h2', { class: 'h-sm m0' }, `${CHAIN_NAME[c.chain]}（${STD[c.chain]}）`), c.onchain === 'ok' ? status('approved', '链上核对一致') : c.onchain === 'mismatch' ? status('bad', '链上核对不一致（已停用）') : c.enabled ? status('submitted', '还没核对上') : status('expired', '没开通')),
      sec('冷钱包', '多签，归集只能进这里（写死在合约里）', addr(c.cold)),
      sec('热钱包', '打款从这里付，只放小额；私钥不上服务器', addr(c.hot), c.hot_balance !== null ? h('span', { class: c.low ? 'bad' : '' }, `USDT ${usd(c.hot_balance)} / 上限 ${usd(c.hot_max)}${c.low ? `（低于 ${usd(c.hot_low)}，请补款）` : ''}`) : null,
        c.hot_balance !== null && u(c.hot_balance) > u(c.hot_max) ? h('p', { class: 'warn-box m0', 'data-hot-over': c.chain }, `热钱包超过上限 ${fmtUsdt(u(c.hot_balance) - u(c.hot_max))} USDT：热钱包只放小额，请把多出来的转回冷钱包。`) : null,
        c.hot_balance !== null ? meter(c.hot_balance, c.hot_max) : null),
      evm ? sec('授权额度', '热钱包允许批量打款合约（BatchPayout）动用的上限', h('span', { 'data-allowance': c.chain }, c.allowance === null ? (c.payout_enabled ? '—' : '没开通批量打款') : `${usd(c.allowance)} / ${usd(c.hot_max)}`),
        c.payout_enabled ? h('div', {}, h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-allowance-edit': c.chain, onclick: () => editAllowance(ui, c) }, '改额度')) : null,
        h('span', { class: 'hint muted' }, c.chain === 'eth' ? '以太坊 USDT 改额度要两笔：先归零，再设新值' : '改额度一笔')) : sec('授权额度', '', h('span', { class: 'muted' }, '不用授权：TRON 打款不走合约，是 N 笔普通转账')),
      sec('发起账户', '只付手续费，钱只能进冷钱包（服务器上）', addr(c.operator, '没有配置')),
      sec('合约', '', h('span', {}, evm ? `转发合约工厂、批量归集合约（SweepBatcher）：${c.contracts_configured ? '已配置 ✓' : '没配置'}；批量打款合约（BatchPayout）：${c.payout ? '已配置 ✓' : '没配置'}` : `TRON 版工厂、批量归集合约：${c.contracts_configured ? '已配置 ✓' : '没配置（第 2 批合约上线后开通）'}`)),
      evm ? null : sec('租能量', '', h('span', {}, `${c.rental ? 'TronSave 已配置（只用于归集），预存余额和每一单在"系统状态"' : '没配置 TronSave：归集时直接烧 TRX'}；打款不租能量，直接烧 TRX`)),
      evm ? null : h('div', { class: 'wl-sec', 'data-legacy-addresses': '' }, h('b', {}, '旧地址（第 0 批）'),
        h('span', {}, `${c.legacy_addresses} 个旧 TRON 地址，照常入账、照常归集。`, legacy.initialized ? ` 主助记词已初始化（公钥末 8 位 ${legacy.xpub_fingerprint}）。` : '')));
  });
  p.replaceChildren(
    h('div', { class: 'toolbar' }, h('h1', { class: 'm0' }, '钱包设置'), h('span', { class: 'muted' }, '热钱包、冷钱包按链分开；以太坊、BSC 没有助记词')),
    h('p', { class: 'note-box' }, '地址写在代码仓库的 config/wallets.json，这里只能看、不能改。改地址要研发提 PR，由你在 GitHub 上自己合并；文件一改就发邮件给你；服务启动时链上核对冷钱包和工厂，对不上就停用那条链并告警。'),
    h('div', { class: 'wallet-grid' }, ...cards),
  );
}

// ---------- 改授权额度：以太坊 4 步（填新额度和原因 → 签第 1 笔归零 → 签第 2 笔设新值 → 读回链上额度），BSC 3 步 ----------
function editAllowance(ui: WalletUi, c: any) {
  const chain = c.chain;
  const rules = EVM_RULES[chain] || {};
  const amount = h('input', { inputmode: 'decimal', value: usd(c.hot_max).replace(/,/g, '') }) as HTMLInputElement;
  const reason = h('input', { maxlength: '200' }) as HTMLInputElement;
  const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6' }) as HTMLInputElement;
  const msg = h('div');
  const title = `改 ${CHAIN_NAME[chain]} 授权额度`;
  ui.dialog(title, h('div', { class: 'stack' },
    kv([['现在的额度', `${c.allowance === null ? '—' : usd(c.allowance)} USDT`], ['热钱包上限', `${usd(c.hot_max)} USDT（额度不超过它）`]]),
    field('al-amount', '新额度（USDT）', amount), field('al-reason', '原因（记进审计）', reason), field('al-code', '验证器动态码（6 位）', code),
    h('p', { class: 'hint muted m0' }, chain === 'eth' ? '以太坊 USDT 不能从一个非 0 额度直接改成另一个：现在不是 0 时要签两笔（先归零、再设新值），两笔之间以太坊打款暂停。' : '签一笔就行。'), msg), '下一步', async () => {
    const n = parseUsdt(amount.value);
    let bad = fieldErr(amount, n === null ? '请输入金额，最多 6 位小数' : n > u(c.hot_max) ? `新额度不能超过热钱包上限 ${usd(c.hot_max)} USDT` : null);
    bad = fieldErr(reason, reason.value.trim() ? null : '请写原因（记进审计）') || bad;
    bad = fieldErr(code, /^\d{6}$/.test(code.value.trim()) ? null : '请输入 6 位动态码') || bad;
    if (bad) return false;
    let plan: any;
    try { plan = await ui.call('allowance-plan', { chain, amount: amount.value.replace(/,/g, ''), reason: reason.value.trim(), code: code.value.trim() }); }
    catch (e: any) { if (e?.code === 'bad_code') fieldErr(code, errOf(ui, e)); else if (e?.code === 'reason_required') fieldErr(reason, '请写原因（记进审计）'); else if (e?.code === 'exceeds_hot_max') fieldErr(amount, errOf(ui, e)); else msg.replaceChildren(h('p', { class: 'alert m0' }, errOf(ui, e))); return false; }
    signStep(plan, 0);
    return false;
  });
  function signStep(plan: any, i: number) {
    const two = plan.steps.length === 2;
    const names = [...plan.steps.map((s: any, k: number) => (two && k === 0 ? '第 1 笔：先归零' : `第 ${k + 1} 笔：设为 ${s.amount}`)), '读回链上额度'];
    const s = plan.steps[i];
    const want = BigInt(u(s.amount)) * 10n ** BigInt(DECIMALS[chain] - 6);
    let ok = true, why = '';
    try { checkApproveTx(s.rawHex, { chainId: CHAIN_ID[ENV]?.[chain], token: rules.usdt || '', spender: rules.payout || '', amount: want, maxFeeWei: MAX_FEE_WEI[chain] }); } catch (e: any) { ok = false; why = e?.code || 'noncanonical'; }
    const hot = secretInput() as HTMLInputElement;
    const m = h('div');
    const body = h('div', { class: 'stack' }, steps4(names, i),
      two ? h('p', { class: 'warn-box m0' }, `以太坊额度现在不是 0（${plan.current} USDT）：先归零，再设为 ${plan.target}，一共两笔。两笔之间以太坊打款暂停。`) : null,
      kv([['这一笔', `approve(批量打款合约 ${shortAddr(rules.payout || '')}, ${s.amount} USDT)`], ['页面核对', ok ? h('span', { class: 'ok' }, '✓ 解码出来的和要设的一致') : h('span', { class: 'bad' }, `✗ 不一致（${why}），不能签`)]]),
      field('ps-hot', '热钱包私钥（64 位十六进制；只在本页面使用，签完立即清除）', hot), m);
    ui.dialog(title, body, `签${names[i].split('：')[0]}`, async () => {
      if (!ok) return false;
      const key = keyBytes(hot.value);
      if (fieldErr(hot, key ? null : '请输入 64 位十六进制的私钥') || !key) return false;
      if (addressOfKeyBytes(key).toLowerCase() !== String(rules.hot || '').toLowerCase()) { key.fill(0); fieldErr(hot, `这个私钥对应的地址不是热钱包（${rules.hot || '没有配置'}）`); return false; }
      let signature: string;
      try { signature = signUnsigned(s.rawHex, key); } finally { key.fill(0); hot.value = ''; }
      try { await ui.call('allowance-submit', { chain, rawHex: s.rawHex, signature }); }
      catch (e) { m.replaceChildren(h('p', { class: 'alert m0' }, `${errOf(ui, e)}${two && i === 1 ? ' 额度现在是 0，重签第 2 笔即可。' : ''}`)); return false; }
      if (i + 1 < plan.steps.length) { signStep(plan, i + 1); return false; }
      await readBack(names);
      return false;
    });
  }
  async function readBack(names: string[]) {
    const state = h('p', { class: 'm0' }, '正在读链上额度……');
    ui.dialog(title, h('div', { class: 'stack' }, steps4(names, names.length - 1), state), '关闭', null, false, true);
    for (let k = 0; k < 10; k++) {
      try {
        const r = await ui.call('payout-plans');
        const card = r.cards.find((x: any) => x.chain === chain);
        if (card?.allowance !== null && card?.allowance !== undefined) { state.replaceChildren(h('b', { class: 'ok' }, `链上额度现在是 ${usd(card.allowance)} USDT`)); if (!card.allowance_busy) break; }
      } catch { /* 再试 */ }
      await new Promise((ok) => setTimeout(ok, 2000));
    }
    ui.rerender();
  }
}
