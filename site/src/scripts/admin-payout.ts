// 运营后台：打款审核（第 3 批，原"提币审核"）和钱包设置（P4：每条链一张卡、授权额度）。
// 签名在浏览器里：页面自己解码服务器给的交易原文（server/wallet/evm-payout-codec.js，和服务器同一份），逐笔和审核通过的对比，
// 合约、代币、热钱包地址只认 config/wallets.json，链 ID 和网络费上限用页面自己的常量；热钱包私钥只在这个页面内存里用一次，签完清空，只把签名交给服务器。
import wallets from '../../../config/wallets.json';
import { checkPayoutTx, checkApproveTx, decodeUnsignedLegacyTx, decodePayCall, signUnsigned, addressOfKeyBytes } from '../../../server/wallet/evm-payout-codec.js';
import { fmtUsdt, parseUsdt, shortAddr } from '../lib/money';
import { copyBtn, field, fieldErr, fmtTime, h, mono, status, table } from './ui';
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
const HELD: Record<string, string> = { exceeds_per_item_limit: '超过单笔上限（只能驳回，或先改上限）', exceeds_batch_cap: '超过每批上限', exceeds_hot_balance: '热钱包余额不够', exceeds_allowance: '授权额度不够' };
const PERR: Record<string, string> = {
  exceeds_per_item_limit: '这笔超过单笔上限：只能驳回，或者先改上限。', exceeds_daily_limit: '今天（东八区）通过的合计会超过每天上限：明天再审，或者先改上限。', reason_required: '有不勾的笔，要填驳回原因。',
  wrong_signer: '签名人不是这条链的热钱包，服务器没广播。', broadcast_rejected: '节点拒绝了这笔交易：这一批已回到"已审核"，钱没动，可以重新凑批签名。', allowance_in_progress: '正在改授权额度，两笔签完之前这条链的打款暂停。',
  fee_too_high: '现在的网络费超过上限，先不签，稍后再试。', chain_not_enabled: '这条链还没开通批量打款（config/wallets.json 没写热钱包和 BatchPayout）。', not_applicable: 'TRON 打款不走合约，不用授权额度。',
};
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
export async function renderPayoutReview(ui: WalletUi, p: HTMLElement, legacyTron: (ids: string[]) => void) {
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

  const cards = r.cards.map((c: any) => planCard(ui, c, legacyTron));
  const batches = r.batches as any[];
  const recs = table(['批次', '链', '笔数', '金额 USDT', '状态', '时间'], batches.map((b) => [mono(b.id), chainTag(b.chain), String(b.count), usd(b.total), batchState(b), t(b.created_at)]),
    '还没有签名批次。', { rowAttrs: (i) => ({ 'data-payout-batch': batches[i].id }), onRow: (i) => batchDetail(ui, batches[i]) });
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
    h('h2', { class: 'h-sm' }, '签名批次'), recs,
    h('h2', { class: 'h-sm' }, '上限（后台可改：原因 + 动态码 + 审计）'), limits,
  );
}

function batchState(b: any): HTMLElement {
  const box = h('span', { class: 'cell-2' });
  const ST: Record<string, [string, string]> = { planned: ['submitted', '等签名'], broadcast: ['in', '链上确认中'], confirmed: ['approved', '已完成'], partial: ['needs_info', '部分成功'], failed: ['bad', b.chain === 'tron' ? '失败' : '整批回滚'], expired: ['expired', '没签名，已作废'] };
  const [cls, text] = ST[b.status] || ['submitted', b.status];
  box.append(status(cls, text));
  if (b.status === 'failed' && b.chain !== 'tron') box.append(h('span', { class: 'hint muted' }, '整批回滚：每笔回到已审核，可以重新凑批签名；商户余额没动'));
  if (b.status === 'partial') box.append(h('span', { class: 'hint muted' }, `${b.ok} 笔成功，失败的 ${b.failed} 笔回到已审核待签名`));
  if (b.chain === 'tron') box.append(h('span', { class: 'hint muted', 'data-energy-line': '' }, energyText(b.energy)));
  return box;
}
/** TRON 的能量一行（归集批次和打款批次共用） */
export function energyText(e: any): string {
  if (!e || !e.mode) return '能量：确认后才租（租不到改烧 TRX）';
  const n = e.energy ? Number(e.energy).toLocaleString('en') : '—';
  if (e.mode === 'rented') return `能量：租到 ${n}${e.cost_trx ? `，花 ${e.cost_trx} TRX` : ''}`;
  return `能量：${e.reason ? '租失败，已改烧 TRX' : '直接烧 TRX'}（约 ${n}）`;
}

function planCard(ui: WalletUi, c: any, legacyTron: (ids: string[]) => void): HTMLElement {
  const evm = c.chain !== 'tron';
  const why: Record<string, Node | string> = {
    allowance: h('span', {}, `授权额度不够：现在额度 ${usd(c.allowance)} USDT，挡住了要付的钱。先改授权额度再签。`),
    hot_balance: `热钱包余额不够（${usd(c.hot_balance)} USDT）：先往热钱包补 USDT。`,
    per_batch: '有一笔超过每批上限：先改上限，或者驳回。',
    allowance_in_progress: '正在改授权额度：两笔签完之前这条链的打款暂停。',
    not_enabled: evm ? '这条链还没开通批量打款（config/wallets.json 没写热钱包和 BatchPayout，或者链没开通）。' : '没有配置 TRON 热钱包。',
    rpc: '节点暂时连不上，读不到热钱包余额和额度。稍后再试。',
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
    sign);
}

function batchDetail(ui: WalletUi, b: any) {
  ui.call('payout-tx-batch', undefined, `&id=${encodeURIComponent(b.id)}`).then((d: any) => {
    ui.dialog(`签名批次 ${b.id}`, h('div', { class: 'stack' }, kv([['链', chainTag(d.chain)], ['状态', batchState(d)], ['交易', d.tx_hash ? mono(d.tx_hash) : '—']]),
      table(['单号', '商户', '收款地址', '金额', '状态'], d.withdrawals.map((w: any) => [mono(w.id), w.merchant, mono(shortAddr(w.to), w.to), usd(w.amount), w.reason ? `${w.status}（${w.reason}）` : w.status]), '—')), '关闭', null, false, true);
  }).catch((e) => ui.say(errOf(ui, e)));
}

function reviewOne(ui: WalletUi, x: any, r: any) {
  const reason = h('textarea', { rows: '2' }) as HTMLTextAreaElement;
  const reasonBox = field('pr-reason', '驳回原因（商户能看到）', reason); reasonBox.hidden = true;
  let rejecting = false;
  const msg = h('div');
  const rej = h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-payout-reject': '', onclick: () => { rejecting = true; reasonBox.hidden = false; rej.hidden = true; const b = okBtn(); if (b) { b.textContent = '驳回这笔'; b.className = 'btn btn-danger'; } reason.focus(); } }, '驳回这笔');
  const L = r.limits;
  const body = h('div', { class: 'stack' },
    kv([['单号', mono(x.id)], ['商户', x.merchant], ['类型', `${x.kind === 'payout' ? '代付' : '提币（商户提现）'} · ${x.source === 'api' ? 'API' : '后台'}`], ['链', chainTag(x.chain)],
      ['收款地址', h('span', { class: 'stack-sm' }, mono(x.to), h('span', { class: x.registered ? 'ok' : 'hint' }, x.registered ? '✓ 登记地址：商户在这条链登记过的提币地址' : x.first_time ? '代付：第一次给这个地址付（代付没有白名单，靠你审核）' : '代付：以前付过这个地址'))],
      ['金额', h('b', {}, `${usd(x.amount)} USDT`)], ['手续费', `${usd(x.fee)} USDT（已和金额一起冻结）`],
      ['上限检查', `${u(x.amount) <= u(L.perItem) ? '✓' : '✗'} 单笔 ≤ ${usd(L.perItem)} · 今天已通过 ${usd(r.today_approved)} / ${usd(L.perDay)}`]]),
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
}

function reviewGroup(ui: WalletUi, g: any, r: any) {
  const reason = h('textarea', { rows: '2' }) as HTMLTextAreaElement;
  const msg = h('div');
  const boxes = g.items.map((i: any) => h('input', { type: 'checkbox', class: 'check', checked: true, 'data-review-item': i.id, 'aria-label': `通过 ${i.id}` }) as HTMLInputElement);
  const body = h('div', { class: 'stack' },
    h('p', { class: 'm0' }, `${g.merchant} 的批量打款 ${g.batch_no}：${g.count} 笔，合计 ${usd(g.total)} USDT。勾上的通过，不勾的驳回（驳回的退冻结、逐笔发回调，其余照付）。`),
    table(['通过', '单号', '链', '收款地址', '金额', '检查'], g.items.map((i: any, k: number) => [boxes[k], mono(i.id), chainTag(i.chain), mono(shortAddr(i.to), i.to), usd(i.amount),
      u(i.amount) > u(r.limits.perItem) ? h('span', { class: 'bad' }, '超过单笔上限') : i.first_time ? h('span', { class: 'hint' }, '第一次给这个地址付') : '✓']), '—'),
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
    try { await ui.call('payout-limits-save', { values: Object.fromEntries(names.map(([k]) => [k, ins[k].value.replace(/,/g, '')])), reason: reason.value.trim(), code: code.value.trim() }); }
    catch (e: any) { const f = e?.field && ins[e.field] ? ins[e.field] : e?.code === 'bad_code' ? code : reason; fieldErr(f, e?.code === 'invalid_param' ? '数字不对：单笔不能大于每批，每批不能大于每天，提醒线不能高于热钱包上限' : errOf(ui, e)); return false; }
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
    passed ? h('p', { class: 'ok m0' }, `✓ ${b.items.length} 笔全部一致`) : h('p', { class: 'alert m0' }, `✗ 核对不通过：${WHY[why] || why}。页面已拦下，不能签名。请不要继续，并检查服务器是否被篡改。`),
    h('div', {}, next));
  ui.dialog(title, body1, '关闭', null, false, true);

  function step2() {
    const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6' }) as HTMLInputElement;
    const hot = h('input', { type: 'password', autocomplete: 'off', spellcheck: false, class: 'mono-input' }) as HTMLInputElement;
    const msg = h('div');
    const body2 = h('div', { class: 'stack' }, steps4(SIGN_STEPS, 1),
      kv([['这一批', `${b.items.length} 笔，合计 ${b.total} USDT`], ['付款', `热钱包 ${shortAddr(rules.hot || '')}`]]),
      field('ps-code', '验证器动态码（6 位）', code),
      field('ps-hot', '热钱包私钥（64 位十六进制；只在本页面使用，签名后立即清除，不发给服务器）', hot), msg);
    ui.dialog(title, body2, '签名并提交', async () => {
      let bad = fieldErr(code, /^\d{6}$/.test(code.value.trim()) ? null : '请输入 6 位动态码');
      const key = keyBytes(hot.value);
      bad = fieldErr(hot, key ? null : '请输入 64 位十六进制的私钥') || bad;
      if (bad || !key) return false;
      if (addressOfKeyBytes(key).toLowerCase() !== String(rules.hot || '').toLowerCase()) { key.fill(0); fieldErr(hot, `这个私钥对应的地址不是热钱包（${rules.hot || '没有配置'}）`); return false; }
      const signature = signUnsigned(b.rawHex, key);
      key.fill(0); hot.value = '';
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
        if (d.status === 'failed') { state.textContent = '整批回滚：交易在链上失败，每笔回到已审核，商户余额没动，可以重新凑批签名'; state.className = 'alert m0'; ui.rerender(); return; }
      } catch { /* 稍后再查 */ }
      setTimeout(poll, 3000);
    };
    setTimeout(poll, 3000);
  }
}

// ============ 钱包设置（P4：每条链一张卡） ============
export async function renderWalletCards(ui: WalletUi, p: HTMLElement, legacy: { initialized: boolean; xpub_fingerprint?: string; first_address?: string; customers: number; init: () => void; canInit: boolean }) {
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
        c.hot_balance !== null ? meter(c.hot_balance, c.hot_max) : null),
      evm ? sec('授权额度', '热钱包允许批量打款合约（BatchPayout）动用的上限', h('span', { 'data-allowance': c.chain }, c.allowance === null ? (c.payout_enabled ? '—' : '没开通批量打款') : `${usd(c.allowance)} / ${usd(c.hot_max)}`),
        c.payout_enabled ? h('div', {}, h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-allowance-edit': c.chain, onclick: () => editAllowance(ui, c) }, '改额度')) : null,
        h('span', { class: 'hint muted' }, c.chain === 'eth' ? '以太坊 USDT 改额度要两笔：先归零，再设新值' : '改额度一笔')) : sec('授权额度', '', h('span', { class: 'muted' }, '不用授权：TRON 打款不走合约，是 N 笔普通转账')),
      sec('发起账户', '只付手续费，钱只能进冷钱包（服务器上）', addr(c.operator, '没有配置')),
      sec('合约', '', h('span', {}, evm ? `转发合约工厂、批量归集合约（SweepBatcher）：${c.contracts_configured ? '已配置 ✓' : '没配置'}；批量打款合约（BatchPayout）：${c.payout ? '已配置 ✓' : '没配置'}` : `TRON 版工厂、批量归集合约：${c.contracts_configured ? '已配置 ✓' : '没配置（第 2 批合约上线后开通）'}`)),
      evm ? null : sec('租能量', '', h('span', {}, c.rental ? 'TronSave 已配置，预存余额和每一单在"系统状态"' : '没配置 TronSave：归集时直接烧 TRX')),
      evm ? null : h('div', { class: 'wl-sec', 'data-legacy-addresses': '' }, h('b', {}, '旧地址（第 0 批）'),
        h('span', {}, `${c.legacy_addresses} 个旧 TRON 地址，照常入账、照常归集。`, legacy.initialized ? ` 主助记词已初始化（公钥末 8 位 ${legacy.xpub_fingerprint}）。` : ''),
        legacy.canInit ? h('div', {}, h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: legacy.init }, '初始化主助记词')) : null));
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
    let bad = fieldErr(amount, n !== null ? null : '请输入金额，最多 6 位小数');
    bad = fieldErr(reason, reason.value.trim() ? null : '请写原因（记进审计）') || bad;
    bad = fieldErr(code, /^\d{6}$/.test(code.value.trim()) ? null : '请输入 6 位动态码') || bad;
    if (bad) return false;
    let plan: any;
    try { plan = await ui.call('allowance-plan', { chain, amount: amount.value.replace(/,/g, ''), reason: reason.value.trim(), code: code.value.trim() }); }
    catch (e: any) { if (e?.code === 'bad_code') fieldErr(code, errOf(ui, e)); else if (e?.code === 'reason_required') fieldErr(reason, '请写原因（记进审计）'); else msg.replaceChildren(h('p', { class: 'alert m0' }, errOf(ui, e))); return false; }
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
    const hot = h('input', { type: 'password', autocomplete: 'off', spellcheck: false, class: 'mono-input' }) as HTMLInputElement;
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
      const signature = signUnsigned(s.rawHex, key);
      key.fill(0); hot.value = '';
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
