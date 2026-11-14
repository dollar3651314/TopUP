// 运营后台的合约钱包部分（正式模式）：归集（ETH、BSC）、钱包提供方、系统状态里每条链的卡片、概览的"待处理"。
// 接口：/api/wallet/?a=wallet-*（server/wallet/admin-actions.js）。页面只显示服务器给的结果，钱只能进冷钱包（写死在合约里）。
import { fmtUsdt, parseUsdt, shortAddr } from '../lib/money';
import { copyBtn, field, fieldErr, fmtTime, h, mono, stat, status, table } from './ui';

type Call = (a: string, body?: unknown, qs?: string) => Promise<any>;
type Dialog = (t: string, content: Node, okText: string, onOk: (() => boolean | void | Promise<boolean | void>) | null, danger?: boolean, hideOk?: boolean) => void;
export interface WalletUi { call: Call; dialog: Dialog; say: (m: string) => void; errText: (e: unknown) => string; rerender: () => void; go: (tab: string) => void }

export const CHAIN_NAME: Record<string, string> = { eth: '以太坊', bsc: 'BSC', tron: 'TRON' };
export const STD: Record<string, string> = { eth: 'ERC20', bsc: 'BEP20', tron: 'TRC20' };
const t = (iso?: string | null) => (iso ? fmtTime(iso, 'zh') : '—');
const usd = (s: string | null | undefined) => fmtUsdt(parseUsdt(String(s ?? '0')) ?? 0);
export const chainTag = (c: string) => h('span', { class: `chain-tag c-${c}` }, CHAIN_NAME[c] || c);
export const laterTag = () => h('span', { class: 'later-tag' }, '第 2 批');
const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 60 ? `${m} 分钟` : m < 1440 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${Math.floor(m / 1440)} 天 ${Math.floor((m % 1440) / 60)} 小时`;
};
const ERR: Record<string, string> = {
  batch_state: '这批已经被确认、作废或取消了（可能是另一个窗口点的），已刷新。',
  batch_expired: '这批等确认超过 24 小时，已经作废；下一次凑批会重新列出这些地址。',
  sweep_not_sent: '没有提交，钱没动：节点暂时连不上，交易没有发出。这批仍是"待确认"，稍后再点一次即可。',
  energy_and_trx_insufficient: 'TronSave 没响应、发起账户的 TRX 也不够烧：没提交，钱没动。给发起账户补 TRX 或给 TronSave 充值后再确认。',
  sweep_send_failed: '节点拒绝了这笔交易，这批已标为失败，地址放回待归集；下一次凑批会重新列出。',
  reason_required: '请填写原因。', bad_code: '动态码不正确或已经用过，请等下一个动态码。',
  operator_not_configured: '服务器还没有配置归集发起账户（SWEEP_OPERATOR_KEY），不能执行归集。',
  chain_not_enabled: '这条链还没有开通。', provider_not_enabled: '这家提供方还没有接入，不能切换过去。',
  wallet_not_configured: '钱包还没有配置好，看"系统状态"。', invalid_param: '有一项填得不对，请检查标红的地方。',
};
const err = (ui: WalletUi, e: any) => ERR[e?.code] || ui.errText(e);
/** TRON 批次的能量一行：租到多少、花多少 TRX / 租失败已改烧 TRX */
function energyLine(e: any): string {
  if (!e || !e.mode) return '确认后才租';
  const n = e.energy ? Number(e.energy).toLocaleString('en') : '—';
  return e.mode === 'rented' ? `租到 ${n}${e.cost_trx ? `，花 ${e.cost_trx} TRX` : ''}` : `${e.reason ? '租失败，已改烧 TRX' : '烧 TRX'}（约 ${n}）`;
}
const BATCH_ST: Record<string, [string, string]> = {
  awaiting_approval: ['submitted', '待确认'], sending: ['in', '发送中'], sent: ['in', '链上确认中'], confirmed: ['approved', '已完成'],
  partial: ['submitted', '部分成功'], failed: ['needs_info', '失败'], expired: ['expired', '已作废'], cancelled: ['expired', '已取消'],
};
const batchSt = (s: string) => status(...(BATCH_ST[s] || ['submitted', s]));
const SKIP: Record<string, string> = {
  inBatch: '已在别的批次里', otherScheme: '合约参数不是当前这套（由原参数归集）', belowThreshold: '低于门槛，继续攒着',
  overAddressCap: '超过每地址上限：这次不归集，请用冷钱包多签手动处理', feeRatio: '手续费占比太高，先不归集',
};
const ITEM_ST: Record<string, string> = { pending: '待确认', sent: '已发出', swept: '已归集', failed: '失败', released: '放回待归集' };
/** 失败地址的原因（批次详情、邮件里的代码 → 人话） */
const ITEM_REASON: Record<string, string> = {
  reverted: '合约里这个地址归集失败（SweepFailed，例如代币转账被拒）', no_event: '交易成功但没有这个地址的归集记录', tx_reverted: '整笔交易在链上回滚了',
  tx_failed: '交易失败', not_broadcast: '交易没送到节点（发出 15 分钟后节点仍查不到）', send_failed: '节点拒绝了这笔交易', interrupted: '确认后发送时中断（服务重启或节点无响应）',
  expired: '待确认超过 24 小时作废', cancelled: '你选了不归集这批', sweep_failed: '合约里这个地址归集失败',
};
/** 发起账户手续费币的说明（够几批） */
export const gasText = (o: any) => !o?.configured ? '没配置（不能执行归集）' : o.gas === null ? '暂时查不到（节点没响应）' : `${o.gas} ${o.symbol}${o.batches_left !== null && o.batches_left !== undefined ? `（够约 ${o.batches_left} 批）` : ''}`;
/** 第 1 批没有币价来源：手续费占比规则暂不检查 */
export const NO_PRICE_TEXT = '现在没有币价来源，本批暂不按占比检查';

/** 第一屏的大卡片：一句话 + 一个大按钮 */
export function hero(kind: 'ok' | 'warn' | 'bad', title: string, text: string | Node, action?: { label: string; onClick: () => void }) {
  return h('section', { class: `hero-todo hero-${kind}`, 'data-hero': kind },
    h('div', { class: 'stack-sm' }, h('h2', { class: 'm0' }, title), h('p', { class: 'muted m0' }, text)),
    action ? h('button', { type: 'button', class: 'btn btn-primary btn-lg', onclick: action.onClick }, action.label) : null);
}
const kv = (rows: [string, Node | string][]) => h('dl', { class: 'kv' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
/** "x 分钟前估算"；不到 1 分钟写"刚刚估算" */
const estAgo = (iso: string) => (Date.now() - Date.parse(iso) < 60_000 ? '刚刚估算' : `${ago(iso)}前估算`);
const feeLine = (b: any) => b.fee ? `约 ${b.fee.native} ${b.fee.symbol}（${estAgo(b.created_at)}）` : '暂时估不出（节点没响应）';
/** 失败、部分成功的批次是否还要处理：之后这条链没有再凑过批（地址还没被重新列出）就算 */
const unresolved = (b: any, all: any[]) => ['failed', 'partial'].includes(b.status) && !all.some((x) => x.chain === b.chain && Date.parse(x.created_at) > Date.parse(b.created_at));

// ============ 归集 ============
let sweepChain = 'eth';
let recFilter = '';
/** 从概览"去归集"带链过来 */
export const pickSweepChain = (c: string) => { if (c === 'eth' || c === 'bsc') sweepChain = c; };
export async function renderEvmSweep(ui: WalletUi): Promise<HTMLElement> {
  const s = await ui.call('wallet-sweep');
  const on = s.chains.filter((c: any) => c.enabled);
  const waiting = on.flatMap((c: any) => c.batches.filter((b: any) => b.status === 'awaiting_approval')).sort((a: any, b: any) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const moving = on.flatMap((c: any) => c.batches.filter((b: any) => b.status !== 'awaiting_approval'));
  const total = waiting.reduce((x: number, b: any) => x + (parseUsdt(b.total_usdt) ?? 0), 0);
  const next = s.next_slot ? t(s.next_slot) : '—';
  const box = h('div', { class: 'stack', 'data-evm-sweep': '' });
  const recent = await ui.call('wallet-sweep-batches', undefined, '&status=partial,failed').catch(() => null);
  const allRecent = (await ui.call('wallet-sweep-batches').catch(() => null))?.items || [];
  const problems = (recent?.items || []).filter((b: any) => unresolved(b, allRecent));
  const lowGas = on.filter((c: any) => c.operator?.low);

  let top: HTMLElement;
  if (!on.length) top = hero('warn', '以太坊、BSC 还没有开通', '服务器还没有配置节点或合约地址（看"系统状态"每条链的卡片）。配好后这里会显示待归集的地址和批次。');
  else if (lowGas.length) {
    const c = lowGas[0];
    top = hero('bad', `${CHAIN_NAME[c.chain]} 发起账户的 ${c.operator.symbol} 不够付手续费`, `现在有 ${gasText(c.operator)}。钱都还在原地址，没有丢；补够手续费后再确认归集。`, { label: '去补手续费', onClick: () => topUpGas(ui, c) });
  } else if (problems.length) {
    const b = problems[0];
    top = hero('bad', `归集批次 ${b.id} ${b.status === 'partial' ? '部分成功' : '失败了'}`, `${b.status === 'partial' ? '部分地址没归集成功' : b.error === 'interrupted_while_sending' ? '确认后发送时中断' : '交易没有成功'}，失败的地址已放回待归集，下一次凑批会重新列出。钱只会进冷钱包。`, { label: '看批次', onClick: () => batchDetail(ui, b) });
  } else if (waiting.length) {
    const first = waiting[0];
    top = hero('warn', `有 ${waiting.length} 个批次等你确认，合计 ${fmtUsdt(total)} USDT`,
      h('span', {}, `系统按门槛凑好了，邮件已发给你（邮件里没有确认按钮）。钱只会进冷钱包。`, h('b', { class: 'neg' }, ` 最早的已等 ${ago(first.created_at)}`)),
      { label: `去确认第 1 批：${first.id}`, onClick: () => confirmBatch(ui, first) });
  } else if (on.some((c: any) => c.scan_ok === false)) top = hero('bad', `${on.filter((c: any) => c.scan_ok === false).map((c: any) => CHAIN_NAME[c.chain]).join('、')} 扫块不正常`, '到账会晚到，相关的归集先不凑批。看"系统状态"。', { label: '看系统状态', onClick: () => ui.go('p-status') });
  else top = hero('ok', '现在没事要做', `下一次凑批在 ${next}（东八区 ${s.times.join('、')}）；凑好了会发邮件给你，这里也会出现。`);

  // 页内导航
  const sec = (id: string, title: string, right: Node | null, ...kids: Node[]) => h('section', { class: 'stack', id: `sw-${id}` }, h('div', { class: 'toolbar' }, h('h2', { class: 'h-sm m0' }, title), right ? h('div', { class: 'tool-actions' }, right) : null), ...kids);
  const jump = (id: string, label: string) => h('button', { type: 'button', class: 'pill-btn', onclick: () => box.querySelector(`#sw-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, label);

  // 1. 待确认批次（部分成功、失败还没处理的也放在这里）
  const proposeBtns = h('span', { class: 'tool-actions' }, ...on.map((c: any) => h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-propose': c.chain, onclick: () => propose(ui, c.chain) }, `${CHAIN_NAME[c.chain]}：现在就凑一批`)));
  const cards = [...waiting, ...moving, ...problems].map((b: any) => batchCard(ui, b));
  const pending = sec('pending', `待确认批次（${waiting.length}）`, proposeBtns,
    cards.length ? h('div', { class: 'batch-grid' }, ...cards) : h('p', { class: 'muted m0', 'data-empty': '' }, on.length ? `现在没有待确认的批次。下一次凑批在 ${next}，也可以点右上角"现在就凑一批"。` : '还没有开通的链。'));

  // 2. 各链待归集地址
  const chainTabs = h('div', { class: 'seg', role: 'tablist' }, ...s.chains.map((c: any) => h('button', {
    type: 'button', role: 'tab', 'aria-selected': String(sweepChain === c.chain), disabled: !c.enabled, class: sweepChain === c.chain ? 'on' : '', 'data-sweep-tab': c.chain, 'data-chain-tab': c.chain,
    onclick: () => { sweepChain = c.chain; ui.rerender(); },
  }, CHAIN_NAME[c.chain], c.enabled && c.estimate ? h('span', { class: 'tab-count' }, String(c.estimate.address_count)) : null, c.not_in_this_batch ? laterTag() : !c.enabled ? ' （未开通）' : '')));
  const cur = on.find((c: any) => c.chain === sweepChain) || on[0];
  if (cur) sweepChain = cur.chain;
  let addrBody: HTMLElement = h('p', { class: 'muted' }, '没有开通的链。');
  if (cur) {
    const r = await ui.call('wallet-sweep-addresses', undefined, `&chain=${cur.chain}`).catch(() => null);
    const th = parseUsdt(cur.threshold_usdt) ?? 0;
    const stateOf = (x: any) => x.in_batch ? status('in', `在批次 ${x.in_batch_id || ''} 里`)
      : x.skip_reason && x.skip_reason !== 'belowThreshold' ? h('span', { class: 'cell-2' }, status('needs_info', '上次凑批跳过'), h('span', { class: 'hint muted' }, SKIP[x.skip_reason] || x.skip_reason))
      : x.status === 'retired' ? status('expired', '旧地址（停用，照常归集）')
      : (parseUsdt(x.pending_usdt) ?? 0) >= th ? status('submitted', '达到门槛，等下次凑批') : status('expired', '低于门槛，继续攒着');
    addrBody = h('div', { class: 'stack' },
      h('div', { class: 'stats' },
        stat('未归集合计（估算）', usd(cur.estimate.total_usdt), `USDT · ${cur.estimate.address_count} 个地址`),
        stat(`达到门槛（${usd(cur.threshold_usdt)}）`, String(cur.estimate.over_threshold), `个地址 · ${usd(cur.estimate.over_threshold_usdt)} USDT`),
        h('div', { class: `stat${cur.operator?.low ? ' stat-bad' : ''}`, 'data-gas-card': cur.chain }, h('div', { class: 'k' }, cur.chain === 'tron' ? '发起账户 TRX' : '发起账户手续费币'), h('div', { class: 'v v-sm' }, gasText(cur.operator)),
          h('div', { class: 's' }, cur.chain === 'tron' ? '租不到能量时烧 TRX 用 ' : '只付手续费，转不走钱 ', cur.operator?.configured ? h('button', { type: 'button', class: `link-btn${cur.operator.low ? '' : ' link-plain'}`, onclick: () => topUpGas(ui, cur) }, '补手续费') : null)),
        // 第 2 批 TRON：发起账户能量、TronSave 预存余额
        cur.chain === 'tron' ? stat('发起账户能量', cur.operator?.energy == null ? '—' : Number(cur.operator.energy).toLocaleString('en'), '每批确认时先租一次能量') : null,
        cur.chain === 'tron' ? stat('TronSave 预存余额', cur.operator?.rental_prepaid_trx == null ? '—' : `${cur.operator.rental_prepaid_trx} TRX`, '充值由你自己在 TronSave 做；明细在"系统状态"') : null),
      cur.chain === 'tron' ? h('p', { class: 'hint muted m0' }, 'TRON 每批最多 20 个地址（Nile 实测后再定）；第一次归集的地址要先部署，手续费高些。') : null,
      r ? table(['收款地址', '客户 · 商户', '待归集 USDT（估算）', '首次归集', '状态'], r.items.map((x: any) => [
        mono(shortAddr(x.address), x.address), h('span', { class: 'cell-2' }, mono(x.customer_id), h('span', { class: 'hint muted' }, x.merchant)), usd(x.pending_usdt),
        x.first_sweep ? '是（要先部署，手续费高些）' : '不是', stateOf(x),
      ]), '这条链上现在没有待归集的钱。', { page: { size: 20, more: (n) => `显示更多（还有 ${n} 个）` } }) : h('p', { class: 'alert' }, '地址列表读取失败，请稍后重试。'),
      h('p', { class: 'hint muted m0' }, '这里按账本估算（到账合计 − 已归集）；凑批时系统向链上查实际余额，门槛以下的继续攒着。"上次凑批跳过"是最近一次凑批时跳过的原因。'));
  }
  const addrs = sec('addresses', '各链待归集地址', null, chainTabs, addrBody);

  // 3. 批次记录
  const recs = await ui.call('wallet-sweep-batches', undefined, recFilter ? `&status=${recFilter}` : '').catch(() => null);
  const filters = h('div', { class: 'seg' }, ...[['', '全部'], ['awaiting_approval,sending,sent', '进行中'], ['partial,failed', '有问题'], ['confirmed', '已完成'], ['expired,cancelled', '作废 / 取消']].map(([v, l]) =>
    h('button', { type: 'button', class: recFilter === v ? 'on' : '', 'aria-pressed': String(recFilter === v), onclick: () => { recFilter = v; ui.rerender(); } }, l)));
  const rows = recs?.items || [];
  const records = sec('records', '批次记录', filters,
    recs ? table(['批次', '链', '地址', '金额 USDT', '手续费估算', '状态', '时间'], rows.map((b: any) => [mono(b.id), chainTag(b.chain), String(b.address_count), usd(b.total_usdt), b.fee ? `约 ${b.fee.native} ${b.fee.symbol}` : '—', batchSt(b.status), t(b.created_at)]),
      '还没有批次。', { onRow: (i) => batchDetail(ui, rows[i]) }) : h('p', { class: 'alert' }, '批次记录读取失败，请稍后重试。'),
    h('p', { class: 'hint muted m0' }, '点一行看每个地址的结果、失败原因和链上交易。'));

  // 4. 门槛和上限
  const st = s.settings;
  const settings = sec('settings', '门槛和上限', h('span', { class: 'muted' }, '后台可改：要输动态码、写原因、记审计'),
    h('div', { class: 'card stack' },
      kv([
        ['归集门槛', h('span', {}, `以太坊 ${usd(st.thresholds.eth)} · BSC ${usd(st.thresholds.bsc)} · TRON ${usd(st.thresholds.tron)} `, laterTag(), ' USDT（地址余额达到才放进批次）')],
        ['每个地址每次上限', `${usd(st.capPerAddress)} USDT（超过的这次跳过，用冷钱包多签手动处理）`],
        ['每批上限', `${usd(st.capPerBatch)} USDT、${st.maxAddresses} 个地址（超过就自动拆成几批）`],
        ['手续费占比', h('span', {}, `一个地址的手续费超过金额的 ${st.maxFeeRatioPct}% 就先不归集。`, h('b', { 'data-no-price': '' }, `${NO_PRICE_TEXT}。`))],
        ['凑批时间', `每天 ${s.times.join('、')}（东八区）；待确认超过 ${s.expire_hours} 小时作废，下一轮重凑`],
      ]),
      h('div', {}, h('button', { type: 'button', class: 'btn btn-outline', 'data-edit-settings': '', onclick: () => editSettings(ui, st) }, '修改门槛和上限'))));

  box.append(top, h('nav', { class: 'seg seg-nav', 'aria-label': '归集页内导航' }, jump('pending', `待确认批次（${waiting.length}）`), jump('addresses', '各链待归集地址'), jump('records', '批次记录'), jump('settings', '门槛和上限')), pending, addrs, records, settings);
  return box;
}

function batchCard(ui: WalletUi, b: any) {
  const waiting = b.status === 'awaiting_approval';
  const skipped = b.skipped?.length || 0;
  const notSent = waiting && String(b.error || '').startsWith('not_sent');
  return h('article', { class: 'card batch-card stack-sm', 'data-batch': b.id },
    h('div', { class: 'batch-head' }, chainTag(b.chain), h('b', { class: 'mono' }, b.id), batchSt(b.status)),
    h('div', { class: 'batch-amt' }, usd(b.total_usdt), h('small', {}, ' USDT')),
    kv([
      ['地址', `${b.address_count} 个地址${b.chain === 'tron' && b.items?.length ? ` · ${b.items.filter((i: any) => i.deploy).length} 个要先部署` : ''}${skipped ? `（另有 ${skipped} 个跳过）` : ''}`],
      ...(b.chain === 'tron' ? [['能量', h('span', { 'data-energy-line': '' }, b.status === 'awaiting_approval' && !b.energy?.mode ? '确认后才租（租不到改烧 TRX）' : energyLine(b.energy))] as [string, Node]] : []),
      ['手续费估算', feeLine(b)],
      ['去向', '冷钱包（写死在合约里）'],
      [waiting ? '等了' : '确认人', waiting ? h('span', { class: 'neg' }, ago(b.created_at)) : `${b.approved_by || '—'} · ${t(b.approved_at)}`],
    ]),
    b.split_of > 1 ? h('p', { class: 'hint muted m0', 'data-split': '' }, `超过每批上限，系统分成了 ${b.split_of} 批`) : null,
    notSent ? h('p', { class: 'warn-box m0' }, '上次点确认时节点连不上：没有提交，钱没动。可以再点一次。') : null,
    b.status === 'partial' ? h('p', { class: 'warn-box m0' }, '部分成功：失败的地址已放回待归集，下一次凑批会重新列出。点"看明细"看原因。') : null,
    b.status === 'failed' ? h('p', { class: 'alert m0' }, `失败：${b.error === 'interrupted_while_sending' ? '确认后发送时中断' : b.error === 'broadcast_uncertain' ? '交易没送到节点' : '交易没有成功'}。地址已放回待归集。`) : null,
    b.status === 'sent' && b.error === 'broadcast_uncertain' ? h('p', { class: 'warn-box m0' }, '发送时节点没响应：交易可能已经发出，系统按交易号继续查；15 分钟后还查不到就标失败、地址放回。') : null,
    waiting ? h('div', { class: 'stack-sm' },
      h('button', { type: 'button', class: 'btn btn-primary', 'data-confirm': b.id, onclick: () => confirmBatch(ui, b) }, '核对并确认'),
      h('button', { type: 'button', class: 'link-btn bad', onclick: () => cancelBatch(ui, b) }, '不归集这批'))
      : ['partial', 'failed'].includes(b.status) ? h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => batchDetail(ui, b) }, '看明细')
      : h('p', { class: 'hint muted m0' }, b.tx_refs?.length ? h('span', {}, '交易 ', mono(shortAddr(b.tx_refs[0]), b.tx_refs[0]), '，worker 每 15 秒查一次结果') : '正在发送……'));
}

function itemsTable(b: any) {
  return table(['地址', '金额', '首次归集', '结果'], b.items.map((i: any) => [mono(shortAddr(i.address), i.address), usd(i.amount_usdt), i.deploy ? '是（要先部署，手续费高些）' : '不是',
    i.reason && i.status === 'released' ? h('span', { class: 'cell-2' }, h('span', { class: i.reason === 'cancelled' || i.reason === 'expired' ? '' : 'bad' }, ITEM_ST[i.status]), h('span', { class: 'hint muted' }, ITEM_REASON[i.reason] || i.reason)) : ITEM_ST[i.status] || i.status]), '没有地址');
}
function skippedTable(b: any) {
  return table(['地址', '余额', '原因'], (b.skipped || []).map((x: any) => [mono(shortAddr(x.address), x.address), usd(x.amount_usdt), SKIP[x.reason] || x.reason]), '没有跳过的地址');
}
/** 三步：核对 → 确认执行 → 看链上结果（做完的打勾） */
const steps = (n: number) => h('ol', { class: 'stepper-3', 'data-steps': String(n) }, ...['核对', '确认执行', '看链上结果'].map((x, i) => h('li', { class: i + 1 < n ? 'done' : i + 1 === n ? 'on' : '' }, x)));

/** 第 3 步：交易号 + 链上确认数 x / 12，每 5 秒刷新，弹窗关掉就停 */
function watchConfirmations(ui: WalletUi, id: string, txRef: string, uncertain: boolean, body: HTMLElement) {
  const conf = h('span', { 'data-conf': '' }, '查询中……');
  const bar = h('progress', { max: '1', value: '0', class: 'conf-bar' }) as HTMLProgressElement;
  const dlg = document.querySelector<HTMLDialogElement>('[data-pdialog]');
  body.replaceChildren(steps(3),
    uncertain ? h('p', { class: 'warn-box m0' }, '发送时节点没响应：交易已签名、可能已经发出。系统按下面的交易号继续查；15 分钟后还查不到就标为失败、地址放回待归集。钱只会进冷钱包。')
      : h('p', { class: 'info-box m0' }, h('b', { class: 'ok-title' }, '已发出一笔交易。'), ' 已提交到链上。你可以关掉这个窗口，结果会出现在"批次记录"里；部分地址失败会放回待归集并发邮件，不会自动重试。'),
    kv([['交易', mono(txRef || '—')], ['链上确认数', h('span', { class: 'stack-sm' }, conf, bar)]]));
  const tick = async () => {
    if (!dlg?.open || !body.isConnected) return;
    try {
      const b = await ui.call('wallet-sweep-batch', undefined, `&id=${encodeURIComponent(id)}`);
      const c = b.confirmations;
      if (b.status === 'confirmed') { conf.textContent = '已完成：全部地址归集进冷钱包'; bar.value = 1; ui.rerender(); return; }
      if (b.status === 'partial' || b.status === 'failed') { conf.textContent = b.status === 'partial' ? '部分成功：失败的地址已放回待归集' : '失败：地址已放回待归集'; conf.className = 'neg'; ui.rerender(); return; }
      if (c && c.need) { conf.textContent = `链上确认数 ${Math.min(c.have ?? 0, c.need)} / ${c.need}${c.have === null ? '（节点暂时没响应）' : ''}`; bar.value = Math.min(1, (c.have ?? 0) / c.need); }
      else conf.textContent = c?.have ? '已上链，等 worker 确认结果' : '等上链……';
    } catch { conf.textContent = '暂时查不到，稍后自动重试'; }
    setTimeout(tick, 5000);
  };
  tick();
}

function confirmBatch(ui: WalletUi, b: any) {
  // 原因选填：预填"例行归集"，清空了也按"例行归集"记审计
  const reason = h('input', { maxlength: '200', value: '例行归集' }) as HTMLInputElement;
  const caps = (parseUsdt(b.total_usdt) ?? 0);
  const maxOne = Math.max(0, ...b.items.map((i: any) => parseUsdt(i.amount_usdt) ?? 0));
  const notice = h('div', { 'data-confirm-notice': '' });
  const okText = `确认归集 ${b.address_count} 个地址（${usd(b.total_usdt)} USDT）`;
  const body = h('div', { class: 'stack' },
    h('p', { class: 'muted m0' }, '第 1 步 / 共 3 步：看清楚再点确认。确认后系统用发起账户发一笔交易。'),
    steps(1),
    kv([
      ['链', chainTag(b.chain)],
      ['归集', h('b', {}, `${b.address_count} 个地址，合计 ${usd(b.total_usdt)} USDT`)],
      ['钱去哪', h('span', {}, '冷钱包（parent）', h('br'), h('span', { class: 'hint muted' }, '写死在合约里，系统和服务器都改不了'))],
      ['手续费估算', b.fee ? h('span', {}, `约 ${b.fee.native} ${b.fee.symbol}${b.fee.gas ? `（${Number(b.fee.gas).toLocaleString('en')} gas）` : ''}`, h('br'), h('span', { class: 'hint muted', 'data-fee-age': '' }, `${estAgo(b.created_at)}（凑批时）；实际按发送时的价格`)) : '暂时估不出'],
      ['谁付手续费', '发起账户（服务器上，只能付手续费、转不走钱）'],
    ]),
    h('ul', { class: 'wl-checks bullets' },
      h('li', {}, `每个地址都没超过每地址上限（这批最大 ${fmtUtil(maxOne)}）`),
      h('li', {}, `这批合计 ${fmtUtil(caps)}，没超过每批上限`),
      h('li', { 'data-no-price': '' }, `手续费占比：${NO_PRICE_TEXT}`),
      h('li', {}, `凑批时间 ${t(b.created_at)}；${t(b.expires_at)} 前不确认就作废`)),
    b.split_of > 1 ? h('p', { class: 'hint muted m0' }, `超过每批上限，系统分成了 ${b.split_of} 批；每批一笔交易，分别确认。`) : null,
    b.chain === 'tron' ? h('p', { class: 'info-box m0' }, '确认后先租能量，租不到按约定改烧 TRX，不再问你；TRX 也不够时不提交，钱不动。') : null,
    h('details', { open: true }, h('summary', {}, `这批的 ${b.address_count} 个地址`), itemsTable(b)),
    b.skipped?.length ? h('details', {}, h('summary', {}, `跳过的 ${b.skipped.length} 个地址和原因`), skippedTable(b)) : null,
    field('sw-reason', '原因（选填，记进审计）', reason), notice);
  ui.dialog(`确认归集 ${b.id}`, body, okText, async () => {
    const btn = document.querySelector<HTMLButtonElement>('[data-pdialog-ok]');
    if (btn) { btn.disabled = true; btn.textContent = '发送中……'; }
    notice.replaceChildren();
    try {
      const r = await ui.call('wallet-sweep-approve', { id: b.id, reason: reason.value.trim() || '例行归集' });
      if (btn) btn.disabled = false;
      ui.rerender();
      ui.dialog(`归集 ${b.id}`, body, '关掉，后台继续', null, false, true);
      watchConfirmations(ui, b.id, r.txRefs?.[0] || '', r.broadcast === 'uncertain', body);
      return false;
    } catch (e: any) {
      if (btn) { btn.disabled = false; btn.textContent = okText; }
      if (e?.code === 'sweep_not_sent') {
        // 节点连不上、没发出：不是成功，单独提示"没有提交，钱没动"，批次还是待确认
        notice.replaceChildren(h('div', { class: 'warn-box', 'data-not-sent': '' }, h('b', {}, '没有提交，钱没动。'), ' 节点暂时连不上，交易没有发出；这批仍是"待确认"，稍后再点一次即可。'));
        notice.scrollIntoView?.({ block: 'nearest' });
        ui.say(ERR.sweep_not_sent);
        return false;
      }
      if (e?.code === 'energy_and_trx_insufficient') {
        notice.replaceChildren(h('div', { class: 'alert', 'data-not-sent': '' }, h('b', {}, '没提交，钱没动。'), ' TronSave 没响应、发起账户的 TRX 也不够烧。给发起账户补 TRX 或给 TronSave 充值后再确认。'));
        return false;
      }
      ui.say(err(ui, e));
      if (['batch_state', 'batch_expired', 'sweep_send_failed'].includes(e?.code)) { ui.rerender(); return true; }
      return false;
    }
  });
}
const fmtUtil = (u: number) => `${fmtUsdt(u)} USDT`;

/** 补手续费：显示发起账户地址（公开地址）、现在有多少、建议转多少；转账由管理员在自己的钱包里做 */
function topUpGas(ui: WalletUi, c: any) {
  const o = c.operator || {};
  const sym = o.symbol || '';
  ui.dialog(`给 ${CHAIN_NAME[c.chain]} 发起账户补手续费`, h('div', { class: 'stack' },
    h('ol', { class: 'stepper-3' }, h('li', { class: 'on' }, '复制地址'), h('li', {}, `从你自己的钱包转 ${sym}`), h('li', {}, '回来刷新检查')),
    kv([
      ['发起账户', o.address ? h('span', { class: 'copy-row' }, mono(o.address), copyBtn(() => o.address, '复制地址', '已复制')) : '—'],
      ['现在有', h('b', { class: o.low ? 'neg' : '' }, gasText(o))],
    ]),
    h('p', { class: 'info-box m0' }, '这个账户只能付手续费，钱只能进冷钱包。转账由你在自己的钱包里操作，TopUP 不碰你的私钥。')),
    '我转好了，刷新检查', () => { ui.rerender(); });
}

function cancelBatch(ui: WalletUi, b: any) {
  const reason = h('input', { maxlength: '200', placeholder: '例如：手续费太高，等明天' }) as HTMLInputElement;
  ui.dialog(`不归集 ${b.id}？`, h('div', { class: 'stack' }, h('p', { class: 'm0' }, '这批作废，里面的地址放回待归集，下一次凑批会重新列出。'), field('sw-cancel-reason', '原因（必填）', reason)), '不归集这批', async () => {
    if (fieldErr(reason, reason.value.trim() ? null : '请填写原因')) return false;
    try { await ui.call('wallet-sweep-cancel', { id: b.id, reason: reason.value.trim() }); ui.say(`${b.id} 已作废，地址放回待归集`); ui.rerender(); }
    catch (e) { ui.say(err(ui, e)); return false; }
  }, true);
}

async function propose(ui: WalletUi, chain: string) {
  try {
    const r = await ui.call('wallet-sweep-propose', { chain });
    ui.say(r.batches.length ? `${CHAIN_NAME[chain]}：现在有 ${r.batches.length} 批等你确认` : `${CHAIN_NAME[chain]}：没有达到门槛的地址，没有凑出批次`);
    ui.rerender();
  } catch (e) { ui.say(err(ui, e)); }
}

async function batchDetail(ui: WalletUi, b0: any) {
  const b = await ui.call('wallet-sweep-batch', undefined, `&id=${encodeURIComponent(b0.id)}`).catch(() => b0);
  const failed = (b.items || []).filter((i: any) => i.status === 'released' && i.reason && !['cancelled', 'expired'].includes(i.reason));
  ui.dialog(`批次 ${b.id}`, h('div', { class: 'stack' },
    kv([['链', chainTag(b.chain)], ['状态', batchSt(b.status)], ['合计', `${usd(b.total_usdt)} USDT · ${b.address_count} 个地址`], ['凑批', `${t(b.created_at)}${b.split_of > 1 ? `（超过每批上限，系统分成了 ${b.split_of} 批）` : ''}`],
      ['确认', b.approved_by ? `${b.approved_by} · ${t(b.approved_at)} · ${b.reason || ''}` : b.reason ? `原因：${b.reason}` : '—'], ['交易', b.tx_refs?.length ? mono(b.tx_refs.join('、')) : '—'],
      ...(b.confirmations?.need ? [['链上确认数', `${b.confirmations.have ?? '—'} / ${b.confirmations.need}`] as [string, string]] : []),
      ['出错', b.error ? ERR_TEXT[b.error] || (String(b.error).startsWith('not_sent') ? '上次点确认时节点连不上，没有提交，钱没动' : b.error) : '—']]),
    failed.length ? h('p', { class: 'alert m0' }, `${failed.length} 个地址失败，原因写在下表"结果"一列。`) : null,
    itemsTable(b), b.skipped?.length ? h('details', {}, h('summary', {}, `跳过的 ${b.skipped.length} 个地址`), skippedTable(b)) : null,
    b.status === 'partial' || b.status === 'failed' ? h('p', { class: 'note-box m0' }, '失败的地址已放回待归集，不会自动重试；下一次凑批会重新列出，仍要你确认。') : null), '关闭', null, false, true);
}
const ERR_TEXT: Record<string, string> = { interrupted_while_sending: '确认后发送时中断（服务重启或节点无响应），已标失败', broadcast_uncertain: '发送时节点没响应，按交易号继续查' };

function editSettings(ui: WalletUi, st: any) {
  const inp = (v: string | number) => h('input', { inputmode: 'decimal', value: String(v), class: 'input-sm' }) as HTMLInputElement;
  const f = { eth: inp(st.thresholds.eth), bsc: inp(st.thresholds.bsc), tron: inp(st.thresholds.tron), capPerAddress: inp(st.capPerAddress), capPerBatch: inp(st.capPerBatch), maxAddresses: inp(st.maxAddresses), maxFeeRatioPct: inp(st.maxFeeRatioPct) };
  const reason = h('input', { maxlength: '200' }) as HTMLInputElement;
  const code = h('input', { inputmode: 'numeric', maxlength: '6', autocomplete: 'one-time-code' }) as HTMLInputElement;
  const errBox = h('p', { class: 'alert', hidden: true });
  const body = h('div', { class: 'stack' },
    h('div', { class: 'fgrid' }, field('ss-eth', '以太坊门槛（USDT）', f.eth), field('ss-bsc', 'BSC 门槛（USDT）', f.bsc), field('ss-tron', 'TRON 门槛（USDT，第 2 批用）', f.tron),
      field('ss-cap1', '每个地址每次上限（USDT，0 = 不限）', f.capPerAddress), field('ss-capb', '每批上限（USDT，0 = 不限）', f.capPerBatch), field('ss-maxa', '每批最多地址数（1–200）', f.maxAddresses),
      field('ss-fee', '手续费占比上限（%）', f.maxFeeRatioPct)),
    h('p', { class: 'hint muted m0' }, `手续费占比：${NO_PRICE_TEXT}；有币价来源后按这里的上限检查。`),
    field('ss-reason', '原因（必填，记进审计）', reason), field('ss-code', '验证器动态码（6 位）', code), errBox);
  ui.dialog('修改门槛和上限', body, '保存', async () => {
    const money = (i: HTMLInputElement) => fieldErr(i, parseUsdt(i.value) === null ? '请填金额，最多 6 位小数' : null);
    let bad = [f.eth, f.bsc, f.tron, f.capPerAddress, f.capPerBatch].map(money).some(Boolean);
    bad = fieldErr(f.maxAddresses, /^\d+$/.test(f.maxAddresses.value) && +f.maxAddresses.value >= 1 && +f.maxAddresses.value <= 200 ? null : '填 1 到 200 的整数') || bad;
    bad = fieldErr(f.maxFeeRatioPct, f.maxFeeRatioPct.value !== '' && +f.maxFeeRatioPct.value >= 0 && +f.maxFeeRatioPct.value <= 100 ? null : '填 0 到 100') || bad;
    bad = fieldErr(reason, reason.value.trim() ? null : '请填写原因') || bad;
    bad = fieldErr(code, /^\d{6}$/.test(code.value) ? null : '请输入 6 位动态码') || bad;
    if (bad) return false;
    try {
      await ui.call('wallet-sweep-settings-save', { reason: reason.value.trim(), code: code.value, values: { thresholds: { eth: f.eth.value, bsc: f.bsc.value, tron: f.tron.value }, capPerAddress: f.capPerAddress.value, capPerBatch: f.capPerBatch.value, maxAddresses: Number(f.maxAddresses.value), maxFeeRatioPct: Number(f.maxFeeRatioPct.value) } });
      ui.say('已保存，下一次凑批按新的门槛和上限。'); ui.rerender();
    } catch (e: any) {
      errBox.hidden = false; errBox.textContent = err(ui, e);
      if (e?.code === 'bad_code') fieldErr(code, '动态码不对');
      return false;
    }
  });
}

// ============ 钱包提供方 ============
const PROVIDER_NAME: Record<string, string> = { contract: '合约钱包', cobo: 'Cobo', fireblocks: 'Fireblocks', legacy_hd: '助记词地址（第 0 批）' };
export async function renderRoutes(ui: WalletUi, p: HTMLElement) {
  const r = await ui.call('wallet-routes');
  const canSwitch = (c: any) => r.providers.some((x: any) => x.enabled && x.id !== c.provider);
  const count = (c: any, st: string) => c.addresses.filter((a: any) => a.status === st).reduce((s: number, a: any) => s + a.address_count, 0);
  p.replaceChildren(
    h('div', { class: 'toolbar' }, h('h1', { class: 'm0' }, '钱包提供方'), h('span', { class: 'muted' }, '谁来管收款地址里的钱 · 按链整体切换')),
    hero('ok', '现在没事要做', '以太坊、BSC 都用合约钱包。只有在要换一家托管方（例如 Cobo）时才来这里；换之前要先开账号、实测。'),
    h('h2', { class: 'h-sm' }, '每条链现在用谁'),
    table(['链', '现在用', '收款地址', ''], r.chains.map((c: any) => [
      h('span', {}, chainTag(c.chain), c.not_in_this_batch ? laterTag() : ''),
      h('span', {}, PROVIDER_NAME[c.provider] || c.provider, c.provider === 'contract' ? h('span', { class: 'muted' }, '（默认）') : ''),
      c.not_in_this_batch ? '—' : `${count(c, 'active')} 个在用${count(c, 'retired') ? ` · ${count(c, 'retired')} 个停用（照常入账、归集）` : ''}`,
      c.not_in_this_batch ? laterTag() : h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-switch': c.chain, disabled: !canSwitch(c), title: canSwitch(c) ? '' : '现在没有别的已接入的提供方可以切换', onclick: () => switchProvider(ui, c, r.providers) }, `切换 ${CHAIN_NAME[c.chain]} 的提供方`),
    ]), '—'),
    r.chains.some((c: any) => !c.not_in_this_batch && !canSwitch(c)) ? h('p', { class: 'note-box', 'data-switch-why': '' }, '切换按钮现在不能点：除了合约钱包，还没有别的已接入的提供方。Cobo、Fireblocks 要先开账号、用真账号实测后才能接入。') : null,
    h('p', { class: 'hint muted' }, '切换只影响新分配的地址；老地址不变，继续扫链、入账，由原提供方归集。商户余额在 TopUP 自己的账本里，切换不动账本。'),
    h('h2', { class: 'h-sm' }, '可选的提供方'),
    h('div', { class: 'batch-grid' }, ...r.providers.map((x: any) => h('article', { class: 'card stack-sm' },
      h('div', { class: 'batch-head' }, h('b', {}, PROVIDER_NAME[x.id] || x.id), x.enabled ? status('approved', '已接入') : status('expired', '未接入')),
      h('p', { class: 'muted m0' }, x.id === 'contract' ? '智能合约钱包：自己扫链、批量归集；钱只能进冷钱包。' : '要先开账号、用真账号实测额度和回调签名后才能接入。现在不能选。')))),
    h('h2', { class: 'h-sm' }, '切换记录（审计）'),
    table(['时间', '谁', '做了什么', '原因'], r.history.map((x: any) => [t(x.effective_from), x.actor, `${CHAIN_NAME[x.chain]} 改用 ${PROVIDER_NAME[x.provider] || x.provider}`, x.reason]), '还没有切换过。三条链从上线起都用合约钱包。'));
}

function switchProvider(ui: WalletUi, c: any, providers: any[]) {
  const opts = providers.filter((x) => x.id !== c.provider);
  const sel = h('select', {}, ...opts.map((x) => h('option', { value: x.id, disabled: !x.enabled }, `${PROVIDER_NAME[x.id] || x.id}${x.enabled ? '' : '（未接入）'}`))) as HTMLSelectElement;
  const reason = h('input', { maxlength: '200' }) as HTMLInputElement;
  const code = h('input', { inputmode: 'numeric', maxlength: '6', autocomplete: 'one-time-code' }) as HTMLInputElement;
  const none = !opts.some((x) => x.enabled);
  const errBox = h('p', { class: 'alert', hidden: true });
  const body = h('div', { class: 'stack' },
    none ? h('p', { class: 'note-box m0' }, '现在没有别的已接入的提供方可以切换。Cobo、Fireblocks 要先开账号、实测后接入。') : null,
    field('rt-provider', `${CHAIN_NAME[c.chain]} 改用`, sel),
    h('ul', { class: 'wl-checks bullets' }, h('li', {}, '新客户、以及"更换地址"的老客户，从新提供方拿地址'), h('li', {}, '老地址不变：继续扫链、照常入账，钱由原提供方归集'), h('li', {}, '商户余额不动（在 TopUP 自己的账本里）')),
    field('rt-reason', '原因（必填，记进审计）', reason), field('rt-code', '验证器动态码（6 位）', code), errBox);
  ui.dialog(`切换 ${CHAIN_NAME[c.chain]} 的提供方`, body, '确认切换', async () => {
    if (none) return false;
    let bad = fieldErr(reason, reason.value.trim() ? null : '请填写原因');
    bad = fieldErr(code, /^\d{6}$/.test(code.value) ? null : '请输入 6 位动态码') || bad;
    if (bad) return false;
    try { await ui.call('wallet-route-set', { chain: c.chain, provider: sel.value, reason: reason.value.trim(), code: code.value }); ui.say('已切换。新分配的地址从新提供方拿。'); ui.rerender(); }
    catch (e: any) { errBox.hidden = false; errBox.textContent = err(ui, e); if (e?.code === 'bad_code') fieldErr(code, '动态码不对'); return false; }
  });
  // 没有可选的提供方：确认按钮禁用（选项也都是灰的）
  const ok = document.querySelector<HTMLButtonElement>('[data-pdialog-ok]');
  if (ok && none) { ok.disabled = true; ok.title = '现在没有别的已接入的提供方'; }
  if (none) { sel.disabled = true; reason.disabled = true; code.disabled = true; }
}

// ============ 系统状态：每条链一张卡 ============
const CONTRACT_NAME: Record<string, string> = { factory: '转发合约工厂（ForwarderFactory）', implementation: '转发合约实现（Forwarder）', batcher: '批量归集合约（SweepBatcher）', parent: '冷钱包（parent，多签）' };
export async function walletStatus(ui: WalletUi): Promise<HTMLElement> {
  let r: any;
  try { r = await ui.call('wallet-chains', undefined, '&verify=1'); } catch (e) { return h('div', { class: 'alert', 'data-load-error': '' }, `每条链的状态读取失败：${err(ui, e)} `, h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => ui.rerender() }, '重试')); }
  const evm = r.chains.filter((c: any) => c.status !== 'not_in_this_batch');
  const bad = evm.filter((c: any) => !c.ok);
  const words = (c: any) => c.status === 'not_configured' ? `少 ${missing(c)} 项配置` : c.status === 'onchain_mismatch' ? '合约参数和链上不一致（已停用）' : c.status === 'scan_stalled' ? '扫块停了' : c.status === 'catching_up' ? '补扫追赶中' : '正常';
  const top = bad.length
    ? hero('bad', bad.map((c: any) => `${CHAIN_NAME[c.chain]}${words(c)}`).join('，'), '扫块停了到账会晚到（恢复后从停下的区块接着扫，不会漏账）；少配置、合约参数和链上不一致的链不能分配地址、不能归集。')
    : hero('ok', '每条链都正常', '扫块、合约地址配置、链上合约参数核对都正常。');
  const ck = (ok: boolean, text: string) => h('li', { class: ok ? 'y' : 'bad' }, `${text}：${ok ? '已配置' : '没配置'}`);
  const ONCHAIN: Record<string, [string, string]> = { ok: ['y', '一致'], mismatch: ['bad', '不一致（这条链已停用，需重新部署后重启；已发邮件）'], unverified: ['bad', '还没核对上（节点连不上，下一轮再核对）'] };
  const cards = r.chains.map((c: any) => c.status === 'not_in_this_batch'
    ? h('article', { class: 'card stack-sm chain-card later', 'data-chain-card': c.chain }, h('div', { class: 'batch-head' }, chainTag(c.chain), laterTag()), h('p', { class: 'muted m0' }, '第 1 批不分配新的 TRON 地址；已有的 TRON 地址照常入账（上面"链上监控"）。第 2 批上线后这里同样显示扫块和合约配置。'))
    : h('article', { class: `card stack-sm chain-card${c.ok ? '' : ' chain-bad'}`, 'data-chain-card': c.chain },
      h('div', { class: 'batch-head' }, chainTag(c.chain), c.ok ? status(c.status === 'catching_up' ? 'in' : 'approved', words(c)) : badStatus(words(c))),
      h('h3', { class: 'h-sm m0' }, '扫块'),
      kv([
        ['最后一次扫块', c.scan.age_s === null ? h('span', { class: 'neg' }, '还没扫过') : h('span', { class: c.scan.ok ? '' : 'neg' }, c.scan.age_s < 120 ? `${c.scan.age_s} 秒前` : `${Math.round(c.scan.age_s / 60)} 分钟前${c.scan.ok ? '' : '（停了）'}`)],
        ['落后', c.scan.lag_blocks === null ? '—' : `${c.scan.lag_blocks} 个区块（要 ${c.confirmations} 个确认）`],
      ]),
      !c.scan.ok && c.scan.age_s !== null ? h('p', { class: 'alert m0' }, '节点连不上或 worker 没在跑：系统每轮重连，已发邮件给你；恢复后从停下的区块接着扫，不会漏账。') : null,
      h('h3', { class: 'h-sm m0' }, '合约地址配置'),
      h('ul', { class: 'wl-checks' }, ck(c.rpc, '节点'), ck(c.usdt, 'USDT 合约'), ...Object.entries(CONTRACT_NAME).map(([k, v]) => ck(c.contracts[k], v)),
        c.onchain ? h('li', { class: (ONCHAIN[c.onchain] || ONCHAIN.unverified)[0], 'data-onchain': c.onchain }, `链上核对（批量合约的冷钱包、工厂）：${(ONCHAIN[c.onchain] || ONCHAIN.unverified)[1]}${c.onchain_fields?.length ? `：${c.onchain_fields.join('、')}` : ''}`) : null,
        h('li', { class: c.operator.configured && !c.operator.low ? 'y' : 'bad' }, `发起账户（只付手续费）：${c.operator.configured ? `已配置${c.operator.gas !== null ? `，余额 ${gasText(c.operator)}` : ''}${c.operator.low ? '，不够了' : ''}` : '没配置（不能执行归集）'}`)),
      c.config_error === 'onchain_mismatch' ? h('p', { class: 'alert m0' }, '链上批量合约的参数和 config/wallets.json 不一致，这条链已停用（不分配新地址、不凑批、到账暂停入账）。核对配置后走 PR 重新部署，重启服务后才会再核对、恢复。')
        : c.config_error ? h('p', { class: 'alert m0' }, '合约参数检查没通过（例如冷钱包等于批量合约），这条链先不开通。') : null,
      h('p', { class: 'hint muted m0' }, '只显示"是否已配置"，不显示具体值。')));
  const rental = r.chains.find((c: any) => c.chain === 'tron' && c.energy_rental)?.energy_rental;
  const ORDER_ST: Record<string, string> = { filled: '租到了', timeout: '超时没租到（改烧 TRX）', burn: '改烧 TRX' };
  const rentalBox = rental ? h('section', { class: 'card stack-sm', 'data-energy-rental': '' }, h('h2', { class: 'h-sm m0' }, 'TRON 能量租用（TronSave）'),
    kv([
      ['预存余额', rental.prepaid_trx === null ? '查不到' : h('span', rental.low ? { class: 'bad', 'data-low': '' } : {}, `${rental.prepaid_trx} TRX${rental.low ? '（不够租一批，请充值）' : ''}`)],
      ['本月花费', `${rental.month_cost_trx ?? '0'} TRX`], ['本月改烧 TRX', `${rental.burn_count} 次`], ['租价', `每单位能量最多 ${rental.unit_price_sun} sun`],
    ]),
    table(['订单', '归集批次', '状态', '能量', '花费', '时间'], (rental.orders || []).map((o: any) => [o.order_id ? mono(o.order_id) : '—', mono(o.batch_id || '—'), ORDER_ST[o.status] || o.status, o.energy ? Number(o.energy).toLocaleString('en') : '—', o.cost_trx ? `${o.cost_trx} TRX` : '—', t(o.at)]), '本月还没有租能量的单。'),
    h('p', { class: 'hint muted m0' }, '给 TronSave 充值由你自己在它的网站上做，TopUP 不碰你的钱。预存余额超过 1,000 TRX 会告警（平台的 API Key 在服务器上，余额就是最大损失）。')) : null;
  return h('div', { class: 'stack', 'data-wallet-status': '' }, top, h('h2', { class: 'h-sm m0' }, '每条链'), h('div', { class: 'batch-grid' }, ...cards), rentalBox,
    h('section', { class: 'card stack-sm' }, h('h2', { class: 'h-sm m0' }, '钱包提供方'),
      h('ul', { class: 'wl-checks' }, ...r.providers.map((x: any) => h('li', { class: x.enabled ? 'y' : 'muted' }, `${PROVIDER_NAME[x.id] || x.id}：${x.enabled ? '在用' : '未开通（不告警）'}`)))));
}
/** 异常状态：沿用 st-rejected，另加 st-bad 标红 */
const badStatus = (text: string) => { const el = status('rejected', text); el.classList.add('st-bad'); return el; };
const missing = (c: any) => [c.rpc, c.usdt, ...Object.values(c.contracts)].filter((x) => !x).length + (c.operator.configured ? 0 : 1);

// ============ 概览：待处理（按等了多久排，出错的排最前） ============
type Todo = { bad: boolean; since: string | null; text: string; sub?: string; tab: string; label: string; act?: () => void };
/** 待处理的事（概览用，侧栏角标也用）；读取失败的部分记在 failed 里 */
export async function walletTodoItems(ui: WalletUi): Promise<{ items: Todo[]; failed: string[]; sweep: any; chains: any }> {
  const items: Todo[] = [];
  const failed: string[] = [];
  const get = (a: string, name: string, qs = '') => ui.call(a, undefined, qs).catch(() => { failed.push(name); return null; });
  const [s, c, w, probs, all] = await Promise.all([get('wallet-sweep', '归集'), get('wallet-chains', '每条链的状态'), get('withdrawals', '打款'), get('wallet-sweep-batches', '归集批次', '&status=partial,failed'), get('wallet-sweep-batches', '归集批次')]);
  for (const ch of c?.chains || []) {
    if (ch.status === 'scan_stalled' || ch.status === 'onchain_mismatch' || ch.status === 'not_configured' && ch.rpc) items.push({ bad: true, since: null, text: `${CHAIN_NAME[ch.chain]}：${ch.status === 'scan_stalled' ? '扫块停了' : ch.status === 'onchain_mismatch' ? '合约参数和链上不一致，已停用' : '合约地址没配齐'}`, tab: 'p-status', label: '看系统状态' });
    if (ch.operator?.low) items.push({ bad: true, since: null, text: `${CHAIN_NAME[ch.chain]} 发起账户的 ${ch.operator.symbol} 不够付手续费`, sub: `现在有 ${gasText(ch.operator)}；钱都还在原地址`, tab: 'p-sweep', label: '去补手续费' });
  }
  const allB = all?.items || [];
  for (const b of probs?.items || []) if (unresolved(b, allB)) {
    items.push({ bad: true, since: b.updated_at, text: `归集批次 ${b.id} ${b.status === 'partial' ? '部分成功' : '失败了'}`, sub: `${CHAIN_NAME[b.chain]} · ${b.error === 'interrupted_while_sending' ? '确认后发送中断超过 15 分钟，已标失败' : '失败的地址已放回待归集'}`, tab: 'p-sweep', label: '看批次' });
  }
  for (const ch of s?.chains || []) for (const b of ch.batches || []) {
    if (b.status === 'awaiting_approval') items.push({ bad: false, since: b.created_at, text: `确认归集 ${b.id}（${CHAIN_NAME[b.chain]}，${usd(b.total_usdt)} USDT）`, sub: `${b.address_count} 个地址${b.split_of > 1 ? ` · 超过每批上限，系统分成了 ${b.split_of} 批` : ''}`, tab: 'p-sweep', label: '去确认' });
  }
  // 待审核的打款：单笔一行；商户批量（同一个批次号）合成一行
  const groups = new Map<string, { since: string; n: number; total: number }>();
  for (const x of w?.items || []) {
    if (x.status !== 'pending') continue;
    if (!x.batch_no) { items.push({ bad: false, since: x.created_at, text: `审核打款 ${x.id}（${usd(x.amount)} USDT）`, tab: 'p-withdrawals', label: '去审核打款' }); continue; }
    const g = groups.get(x.batch_no) || { since: x.created_at, n: 0, total: 0 };
    g.n++; g.total += parseUsdt(String(x.amount ?? '0')) ?? 0;
    if (Date.parse(x.created_at) < Date.parse(g.since)) g.since = x.created_at;
    groups.set(x.batch_no, g);
  }
  for (const [no, g] of groups) items.push({ bad: false, since: g.since, text: `审核批量打款 ${no}（${g.n} 笔，${fmtUsdt(g.total)} USDT）`, tab: 'p-withdrawals', label: '去逐行审' });
  items.sort((a, b) => (a.bad !== b.bad ? (a.bad ? -1 : 1) : (Date.parse(a.since || '') || 0) - (Date.parse(b.since || '') || 0)));
  return { items, failed, sweep: s, chains: c };
}

export async function walletTodo(ui: WalletUi): Promise<HTMLElement> {
  const box = h('div', { class: 'stack', 'data-todo': '' });
  const draw = async () => {
    let r: Awaited<ReturnType<typeof walletTodoItems>>;
    try { r = await walletTodoItems(ui); } catch { r = { items: [], failed: ['待处理'], sweep: null, chains: null }; }
    const { items, failed, sweep: s } = r;
    const retry = () => { box.replaceChildren(h('p', { class: 'muted', 'data-loading': '' }, '正在重新读取待处理……')); draw(); };
    // 读取失败排最前：不能显示"现在没事要做"（可能正有事没读到）
    const errRow: Todo | null = failed.length ? { bad: true, since: null, text: `待处理读取失败：${failed.join('、')}`, sub: '这几项没读到，下面的列表可能不全', tab: '', label: '重试', act: retry } : null;
    const all = errRow ? [errRow, ...items] : items;
    const first = all[0];
    // 读取失败时大卡片不放按钮，"重试"只在下面表格那一行（一个按钮）
    const top = errRow ? hero('bad', '待处理读取失败', `${failed.join('、')}没读到，现在不知道还有没有别的事要做。点下面的"重试"；一直失败看"系统状态"。${items.length ? `已读到的 ${items.length} 件在下面。` : ''}`)
      : first ? hero(first.bad ? 'bad' : 'warn', `有 ${all.length} 件事要处理`, first.sub ? `${first.text} · ${first.sub}` : first.text, { label: first.label, onClick: () => (first.act ? first.act() : ui.go(first.tab)) })
      : hero('ok', '现在没事要做', s?.next_slot ? `下一次凑归集批次在 ${t(s.next_slot)}；凑好了会发邮件给你，这里也会出现。` : '有新的打款、归集批次时会出现在这里。');
    box.replaceChildren(top,
      h('div', { class: 'toolbar' }, h('h2', { class: 'h-sm m0' }, `待处理（${all.length}）`), h('span', { class: 'muted' }, '按等了多久排，出错的排最前')),
      table(['要做的事', '等了多久', ''], all.map((x) => [
        x.sub ? h('span', { class: 'cell-2' }, h('span', { class: x.bad ? 'bad' : '' }, x.text), h('span', { class: 'hint muted' }, x.sub)) : x.bad ? h('span', { class: 'bad' }, x.text) : x.text,
        x.since ? (x.bad ? h('span', { class: 'neg' }, `${ago(x.since)}前`) : ago(x.since)) : h('span', { class: 'neg' }, '出错中'),
        h('button', { type: 'button', class: 'btn btn-outline btn-sm', ...(x.act ? { 'data-todo-retry': '' } : {}), onclick: () => (x.act ? x.act() : ui.go(x.tab)) }, x.label)]), errRow ? '—' : '现在没事要做'));
  };
  await draw();
  return box;
}

/** 侧栏角标：归集（待确认的批次数；有失败、部分成功、手续费不够时显示 !）、系统状态（有链不正常时显示 !） */
export async function walletBadges(ui: WalletUi): Promise<{ sweep: string | null; status: string | null }> {
  const r = await walletTodoItems(ui);
  const sweepBad = r.items.some((x) => x.bad && x.tab === 'p-sweep');
  const waiting = r.items.filter((x) => !x.bad && x.tab === 'p-sweep').length;
  const statusBad = (r.chains?.chains || []).some((c: any) => c.status !== 'not_in_this_batch' && !c.ok);
  return {
    sweep: r.failed.includes('归集') ? null : sweepBad ? '!' : waiting ? String(waiting) : '',
    status: r.chains ? (statusBad ? '!' : '') : null,
  };
}
