// 运营后台的合约钱包部分（正式模式）：归集（ETH、BSC）、钱包提供方、系统状态里每条链的卡片、概览的"待处理"。
// 接口：/api/wallet/?a=wallet-*（server/wallet/admin-actions.js）。页面只显示服务器给的结果，钱只能进冷钱包（写死在合约里）。
import { fmtUsdt, parseUsdt, shortAddr } from '../lib/money';
import { field, fieldErr, fmtTime, h, mono, stat, status, table } from './ui';

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
  sweep_not_sent: '节点暂时连不上，交易没有发出，这批仍是"待确认"，稍后再点一次即可。',
  sweep_send_failed: '交易发送失败，这批已标为失败，地址放回待归集；下一次凑批会重新列出。',
  reason_required: '请填写原因。', bad_code: '动态码不正确或已经用过，请等下一个动态码。',
  operator_not_configured: '服务器还没有配置归集发起账户（SWEEP_OPERATOR_KEY），不能执行归集。',
  chain_not_enabled: '这条链还没有开通。', provider_not_enabled: '这家提供方还没有接入，不能切换过去。',
  wallet_not_configured: '钱包还没有配置好，看"系统状态"。', invalid_param: '有一项填得不对，请检查标红的地方。',
};
const err = (ui: WalletUi, e: any) => ERR[e?.code] || ui.errText(e);
const BATCH_ST: Record<string, [string, string]> = {
  awaiting_approval: ['submitted', '待确认'], sending: ['in', '发送中'], sent: ['in', '链上确认中'], confirmed: ['approved', '已完成'],
  partial: ['needs_info', '部分成功'], failed: ['rejected', '失败'], expired: ['expired', '已作废'], cancelled: ['expired', '已取消'],
};
const batchSt = (s: string) => status(...(BATCH_ST[s] || ['submitted', s]));
const SKIP: Record<string, string> = {
  inBatch: '已在别的批次里', otherScheme: '合约参数不是当前这套（由原参数归集）', belowThreshold: '低于门槛，继续攒着',
  overAddressCap: '超过每地址上限：这次不归集，请用冷钱包多签手动处理', feeRatio: '手续费占比太高，先不归集',
};
const ITEM_ST: Record<string, string> = { pending: '待确认', sent: '已发出', swept: '已归集', failed: '失败', released: '放回待归集' };

/** 第一屏的大卡片：一句话 + 一个大按钮 */
export function hero(kind: 'ok' | 'warn' | 'bad', title: string, text: string | Node, action?: { label: string; onClick: () => void }) {
  return h('section', { class: `hero-todo hero-${kind}`, 'data-hero': '' },
    h('div', { class: 'stack-sm' }, h('h2', { class: 'm0' }, title), h('p', { class: 'muted m0' }, text)),
    action ? h('button', { type: 'button', class: 'btn btn-primary btn-lg', onclick: action.onClick }, action.label) : null);
}
const kv = (rows: [string, Node | string][]) => h('dl', { class: 'kv' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));

// ============ 归集 ============
let sweepChain = 'eth';
let recFilter = '';
export async function renderEvmSweep(ui: WalletUi): Promise<HTMLElement> {
  const s = await ui.call('wallet-sweep');
  const on = s.chains.filter((c: any) => c.enabled);
  const waiting = on.flatMap((c: any) => c.batches.filter((b: any) => b.status === 'awaiting_approval')).sort((a: any, b: any) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const moving = on.flatMap((c: any) => c.batches.filter((b: any) => b.status !== 'awaiting_approval'));
  const total = waiting.reduce((x: number, b: any) => x + (parseUsdt(b.total_usdt) ?? 0), 0);
  const next = s.next_slot ? t(s.next_slot) : '—';
  const box = h('div', { class: 'stack', 'data-evm-sweep': '' });

  let top: HTMLElement;
  if (!on.length) top = hero('warn', '以太坊、BSC 还没有开通', '服务器还没有配置节点或合约地址（看"系统状态"每条链的卡片）。配好后这里会显示待归集的地址和批次。');
  else if (waiting.length) {
    const first = waiting[0];
    top = hero('warn', `有 ${waiting.length} 个批次等你确认，合计 ${fmtUsdt(total)} USDT`,
      h('span', {}, `系统按门槛凑好了，邮件已发给你（邮件里没有确认按钮）。钱只会进冷钱包。`, h('b', { class: 'neg' }, ` 最早的已等 ${ago(first.created_at)}`)),
      { label: `去确认第 1 批：${first.id}`, onClick: () => confirmBatch(ui, first) });
  } else if (on.some((c: any) => c.scan_ok === false)) top = hero('bad', `${on.filter((c: any) => c.scan_ok === false).map((c: any) => CHAIN_NAME[c.chain]).join('、')} 扫块不正常`, '到账会晚到，相关的归集先不凑批。看"系统状态"。', { label: '看系统状态', onClick: () => ui.go('p-status') });
  else top = hero('ok', '现在没事要做', `下一次凑批在 ${next}（东八区 ${s.times.join('、')}）；凑好了会发邮件给你，这里也会出现。`);

  // 页内导航
  const sec = (id: string, title: string, right: Node | null, ...kids: Node[]) => h('section', { class: 'stack', id: `sw-${id}` }, h('div', { class: 'toolbar' }, h('h2', { class: 'h-sm m0' }, title), right ? h('div', { class: 'tool-actions' }, right) : null), ...kids);
  const jump = (id: string, label: string) => h('button', { type: 'button', class: 'pill-btn', onclick: () => box.querySelector(`#sw-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, label);

  // 1. 待确认批次
  const proposeBtns = h('span', { class: 'tool-actions' }, ...on.map((c: any) => h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-propose': c.chain, onclick: () => propose(ui, c.chain) }, `${CHAIN_NAME[c.chain]}：现在就凑一批`)));
  const cards = [...waiting, ...moving].map((b: any) => batchCard(ui, b));
  const pending = sec('pending', `待确认批次（${waiting.length}）`, proposeBtns,
    cards.length ? h('div', { class: 'batch-grid' }, ...cards) : h('p', { class: 'muted m0', 'data-empty': '' }, on.length ? `现在没有待确认的批次。下一次凑批在 ${next}，也可以点右上角"现在就凑一批"。` : '还没有开通的链。'));

  // 2. 各链待归集地址
  const chainTabs = h('div', { class: 'seg', role: 'tablist' }, ...s.chains.map((c: any) => h('button', {
    type: 'button', role: 'tab', 'aria-selected': String(sweepChain === c.chain), disabled: !c.enabled, class: sweepChain === c.chain ? 'on' : '',
    onclick: () => { sweepChain = c.chain; ui.rerender(); },
  }, CHAIN_NAME[c.chain], c.not_in_this_batch ? laterTag() : !c.enabled ? ' （未开通）' : '')));
  const cur = on.find((c: any) => c.chain === sweepChain) || on[0];
  if (cur) sweepChain = cur.chain;
  let addrBody: HTMLElement = h('p', { class: 'muted' }, '没有开通的链。');
  if (cur) {
    const r = await ui.call('wallet-sweep-addresses', undefined, `&chain=${cur.chain}`).catch(() => null);
    addrBody = h('div', { class: 'stack' },
      h('div', { class: 'stats' },
        stat('未归集合计（估算）', usd(cur.estimate.total_usdt), `USDT · ${cur.estimate.address_count} 个地址`),
        stat(`达到门槛（${usd(cur.threshold_usdt)}）`, String(cur.estimate.over_threshold), `个地址 · ${usd(cur.estimate.over_threshold_usdt)} USDT`)),
      r ? table(['收款地址', '客户 · 商户', '待归集 USDT（估算）', '状态'], r.items.map((x: any) => [
        mono(shortAddr(x.address), x.address), h('span', { class: 'cell-2' }, mono(x.customer_id), h('span', { class: 'hint muted' }, x.merchant)), usd(x.pending_usdt),
        x.in_batch ? status('in', '在批次里') : x.status === 'retired' ? status('expired', '旧地址（停用，照常归集）') : (parseUsdt(x.pending_usdt) ?? 0) >= (parseUsdt(cur.threshold_usdt) ?? 0) ? status('submitted', '达到门槛，等下次凑批') : status('expired', '低于门槛，继续攒着'),
      ]), '这条链上现在没有待归集的钱。', { page: { size: 20, more: (n) => `显示更多（还有 ${n} 个）` } }) : h('p', { class: 'alert' }, '地址列表读取失败，请稍后重试。'),
      h('p', { class: 'hint muted m0' }, '这里按账本估算（到账合计 − 已归集）；凑批时系统向链上查实际余额，门槛以下的继续攒着。'));
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
    h('p', { class: 'hint muted m0' }, '点一行看每个地址的结果和链上交易。'));

  // 4. 门槛和上限
  const st = s.settings;
  const settings = sec('settings', '门槛和上限', h('span', { class: 'muted' }, '后台可改：要输动态码、写原因、记审计'),
    h('div', { class: 'card stack' },
      kv([
        ['归集门槛', h('span', {}, `以太坊 ${usd(st.thresholds.eth)} · BSC ${usd(st.thresholds.bsc)} · TRON ${usd(st.thresholds.tron)} `, laterTag(), ' USDT（地址余额达到才放进批次）')],
        ['每个地址每次上限', `${usd(st.capPerAddress)} USDT（超过的这次跳过，用冷钱包多签手动处理）`],
        ['每批上限', `${usd(st.capPerBatch)} USDT、${st.maxAddresses} 个地址（超过就自动拆成几批）`],
        ['手续费占比', `一个地址的手续费超过金额的 ${st.maxFeeRatioPct}% 就先不归集（有价格时才判断）`],
        ['凑批时间', `每天 ${s.times.join('、')}（东八区）；待确认超过 ${s.expire_hours} 小时作废，下一轮重凑`],
      ]),
      h('div', {}, h('button', { type: 'button', class: 'btn btn-outline', 'data-edit-settings': '', onclick: () => editSettings(ui, st) }, '修改门槛和上限'))));

  box.append(top, h('nav', { class: 'seg seg-nav', 'aria-label': '归集页内导航' }, jump('pending', `待确认批次（${waiting.length}）`), jump('addresses', '各链待归集地址'), jump('records', '批次记录'), jump('settings', '门槛和上限')), pending, addrs, records, settings);
  return box;
}

function batchCard(ui: WalletUi, b: any) {
  const waiting = b.status === 'awaiting_approval';
  const skipped = b.skipped?.length || 0;
  return h('article', { class: 'card batch-card stack-sm', 'data-batch': b.id },
    h('div', { class: 'batch-head' }, chainTag(b.chain), h('b', { class: 'mono' }, b.id), batchSt(b.status)),
    h('div', { class: 'batch-amt' }, usd(b.total_usdt), h('small', {}, ' USDT')),
    kv([
      ['地址', `${b.address_count} 个${skipped ? `（另有 ${skipped} 个跳过）` : ''}`],
      ['手续费估算', b.fee ? `约 ${b.fee.native} ${b.fee.symbol}` : '暂时估不出（节点没响应）'],
      ['去向', '冷钱包（写死在合约里）'],
      [waiting ? '等了' : '确认人', waiting ? h('span', { class: 'neg' }, ago(b.created_at)) : `${b.approved_by || '—'} · ${t(b.approved_at)}`],
    ]),
    b.error && waiting ? h('p', { class: 'alert m0' }, `上次没发出：${b.error}`) : null,
    waiting ? h('div', { class: 'stack-sm' },
      h('button', { type: 'button', class: 'btn btn-primary', 'data-confirm': b.id, onclick: () => confirmBatch(ui, b) }, '核对并确认'),
      h('button', { type: 'button', class: 'link-btn bad', onclick: () => cancelBatch(ui, b) }, '不归集这批'))
      : h('p', { class: 'hint muted m0' }, b.tx_refs?.length ? h('span', {}, '交易 ', mono(shortAddr(b.tx_refs[0]), b.tx_refs[0]), '，worker 每 15 秒查一次结果') : '正在发送……'));
}

function itemsTable(b: any) {
  return table(['地址', '金额', '首次归集', '结果'], b.items.map((i: any) => [mono(shortAddr(i.address), i.address), usd(i.amount_usdt), i.deploy ? '是（要先部署，手续费高些）' : '不是', ITEM_ST[i.status] || i.status]), '没有地址');
}
function skippedTable(b: any) {
  return table(['地址', '余额', '原因'], (b.skipped || []).map((x: any) => [mono(shortAddr(x.address), x.address), usd(x.amount_usdt), SKIP[x.reason] || x.reason]), '没有跳过的地址');
}
const steps = (n: number) => h('ol', { class: 'stepper-3' }, ...['核对', '确认执行', '看链上结果'].map((x, i) => h('li', { class: i + 1 < n ? 'done' : i + 1 === n ? 'on' : '' }, x)));

function confirmBatch(ui: WalletUi, b: any) {
  const reason = h('input', { maxlength: '200', placeholder: '例如：今天 20:00 的例行归集', value: '' }) as HTMLInputElement;
  const caps = (parseUsdt(b.total_usdt) ?? 0);
  const maxOne = Math.max(0, ...b.items.map((i: any) => parseUsdt(i.amount_usdt) ?? 0));
  const body = h('div', { class: 'stack' },
    h('p', { class: 'muted m0' }, '第 1 步 / 共 3 步：看清楚再点确认。确认后系统用发起账户发一笔交易。'),
    steps(1),
    kv([
      ['链', chainTag(b.chain)],
      ['归集', h('b', {}, `${b.address_count} 个地址，合计 ${usd(b.total_usdt)} USDT`)],
      ['钱去哪', h('span', {}, '冷钱包（parent）', h('br'), h('span', { class: 'hint muted' }, '写死在合约里，系统和服务器都改不了'))],
      ['手续费估算', b.fee ? `约 ${b.fee.native} ${b.fee.symbol}${b.fee.gas ? `（${Number(b.fee.gas).toLocaleString('en')} gas）` : ''}` : '暂时估不出'],
      ['谁付手续费', '发起账户（服务器上，只能付手续费、转不走钱）'],
    ]),
    h('ul', { class: 'wl-checks bullets' },
      h('li', {}, `每个地址都没超过每地址上限（这批最大 ${fmtUtil(maxOne)}）`),
      h('li', {}, `这批合计 ${fmtUtil(caps)}，没超过每批上限`),
      h('li', {}, `凑批时间 ${t(b.created_at)}；${t(b.expires_at)} 前不确认就作废`)),
    h('details', { open: true }, h('summary', {}, `这批的 ${b.address_count} 个地址`), itemsTable(b)),
    b.skipped?.length ? h('details', {}, h('summary', {}, `跳过的 ${b.skipped.length} 个地址和原因`), skippedTable(b)) : null,
    field('sw-reason', '原因（必填，记进审计）', reason));
  ui.dialog(`确认归集 ${b.id}`, body, `确认归集 ${b.address_count} 个地址（${usd(b.total_usdt)} USDT）`, async () => {
    if (fieldErr(reason, reason.value.trim() ? null : '请填写原因')) return false;
    const btn = document.querySelector<HTMLButtonElement>('[data-pdialog-ok]');
    if (btn) { btn.disabled = true; btn.textContent = '发送中……'; }
    try {
      const r = await ui.call('wallet-sweep-approve', { id: b.id, reason: reason.value.trim() });
      if (btn) btn.disabled = false;
      body.replaceChildren(steps(3), h('p', { class: 'ok-title m0' }, '已发出一笔交易'), kv([['交易', mono(r.txRefs?.[0] || '—')], ['接下来', 'worker 每 15 秒查一次链上结果；部分地址失败会放回待归集并发邮件，不会自动重试。']]));
      ui.rerender();
      ui.dialog(`已确认 ${b.id}`, body, '关闭', null, false, true);
      return false;
    } catch (e: any) {
      if (btn) { btn.disabled = false; btn.textContent = `确认归集 ${b.address_count} 个地址（${usd(b.total_usdt)} USDT）`; }
      ui.say(err(ui, e));
      if (['batch_state', 'batch_expired', 'sweep_send_failed'].includes(e?.code)) { ui.rerender(); return true; }
      return false;
    }
  });
}
const fmtUtil = (u: number) => `${fmtUsdt(u)} USDT`;

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

async function batchDetail(ui: WalletUi, b: any) {
  ui.dialog(`批次 ${b.id}`, h('div', { class: 'stack' },
    kv([['链', chainTag(b.chain)], ['状态', batchSt(b.status)], ['合计', `${usd(b.total_usdt)} USDT · ${b.address_count} 个地址`], ['凑批', t(b.created_at)],
      ['确认', b.approved_by ? `${b.approved_by} · ${t(b.approved_at)} · ${b.reason || ''}` : b.reason ? `原因：${b.reason}` : '—'], ['交易', b.tx_refs?.length ? mono(b.tx_refs.join('、')) : '—'], ['出错', b.error || '—']]),
    itemsTable(b), b.skipped?.length ? h('details', {}, h('summary', {}, `跳过的 ${b.skipped.length} 个地址`), skippedTable(b)) : null,
    b.status === 'partial' || b.status === 'failed' ? h('p', { class: 'note-box m0' }, '失败的地址已放回待归集，不会自动重试；下一次凑批会重新列出，仍要你确认。') : null), '关闭', null, false, true);
}

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
  const count = (c: any, st: string) => c.addresses.filter((a: any) => a.status === st).reduce((s: number, a: any) => s + a.address_count, 0);
  p.replaceChildren(
    h('div', { class: 'toolbar' }, h('h1', { class: 'm0' }, '钱包提供方'), h('span', { class: 'muted' }, '谁来管收款地址里的钱 · 按链整体切换')),
    hero('ok', '现在没事要做', '以太坊、BSC 都用合约钱包。只有在要换一家托管方（例如 Cobo）时才来这里；换之前要先开账号、实测。'),
    h('h2', { class: 'h-sm' }, '每条链现在用谁'),
    table(['链', '现在用', '收款地址', ''], r.chains.map((c: any) => [
      h('span', {}, chainTag(c.chain), c.not_in_this_batch ? laterTag() : ''),
      h('span', {}, PROVIDER_NAME[c.provider] || c.provider, c.provider === 'contract' ? h('span', { class: 'muted' }, '（默认）') : ''),
      c.not_in_this_batch ? '—' : `${count(c, 'active')} 个在用${count(c, 'retired') ? ` · ${count(c, 'retired')} 个停用（照常入账、归集）` : ''}`,
      c.not_in_this_batch ? laterTag() : h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-switch': c.chain, onclick: () => switchProvider(ui, c, r.providers) }, `切换 ${CHAIN_NAME[c.chain]} 的提供方`),
    ]), '—'),
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
}

// ============ 系统状态：每条链一张卡 ============
const CONTRACT_NAME: Record<string, string> = { factory: '转发合约工厂（ForwarderFactory）', implementation: '转发合约实现（Forwarder）', batcher: '批量归集合约（SweepBatcher）', parent: '冷钱包（parent，多签）' };
export async function walletStatus(ui: WalletUi): Promise<HTMLElement> {
  let r: any;
  try { r = await ui.call('wallet-chains'); } catch (e) { return h('p', { class: 'alert' }, `每条链的状态读取失败：${err(ui, e)}`); }
  const evm = r.chains.filter((c: any) => c.status !== 'not_in_this_batch');
  const bad = evm.filter((c: any) => !c.ok);
  const words = (c: any) => c.status === 'not_configured' ? `少 ${missing(c)} 项配置` : c.status === 'scan_stalled' ? '扫块停了' : c.status === 'catching_up' ? '补扫追赶中' : '正常';
  const top = bad.length
    ? hero('bad', bad.map((c: any) => `${CHAIN_NAME[c.chain]}${words(c)}`).join('，'), '扫块停了到账会晚到（恢复后从停下的区块接着扫，不会漏账）；少配置的链不能分配地址、不能归集。')
    : hero('ok', '每条链都正常', '扫块、合约地址配置都正常。');
  const ck = (ok: boolean, text: string) => h('li', { class: ok ? 'y' : 'bad' }, `${text}：${ok ? '已配置' : '没配置'}`);
  const cards = r.chains.map((c: any) => c.status === 'not_in_this_batch'
    ? h('article', { class: 'card stack-sm chain-card later', 'data-chain-card': c.chain }, h('div', { class: 'batch-head' }, chainTag(c.chain), laterTag()), h('p', { class: 'muted m0' }, '第 1 批不分配新的 TRON 地址；已有的 TRON 地址照常入账（上面"链上监控"）。第 2 批上线后这里同样显示扫块和合约配置。'))
    : h('article', { class: 'card stack-sm chain-card', 'data-chain-card': c.chain },
      h('div', { class: 'batch-head' }, chainTag(c.chain), status(c.ok ? (c.status === 'catching_up' ? 'in' : 'approved') : 'rejected', words(c))),
      h('h3', { class: 'h-sm m0' }, '扫块'),
      kv([
        ['最后一次扫块', c.scan.age_s === null ? '还没扫过' : h('span', { class: c.scan.ok ? '' : 'neg' }, c.scan.age_s < 120 ? `${c.scan.age_s} 秒前` : `${Math.round(c.scan.age_s / 60)} 分钟前${c.scan.ok ? '' : '（停了）'}`)],
        ['落后', c.scan.lag_blocks === null ? '—' : `${c.scan.lag_blocks} 个区块（要 ${c.confirmations} 个确认）`],
      ]),
      !c.scan.ok && c.scan.age_s !== null ? h('p', { class: 'alert m0' }, '节点连不上或 worker 没在跑：系统每轮重连，已发邮件给你；恢复后从停下的区块接着扫，不会漏账。') : null,
      h('h3', { class: 'h-sm m0' }, '合约地址配置'),
      h('ul', { class: 'wl-checks' }, ck(c.rpc, '节点'), ck(c.usdt, 'USDT 合约'), ...Object.entries(CONTRACT_NAME).map(([k, v]) => ck(c.contracts[k], v)),
        h('li', { class: c.operator.configured ? 'y' : 'bad' }, `发起账户（只付手续费）：${c.operator.configured ? `已配置${c.operator.gas !== null ? `，余额 ${c.operator.gas} ${c.operator.symbol}` : ''}` : '没配置（不能执行归集）'}`)),
      c.config_error ? h('p', { class: 'alert m0' }, '合约参数检查没通过（例如冷钱包等于批量合约），这条链先不开通。') : null,
      h('p', { class: 'hint muted m0' }, '只显示"是否已配置"，不显示具体值。')));
  return h('div', { class: 'stack', 'data-wallet-status': '' }, top, h('h2', { class: 'h-sm m0' }, '每条链'), h('div', { class: 'batch-grid' }, ...cards),
    h('section', { class: 'card stack-sm' }, h('h2', { class: 'h-sm m0' }, '钱包提供方'),
      h('ul', { class: 'wl-checks' }, ...r.providers.map((x: any) => h('li', { class: x.enabled ? 'y' : 'muted' }, `${PROVIDER_NAME[x.id] || x.id}：${x.enabled ? '在用' : '未开通（不告警）'}`)))));
}
const missing = (c: any) => [c.rpc, c.usdt, ...Object.values(c.contracts)].filter((x) => !x).length + (c.operator.configured ? 0 : 1);

// ============ 概览：待处理（按等了多久排，出错的排最前） ============
export async function walletTodo(ui: WalletUi): Promise<HTMLElement> {
  const items: { bad: boolean; since: string | null; text: string; tab: string; label: string; act?: () => void }[] = [];
  const [s, c, w] = await Promise.all([ui.call('wallet-sweep').catch(() => null), ui.call('wallet-chains').catch(() => null), ui.call('withdrawals').catch(() => null)]);
  for (const ch of c?.chains || []) if (ch.status === 'scan_stalled' || ch.status === 'not_configured' && ch.rpc) items.push({ bad: true, since: null, text: `${CHAIN_NAME[ch.chain]}：${ch.status === 'scan_stalled' ? '扫块停了' : '合约地址没配齐'}`, tab: 'p-status', label: '看系统状态' });
  for (const ch of s?.chains || []) for (const b of ch.batches || []) {
    if (b.status === 'awaiting_approval') items.push({ bad: false, since: b.created_at, text: `确认归集 ${b.id}（${CHAIN_NAME[b.chain]}，${usd(b.total_usdt)} USDT）`, tab: 'p-sweep', label: `去确认 ${b.id}` });
  }
  for (const x of w?.items || []) if (x.status === 'pending') items.push({ bad: false, since: x.created_at, text: `审核提币 ${x.id}（${usd(x.amount)} USDT）`, tab: 'p-withdrawals', label: '去审核提币' });
  items.sort((a, b) => (a.bad !== b.bad ? (a.bad ? -1 : 1) : (Date.parse(a.since || '') || 0) - (Date.parse(b.since || '') || 0)));
  const first = items[0];
  const top = first ? hero(first.bad ? 'bad' : 'warn', `有 ${items.length} 件事要处理`, first.text, { label: first.label, onClick: () => ui.go(first.tab) })
    : hero('ok', '现在没事要做', s?.next_slot ? `下一次凑归集批次在 ${t(s.next_slot)}；凑好了会发邮件给你，这里也会出现。` : '有新的提币、归集批次时会出现在这里。');
  return h('div', { class: 'stack', 'data-todo': '' }, top,
    h('div', { class: 'toolbar' }, h('h2', { class: 'h-sm m0' }, `待处理（${items.length}）`), h('span', { class: 'muted' }, '按等了多久排，出错的排最前')),
    table(['要做的事', '等了多久', ''], items.map((x) => [x.bad ? h('span', { class: 'bad' }, x.text) : x.text, x.since ? ago(x.since) : '出错中', h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => ui.go(x.tab) }, x.label)]), '现在没事要做'));
}
