// 商户后台的交互逻辑。数据来自 merchant-data.ts：
// - 正式模式（测试环境、生产）：/api/merchant/
// - 原型模式（开发分支的预览）：模拟数据
import copy from '../i18n/merchant.json';
import { calcFee, describeFee, fmtUsdt, isTronAddress, parseUsdt, shortAddr } from '../lib/money';
import { realData, protoData, units, ApiErr, MAX_ROWS, type List, type Amount, type Cust, type Dep, type OrderFull, type Wd, type Me, type ChainAddr } from './merchant-data';
import * as Mock from './mock';
import { isChecksumAddress } from '../../../server/wallet/evm-payout-codec.js';
import { copyBtn, field, fieldErr, fmtTime, h, makeDialog, mono, qrDataUrl, stat, status, table, toast, tpl } from './ui';

const root = document.getElementById('m-root')!;
const lang = (root.dataset.lang || 'en') as 'en' | 'zh';
const base = root.dataset.base || '/';
const PROTO = root.dataset.prototype === '1';
const D = PROTO ? protoData() : realData();
const c = copy[lang];
const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!;
const say = (m: string) => toast(root, '[data-mtoast]', m);
const dialog = makeDialog(root, 'm');
const dlgEl = root.querySelector<HTMLDialogElement>('[data-mdialog]')!;
const t = (iso: string | null | undefined) => (iso ? fmtTime(iso, lang) : '—');
const usd = (v: Amount | null | undefined) => fmtUsdt(units(v));
const CUST_RE = /^[A-Za-z0-9_.@-]{1,128}$/;
const pct = (ppm: number) => String(ppm / 10000);
const errText = (e: unknown) => (c.errors as Record<string, string>)[(e as ApiErr)?.code] || c.errors.generic;
let me: NonNullable<Me['merchant']>;

// ---------- 多链（第 1 批：以太坊、BSC；TRON 第 2 批） ----------
const CHAINS = ['eth', 'bsc', 'tron'] as const;
let enabledChains: string[] = [];
const netName = (ch: string) => (c.chain.names as Record<string, string>)[ch] || ch.toUpperCase();
const netStd = (ch: string) => (c.chain.std as Record<string, string>)[ch] || '';
const chainTag = (ch: string) => h('span', { class: `chain-tag c-${ch}` }, netName(ch));
const laterTag = () => h('span', { class: 'later-tag' }, c.chain.later);
const addrOf = (list: ChainAddr[] | undefined, ch: string) => (list || []).find((a) => a.chain === ch)?.address || null;
/** 每条链一张地址卡：地址、复制按钮、"只收某网络的 USDT"；TRON 没有地址时标"第 2 批" */
function addressCards(list: ChainAddr[] | undefined) {
  // 以太坊、BSC 同一串时就近说明一句（免得商户以为只能收一条链）
  const e = addrOf(list, 'eth'), b = addrOf(list, 'bsc');
  const same = e && b && e.toLowerCase() === b.toLowerCase() ? h('p', { class: 'info-box m0', 'data-same-note': '' }, c.chain.sameNote) : null;
  const grid = h('div', { class: 'addr-grid', 'data-addresses': '' }, ...CHAINS.map((ch) => {
    const a = addrOf(list, ch);
    if (!a && ch !== 'tron' && !enabledChains.includes(ch)) return null;
    return h('div', { class: 'addr-card', 'data-chain': ch }, chainTag(ch),
      a ? mono(a) : ch === 'tron' ? laterTag() : h('span', { class: 'muted', 'data-not-yet': '' }, '—'),
      a ? copyBtn(() => { say(tpl(c.chain.copiedNote, { net: netName(ch), std: netStd(ch) })); return a; }, tpl(c.chain.copy, { net: netName(ch) }), c.common.copied) : null,
      h('span', { class: 'hint muted' }, a ? tpl(c.chain.only, { net: netName(ch), std: netStd(ch) }) : ch === 'tron' ? c.chain.tronLater : c.chain.notYet));
  }));
  return same ? h('div', { class: 'stack-sm' }, same, grid) : grid;
}

// ---------- 视图与导航 ----------
const views = [...root.querySelectorAll<HTMLElement>('[data-view]')];
const showView = (v: string) => views.forEach((x) => (x.hidden = x.dataset.view !== v));
const TABS = ['overview', 'customers', 'orders', 'transactions', 'withdraw', 'payout-batch', 'api', 'callbacks'];
const render: Record<string, (p: HTMLElement) => Promise<void>> = {};
let current = 'overview';
async function go(tab: string) {
  if (!TABS.includes(tab) || (tab === 'orders' && !me.order_mode.enabled)) tab = 'overview';
  current = tab;
  root.querySelectorAll<HTMLElement>('[data-mpanel]').forEach((p) => (p.hidden = p.dataset.mpanel !== tab));
  root.querySelectorAll<HTMLElement>('[data-mtab]').forEach((b) => (b.dataset.mtab === tab ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
  const p = $(`[data-mpanel="${tab}"]`);
  // 走查：接口慢时页面一片空白、出错时只有底部一行提示。改成：0.3 秒还没好就显示"加载中"，出错时在页面里显示原因和"重试"
  const switching = p.dataset.shown !== '1';
  const slow = switching ? window.setTimeout(() => p.replaceChildren(h('p', { class: 'muted', 'data-loading': '' }, c.common.loading)), 300) : 0;
  try { await render[tab](p); p.dataset.shown = '1'; }
  catch (e) {
    if ((e as ApiErr).status === 401) { showView('login'); return; }
    if (switching) { p.replaceChildren(h('div', { class: 'alert', 'data-load-error': '' }, errText(e), ' ', h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => go(tab) }, c.common.retry))); }
    else say(errText(e));
  } finally { clearTimeout(slow); }
  updateCounts();
}
const refresh = () => go(current);
root.querySelectorAll<HTMLElement>('[data-mtab]').forEach((b) => b.addEventListener('click', () => { go(b.dataset.mtab!); window.scrollTo({ top: 0 }); }));
async function updateCounts() { try { $('[data-mcount="withdraw"]').textContent = String((await D.withdrawals()).filter((w) => w.status === 'pending').length); } catch { /* 忽略 */ } }
const toolbar = (title: string, ...right: (HTMLElement | null)[]) => h('div', { class: 'toolbar' }, h('h1', { class: 'm0' }, title), h('div', { class: 'tool-actions' }, ...right));
const custLink = (id: string) => h('button', { type: 'button', class: 'link-copy', onclick: (e: Event) => { e.stopPropagation(); customerDetail(id); } }, id);

// ---------- 登录 / 首次设置 ----------
$('[data-login]').addEventListener('submit', async (e) => {
  e.preventDefault();
  const er = $('[data-login-err]');
  try {
    await D.login($<HTMLInputElement>('#ml-em').value.trim(), $<HTMLInputElement>('#ml-pw').value, $<HTMLInputElement>('#ml-otp').value.trim());
    er.hidden = true; await enter();
  } catch (err) { er.textContent = (err as ApiErr).code === 'locked' ? c.errors.locked : (err as ApiErr).code === 'not_configured' ? c.errors.not_configured : c.login.err; er.hidden = false; }
});
const setupToken = new URLSearchParams(location.search).get('setup') || '';
let setupStep = 1;
$('[data-setup]').addEventListener('submit', async (e) => {
  e.preventDefault();
  const er = $('[data-setup-err]');
  er.hidden = true;
  try {
    if (setupStep === 1) {
      const pw = $<HTMLInputElement>('#ms-pw').value, pw2 = $<HTMLInputElement>('#ms-pw2').value;
      if (pw.length < 12 || pw !== pw2) { er.textContent = c.setup.errPw; er.hidden = false; return; }
      const r = await D.setupBegin(setupToken, pw);
      $<HTMLImageElement>('[data-setup-qr]').src = r.qr || qrDataUrl(`otpauth://totp/TopUP?secret=${r.secret}&issuer=TopUP`);
      $('[data-setup-secret]').textContent = r.secret;
      $('[data-setup-step="1"]').hidden = true; $('[data-setup-step="2"]').hidden = false; setupStep = 2;
      return;
    }
    await D.setupConfirm(setupToken, $<HTMLInputElement>('#ms-otp').value.trim());
    say(c.setup.done);
    history.replaceState(null, '', location.pathname);
    showView('login');
  } catch (err) { er.textContent = errText(err); er.hidden = false; }
});
$('[data-mlogout]').addEventListener('click', async () => { await D.logout().catch(() => {}); showView('login'); });
async function enter() {
  const info: Me = PROTO ? { authed: true, merchant: { id: Mock.me.id, name: Mock.me.name, order_mode: Mock.me.mode, fee_in: Mock.me.feeIn, fee_out: Mock.me.feeOut, cashout_wallets: Mock.me.cashoutWallets } } : await D.me();
  if (!info.authed || !info.merchant) { showView('login'); return; }
  me = info.merchant;
  showView('app');
  $('[data-merchant-name]').textContent = me.name;
  $('[data-mtab="orders"]').hidden = !me.order_mode.enabled;
  await go(location.hash.slice(1));
}

// ---------- 概览 ----------
render.overview = async (p) => {
  const o = await D.overview();
  if (o.chains) enabledChains = o.chains;
  const on = me.order_mode.enabled;
  p.replaceChildren(
    toolbar(c.overview.title, on ? h('button', { type: 'button', class: 'btn btn-primary', onclick: createOrder }, c.overview.newOrder) : null),
    h('div', { class: 'stats' },
      stat(c.overview.available, usd(o.available), 'USDT'),
      stat(c.overview.frozen, usd(o.frozen), tpl(c.overview.frozenSub, { n: o.pending_withdrawals })),
      stat(c.overview.today, usd(o.today), tpl(c.overview.todaySub, { n: o.today_count, fee: usd(o.today_fees) })),
      on ? stat(c.overview.openOrders, String(o.open_orders), c.overview.openOrdersSub) : null,
      on ? stat(c.overview.unmatched, usd(o.unmatched), tpl(c.overview.unmatchedSub, { n: o.unmatched_count })) : null),
    o.today_by_chain ? h('div', { class: 'stats', 'data-by-chain': '' }, ...o.today_by_chain.filter((x) => enabledChains.includes(x.chain) || units(x.total) > 0).map((x) => stat(tpl(c.overview.byChain, { net: netName(x.chain) }), usd(x.total), tpl(c.overview.byChainSub, { n: x.count })))) : null,
    h('p', { class: 'hint muted' }, c.overview.balanceNote, o.today_by_chain ? ` ${c.overview.oneBalance}` : ''),
    h('h2', { class: 'h-sm' }, c.overview.recent),
    depositTable(o.recent),
  );
};
function depResult(d: Dep): HTMLElement {
  if (d.confirmations) return status('submitted', tpl(c.dep.result.confirming, { n: d.confirmations }));
  if (d.result === 'below_min') return status('expired', c.dep.result.below_min);
  return status('approved', c.dep.result.credited);
}
const depOrder = (d: Dep) => (d.result !== 'credited' || d.confirmations ? '—' : d.order_no ? mono(d.order_no) : me.order_mode.enabled ? status('in_progress', c.dep.unmatched) : '—');
/** 表格里的一格：主要内容 + 下面一行小字（走查：列太多时在 1280 宽的屏幕上放不下，相关的两列合成一格） */
const sub = (main: string | HTMLElement, note: string | HTMLElement | null) => h('span', { class: 'cell-2' }, main, note ? h('span', { class: 'hint muted' }, note) : null);
/** 长列表先显示 50 条，"显示更多"再往下显示；没有取完时提示导出 */
const pg = (list: List<unknown>) => ({ size: 50, more: (n: number) => tpl(c.common.more, { n }), note: list.truncated ? tpl(c.common.truncated, { n: MAX_ROWS }) : undefined });
function depositTable(rows: List<Dep>, full = false): HTMLElement {
  const cc = c.dep.cols;
  const cols = full ? [cc.time, cc.customer, `${cc.address} · ${cc.txid}`, cc.amount, `${cc.credited} · ${cc.fee}`, cc.match, cc.status] : [cc.time, cc.customer, cc.amount, cc.credited, cc.match, cc.status];
  return table(cols, rows.map((d) => {
    const credited = d.result === 'credited' && !d.confirmations ? usd(d.credited) : '—';
    return full
      ? [t(d.time), custLink(d.customer_id), sub(mono(shortAddr(d.address), d.address), mono(d.txid.slice(0, 10) + '…', d.txid)), usd(d.amount), sub(credited, units(d.fee) ? `${cc.fee} ${usd(d.fee)}` : null), depOrder(d), depResult(d)]
      : [t(d.time), custLink(d.customer_id), usd(d.amount), credited, depOrder(d), depResult(d)];
  }), c.common.none, full ? { page: pg(rows) } : {});
}

// ---------- 客户 ----------
let custQuery = '';
render.customers = async (p) => {
  const cc = c.customers;
  if (!enabledChains.length && !PROTO) { try { enabledChains = (await D.overview()).chains || []; } catch { /* 读不到时按单列显示 */ } }
  const search = h('input', { type: 'search', class: 'input-sm input-wide', placeholder: cc.search, value: custQuery }) as HTMLInputElement;
  const listBox = h('div');
  const drawList = async () => {
    const list = await D.customers(custQuery.trim());
    const k = cc.cols;
    // 多链：每条链一列地址（以太坊、BSC 是同一串，分两列显示）；没有多链数据的（原型）照旧一列
    const multi = list.some((x) => x.addresses?.length) || enabledChains.length > 0;
    const addrCell = (x: Cust, ch: string) => { const a = addrOf(x.addresses, ch); return a ? mono(shortAddr(a), a) : ch === 'tron' ? laterTag() : '—'; };
    const unm = (x: Cust) => (units(x.unmatched) ? h('b', {}, usd(x.unmatched)) : '0.00');
    // 多链：照原型，客户一列（标识 + 名称 · 邮箱），每条链一列地址；手续费、最近付款在客户详情里看
    const cols = multi ? [k.id, ...CHAINS.map((ch) => `${netName(ch)} ${k.address}`), `${k.total}（${k.count}）`, k.unmatched] : [k.id, `${k.name} · ${k.email}`, k.address, `${k.total}（${k.count}）`, k.fees, k.last, k.unmatched];
    listBox.replaceChildren(table(cols, list.map((x) => multi
      ? [sub(mono(x.customer_id), [x.name, x.email].filter(Boolean).join(' · ') || null), ...CHAINS.map((ch) => addrCell(x, ch)), sub(usd(x.total), `${k.count} ${x.count}`), unm(x)]
      : [mono(x.customer_id), sub(x.name || '—', x.email || null), x.address ? mono(shortAddr(x.address), x.address) : '—', sub(usd(x.total), `${k.count} ${x.count}`), usd(x.fees), t(x.last_payment_at), unm(x)],
    ), c.common.none, { onRow: (i) => customerDetail(list[i].customer_id), rowAttrs: (i) => ({ 'data-customer': list[i].customer_id }), page: pg(list) }));
  };
  let timer = 0;
  search.addEventListener('input', () => { custQuery = search.value; clearTimeout(timer); timer = window.setTimeout(drawList, 250); });
  await drawList();
  p.replaceChildren(toolbar(cc.title, search, h('button', { type: 'button', class: 'btn btn-primary', onclick: createCustomer }, cc.new)), enabledChains.length ? h('p', { class: 'info-box' }, cc.chainsBody) : h('p', { class: 'hint muted' }, cc.body), listBox);
};
function createCustomer() {
  const cc = c.customers.create;
  const id = h('input', { autocomplete: 'off' }) as HTMLInputElement;
  const name = h('input', { autocomplete: 'off' }) as HTMLInputElement;
  const email = h('input', { type: 'email', autocomplete: 'off' }) as HTMLInputElement;
  const remark = h('input', { autocomplete: 'off' }) as HTMLInputElement;
  dialog(cc.title, h('div', { class: 'stack' }, field('mc-id', cc.id, id, cc.idHint), field('mc-name', cc.name, name), field('mc-email', cc.email, email), field('mc-remark', cc.remark, remark)), cc.submit, async () => {
    const v = id.value.trim();
    if (fieldErr(id, CUST_RE.test(v) ? null : c.orders.create.errCustomer)) return false;
    try { await D.saveCustomer({ customer_id: v, name: name.value.trim(), email: email.value.trim(), remark: remark.value.trim() }, true); }
    catch (e) { fieldErr((e as ApiErr).field === 'email' ? email : id, (e as ApiErr).code === 'duplicate_customer' ? cc.errDup : errText(e)); return false; }
    let r: { addresses: ChainAddr[] } | null = null;
    try { r = await D.customerAddresses(v); } catch { r = null; }
    say(r?.addresses.length ? cc.createdChains : cc.created); await refresh();
    setTimeout(() => (r?.addresses.length ? dialog(v, addressCards(r.addresses), c.common.close, null, false, true) : customerDetail(v)), 0);
  });
}
async function customerDetail(id: string) {
  const cd = c.customers.detail;
  const rangeSel = h('select', { class: 'input-sm' }, ...['1', '7', '30', '0'].map((k) => h('option', { value: k, selected: k === '30' }, cd.ranges[k as '1']))) as HTMLSelectElement;
  const statsBox = h('div'), tables = h('div', { class: 'stack' });
  const first = await D.customer(id, 30).catch((e) => { say(errText(e)); return null; });
  if (!first) return;
  const x = first.customer;
  const name = h('input', { value: x.name }) as HTMLInputElement, email = h('input', { type: 'email', value: x.email }) as HTMLInputElement, remark = h('input', { value: x.remark }) as HTMLInputElement;
  const draw = (r: NonNullable<typeof first>) => {
    const k = c.customers.cols, oc = c.orders.cols, wc = c.wd.cols, dc = c.dep.cols;
    statsBox.replaceChildren(h('div', { class: 'stats' }, stat(k.total, usd(r.stats.total), 'USDT'), stat(k.count, String(r.stats.count)), stat(k.fees, usd(r.stats.fees), 'USDT'), stat(k.unmatched, usd(r.stats.unmatched), 'USDT')));
    tables.replaceChildren(...([
      me.order_mode.enabled ? h('h3', { class: 'h-sm m0' }, cd.orders) : null,
      me.order_mode.enabled ? table([oc.id, oc.amount, oc.matched, oc.status, oc.created], r.orders.map((o) => [mono(o.order_no), usd(o.amount), usd(o.matched), orderBadge(o.status), t(o.created_at)]), c.common.none) : null,
      h('h3', { class: 'h-sm m0' }, cd.deposits),
      table([dc.time, dc.amount, dc.credited, dc.match, dc.status], r.deposits.map((d) => [t(d.time), usd(d.amount), d.result === 'credited' ? usd(d.credited) : '—', depOrder(d), depResult(d)]), c.common.none),
      h('h3', { class: 'h-sm m0' }, cd.payouts),
      table([wc.time, wc.id, wc.amount, wc.status], r.payouts.map((w) => [t(w.created_at), mono(w.withdrawal_no), usd(w.amount), wdBadge(w.status)]), c.common.none),
    ].filter(Boolean) as Node[]));
  };
  rangeSel.addEventListener('change', async () => draw(await D.customer(id, Number(rangeSel.value))));
  draw(first);
  const exp = D.exportUrl('customer', id);
  const body = h('div', { class: 'stack' },
    x.addresses?.length
      ? h('div', { class: 'stack-sm' }, h('dl', { class: 'kv' }, h('dt', {}, c.customers.cols.id), h('dd', {}, mono(x.customer_id))), h('h3', { class: 'h-sm m0' }, cd.addresses), addressCards(x.addresses))
      : h('dl', { class: 'kv' }, h('dt', {}, c.customers.cols.id), h('dd', {}, mono(x.customer_id)),
        h('dt', {}, cd.address), h('dd', {}, x.address ? h('span', { class: 'copy-row' }, mono(x.address), copyBtn(() => x.address || '', c.common.copy, c.common.copied, 'link-copy')) : h('span', { class: 'muted', 'data-on-demand': '' }, cd.onDemand))),
    h('div', { class: 'fgrid fgrid-3' }, field('mcd-name', c.customers.create.name, name), field('mcd-email', c.customers.create.email, email), field('mcd-remark', c.customers.create.remark, remark)),
    h('div', { class: 'row-actions' }, h('label', { class: 'inline-label' }, cd.range, rangeSel),
      exp ? h('a', { class: 'btn btn-outline btn-sm', href: exp, download: '' }, cd.statement) : h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => say(cd.exported) }, cd.statement)),
    statsBox, tables);
  dialog(x.name ? `${x.name} · ${x.customer_id}` : x.customer_id, body, cd.save, async () => {
    try { await D.saveCustomer({ customer_id: id, name: name.value.trim(), email: email.value.trim(), remark: remark.value.trim() }); }
    catch (e) { fieldErr(email, errText(e)); return false; }
    say(cd.saved); await refresh();
  });
}

// ---------- 订单 ----------
const ORDER_CLS: Record<string, string> = { pending: 'invited', partial: 'in_progress', completed: 'approved', overpaid: 'submitted', expired: 'expired', expired_partial: 'needs_info' };
const orderBadge = (s: string) => status(ORDER_CLS[s] || 'invited', (c.orders.status as Record<string, string>)[s] || s);
let orderFilter = 'all', orderCust = '';
const settingsNote = () => { const m = me.order_mode; return tpl(c.orders.settings, { low: pct(m.low), high: pct(m.high), ttl: m.ttlMin, lookback: m.lookbackH }); };
/** 原型：付款页面拿不到商户后台里新建的订单，用链接参数带过去 */
const payLink = (o: OrderFull) => (PROTO ? `${o.pay_url}?a=${fmtUsdt(units(o.amount), 0).replace(/,/g, '')}&addr=${o.address}&exp=${Date.parse(o.expires_at)}&got=${units(o.matched)}` : o.pay_url);
render.orders = async (p) => {
  if (!me.order_mode.enabled) { p.replaceChildren(toolbar(c.orders.title), h('p', { class: 'note-box' }, c.orders.modeOff)); return; }
  const all = await D.orders('', orderCust);
  const filters = h('div', { class: 'filters', role: 'group' }, ...['all', 'pending', 'partial', 'completed', 'overpaid', 'expired', 'expired_partial'].map((k) => {
    const n = k === 'all' ? all.length : all.filter((o) => o.status === k).length;
    return h('button', { type: 'button', 'aria-pressed': String(orderFilter === k), onclick: () => { orderFilter = k; render.orders(p); } }, `${k === 'all' ? c.common.all : (c.orders.status as Record<string, string>)[k]} ${n}`);
  }));
  const cust = h('input', { type: 'search', class: 'input-sm', placeholder: c.orders.filterCustomer, value: orderCust }) as HTMLInputElement;
  cust.addEventListener('change', () => { orderCust = cust.value.trim(); render.orders(p); });
  const list = all.filter((o) => orderFilter === 'all' || o.status === orderFilter);
  const oc = c.orders.cols;
  p.replaceChildren(
    toolbar(c.orders.title, cust, h('button', { type: 'button', class: 'btn btn-primary', onclick: createOrder }, c.orders.new)),
    h('p', { class: 'note-box', 'data-order-settings': '' }, settingsNote()),
    filters,
    table([oc.id, oc.merchantNo, oc.customer, oc.amount, oc.matched, oc.status, `${oc.created} · ${oc.expires}`],
      list.map((o) => [mono(o.order_no), o.merchant_order_no, custLink(o.customer_id), usd(o.amount), units(o.matched) ? usd(o.matched) : '—', orderBadge(o.status), sub(t(o.created_at), t(o.expires_at))]),
      c.common.none, { onRow: (i) => orderDetail(list[i].order_no), rowAttrs: (i) => ({ 'data-order': list[i].order_no }), page: pg(all) }),
  );
};
async function orderDetail(id: string) {
  const cd = c.orders.detail;
  const box = h('div', { class: 'stack' });
  const draw = async () => {
    const { order: o, unmatched: free } = await D.order(id);
    const url = payLink(o);
    const pctNow = units(o.amount) ? Math.round((units(o.matched) / units(o.amount)) * 1000) / 10 : 0;
    const dc = c.dep.cols;
    const act = (d: { id: string }, on: boolean) => h('button', { type: 'button', class: 'btn btn-outline btn-sm', [on ? 'data-match' : 'data-unmatch']: d.id, onclick: async () => {
      try { await D.match(o.order_no, d.id, on); say(cd.done); await draw(); } catch (e) { say(errText(e)); }
    } }, on ? cd.match : cd.unmatch);
    box.replaceChildren(
      h('dl', { class: 'kv' },
        h('dt', {}, c.orders.cols.merchantNo), h('dd', {}, o.merchant_order_no),
        h('dt', {}, cd.customer), h('dd', {}, mono(o.customer_id)),
        h('dt', {}, c.orders.cols.amount), h('dd', {}, `${usd(o.amount)} USDT`),
        h('dt', {}, c.orders.cols.matched), h('dd', {}, tpl(cd.sum, { sum: usd(o.matched), amount: usd(o.amount), pct: pctNow })),
        h('dt', {}, c.orders.cols.status), h('dd', {}, orderBadge(o.status)),
        h('dt', {}, c.orders.cols.expires), h('dd', {}, t(o.expires_at)),
        // K1：没指定链的订单不给地址，付款人在付款页选了网络才给这条链的地址
        h('dt', {}, cd.network), h('dd', {}, o.chain ? chainTag(o.chain) : enabledChains.length ? tpl(cd.anyChain, { list: enabledChains.map((ch) => netName(ch)).join(' / ') }) : (o.network || '—')),
        h('dt', {}, cd.address), h('dd', {}, o.address ? mono(o.address) : h('span', { class: 'muted', 'data-payer-picks': '' }, cd.payerPicks))),
      ...(o.address ? [h('p', { class: 'hint muted m0' }, tpl(cd.addressNote, { c: o.customer_id }))] : []),
      h('div', { class: 'f' }, h('span', { class: 'lbl' }, cd.payLink), h('div', { class: 'copy-row' }, mono(o.pay_url), copyBtn(() => o.pay_url, cd.copyLink, c.common.copied)), h('a', { class: 'link-copy', href: url, target: '_blank', rel: 'noopener', 'data-open-pay': '' }, cd.open + ' ↗')),
      h('h3', { class: 'h-sm m0' }, cd.matchedTitle),
      table([dc.time, dc.amount, cd.how, ''], o.deposits.map((d) => [t(d.time), usd(d.amount), (cd.types as Record<string, string>)[d.matched_by] || d.matched_by, act(d, false)]), cd.none),
      h('h3', { class: 'h-sm m0' }, cd.unmatchedTitle),
      table([dc.time, dc.amount, ''], free.map((d) => [t(d.time), usd(d.amount), act(d, true)]), cd.none),
    );
  };
  try { await draw(); } catch (e) { say(errText(e)); return; }
  dialog(tpl(cd.title, { id }), box, c.common.close, null, false, true);
  dlgEl.addEventListener('close', refresh, { once: true });
}
// ---------- 客户选择框（创建订单、代付共用） ----------
// 按客户编号、名称、邮箱模糊搜索（服务端解密邮箱后比对）；选中已有客户时回调里带着客户资料，输入新的编号时 cust 为 null。
// 不用浏览器自带的 datalist：它在弹窗里的位置由浏览器决定，会跑偏，也不能在选中后带出其他字段。
type Picked = { id: string; cust: Cust | null };
function customerPicker(id: string, onChange: (p: Picked) => void) {
  const cp = c.picker;
  const input = h('input', { id, autocomplete: 'off', spellcheck: false, role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': `${id}-list`, placeholder: cp.placeholder }) as HTMLInputElement;
  const list = h('ul', { id: `${id}-list`, class: 'picker-list', role: 'listbox' });
  list.hidden = true;
  let items: Cust[] = [], active = -1, seq = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const opts = () => [...list.querySelectorAll<HTMLElement>('.picker-opt')];
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
  const choose = (i: number) => {
    const q = input.value.trim();
    if (i < items.length) { input.value = items[i].customer_id; onChange({ id: items[i].customer_id, cust: items[i] }); } else onChange({ id: q, cust: null });
    close();
  };
  const mark = () => opts().forEach((o, i) => o.setAttribute('aria-selected', String(i === active)));
  const draw = (q: string) => {
    const rows: HTMLElement[] = items.map((x, i) => h('li', { role: 'option', class: 'picker-opt', onmousedown: (e: Event) => { e.preventDefault(); choose(i); } },
      h('b', {}, x.customer_id), [x.name, x.email].some(Boolean) ? h('span', { class: 'muted' }, [x.name, x.email].filter(Boolean).join(' · ')) : null));
    if (q && CUST_RE.test(q) && !items.some((x) => x.customer_id === q)) rows.push(h('li', { role: 'option', class: 'picker-opt picker-new', onmousedown: (e: Event) => { e.preventDefault(); choose(items.length); } }, tpl(cp.newCustomer, { id: q })));
    if (!rows.length) rows.push(h('li', { class: 'picker-empty muted' }, q ? cp.none : cp.empty));
    list.replaceChildren(...rows);
    list.hidden = false; input.setAttribute('aria-expanded', 'true');
  };
  const search = async () => {
    const q = input.value.trim(), my = ++seq;
    let r: Cust[] = [];
    try { r = (await D.customers(q, true)).slice(0, 8); } catch { /* 搜索失败时只显示"新建" */ }
    if (my !== seq || document.activeElement !== input) return;
    items = r; active = -1; draw(q);
    const exact = r.find((x) => x.customer_id === q);
    onChange({ id: q, cust: exact || null }); // 手动输入了完整的已有编号，也按已有客户处理
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 200); });
  input.addEventListener('focus', () => { search(); });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    const n = opts().length;
    if (e.key === 'ArrowDown' && n) { e.preventDefault(); active = (active + 1) % n; mark(); }
    else if (e.key === 'ArrowUp' && n) { e.preventDefault(); active = (active - 1 + n) % n; mark(); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } // 只关闭列表，不关闭弹窗
  });
  return { input, wrap: h('div', { class: 'picker' }, input, list) };
}
/** field() 会把 id 设在传入的元素上：选择框的 id 要留在输入框上 */
function pickerField(id: string, label: string, picker: { input: HTMLInputElement; wrap: HTMLElement }, hint?: string) {
  const f = field(id, label, picker.wrap, hint);
  picker.wrap.removeAttribute('id'); picker.input.id = id;
  return f;
}

async function createOrder() {
  const cc = c.orders.create;
  const cname = h('input', { autocomplete: 'off' }) as HTMLInputElement, cemail = h('input', { type: 'email', autocomplete: 'off' }) as HTMLInputElement;
  const who = h('p', { class: 'hint m0' });
  let wasExisting = false;
  const picker = customerPicker('mo-cust', ({ id, cust: x }) => {
    // 已有客户：带出名称和邮箱，只读（资料在"客户"页面修改）；新客户：可以填写
    if (x) { cname.value = x.name; cemail.value = x.email; } else if (wasExisting) { cname.value = ''; cemail.value = ''; }
    wasExisting = !!x;
    cname.readOnly = cemail.readOnly = !!x;
    who.textContent = !id ? '' : x ? c.picker.existing : CUST_RE.test(id) ? c.picker.isNew : '';
  });
  const cust = picker.input;
  const no = h('input', { autocomplete: 'off', value: `ORDER-${Date.now().toString(36).toUpperCase()}` }) as HTMLInputElement;
  const amt = h('input', { inputmode: 'decimal', autocomplete: 'off' }) as HTMLInputElement;
  if (!enabledChains.length && !PROTO) { try { enabledChains = (await D.overview()).chains || []; } catch { /* 读不到时不显示选链 */ } }
  const choice = (value: string, title: string, hint: string, disabled = false, extra: Node | null = null) => h('label', { class: `chain-choice${disabled ? ' disabled' : ''}` },
    h('input', { type: 'radio', name: 'mo-chain', value, checked: value === '', disabled }), h('span', {}, h('b', {}, title), extra, hint ? h('span', { class: 'hint muted' }, hint) : null));
  const chainBox = enabledChains.length ? h('fieldset', { class: 'f chain-choices', 'data-chain-choice': '' }, h('legend', { class: 'lbl' }, cc.chain),
    choice('', cc.chainAny, cc.chainAnyHint),
    ...['eth', 'bsc'].filter((ch) => enabledChains.includes(ch)).map((ch) => choice(ch, tpl(cc.chainOnly, { net: netName(ch), std: netStd(ch) }), ch === 'eth' ? cc.ethHint : '')),
    choice('tron', tpl(cc.chainOnly, { net: netName('tron'), std: netStd('tron') }), c.chain.laterNote, true, laterTag())) : null;
  const body = h('div', { class: 'stack' }, pickerField('mo-cust', cc.customer, picker, cc.customerHint), who,
    h('div', { class: 'fgrid' }, field('mo-cname', `${cc.customerName} (${c.common.optional})`, cname), field('mo-cemail', `${cc.customerEmail} (${c.common.optional})`, cemail)),
    field('mo-no', cc.merchantNo, no, cc.merchantNoHint), field('mo-amt', cc.amount, amt), chainBox, h('p', { class: 'hint muted m0' }, settingsNote()));
  dialog(cc.title, body, cc.submit, async () => {
    const cid = cust.value.trim();
    let bad = fieldErr(cust, CUST_RE.test(cid) ? null : cc.errCustomer);
    bad = fieldErr(no, /^[A-Za-z0-9_-]{1,64}$/.test(no.value.trim()) ? null : cc.errMerchantNo) || bad;
    bad = fieldErr(amt, parseUsdt(amt.value) ? null : cc.errAmount) || bad;
    if (bad) return false;
    let o: OrderFull;
    // 已有客户不再传名称和邮箱（服务端也只在新建客户时使用）
    try { o = await D.createOrder({ customer_id: cid, customer_name: (!cname.readOnly && cname.value.trim()) || undefined, customer_email: (!cemail.readOnly && cemail.value.trim()) || undefined, merchant_order_no: no.value.trim(), amount: amt.value.replace(/[,\s]/g, ''), chain: chainBox?.querySelector<HTMLInputElement>('input:checked')?.value || undefined }); }
    catch (e) {
      const f = (e as ApiErr).field;
      fieldErr(f === 'merchant_order_no' ? no : f === 'customer_email' ? cemail : f === 'customer_id' ? cust : amt, (e as ApiErr).code === 'duplicate_merchant_order_no' ? cc.errDup : errText(e));
      return false;
    }
    if (units(o.matched) > 0) say(cc.matchedNow);
    orderFilter = 'all'; orderCust = '';
    await go('orders');
    setTimeout(() => orderDetail(o.order_no), 0);
  });
}

// ---------- 交易 ----------
let txTab: 'deposits' | 'ledger' = 'deposits', onlyUnmatched = false, txCust = '';
render.transactions = async (p) => {
  const ct = c.tx;
  const tabs = h('div', { class: 'filters', role: 'tablist' },
    h('button', { type: 'button', 'aria-pressed': String(txTab === 'deposits'), onclick: () => { txTab = 'deposits'; render.transactions(p); } }, ct.tabDeposits),
    h('button', { type: 'button', 'aria-pressed': String(txTab === 'ledger'), onclick: () => { txTab = 'ledger'; render.transactions(p); } }, ct.tabLedger));
  const cust = h('input', { type: 'search', class: 'input-sm', placeholder: c.orders.filterCustomer, value: txCust }) as HTMLInputElement;
  cust.addEventListener('change', () => { txCust = cust.value.trim(); render.transactions(p); });
  const um = h('input', { type: 'checkbox', checked: onlyUnmatched }) as HTMLInputElement;
  um.addEventListener('change', () => { onlyUnmatched = um.checked; render.transactions(p); });
  const lc = ct.ledgerCols;
  let content: HTMLElement;
  if (txTab === 'deposits') content = depositTable(await D.deposits(txCust, onlyUnmatched), true);
  else {
    const rows = await D.ledger(txCust);
    content = h('div', { class: 'stack' }, h('p', { class: 'hint muted m0' }, ct.ledgerNote),
      table([lc.time, lc.type, c.dep.cols.customer, lc.amount, lc.balance, lc.ref], rows.map((l) => [t(l.created_at), ct.ledgerTypes[l.type], l.customer_id ? mono(l.customer_id) : '—',
        h('span', { class: units(l.amount) < 0 ? 'neg' : 'pos' }, (units(l.amount) > 0 ? '+' : '') + usd(l.amount)), usd(l.available_after), mono(l.ref)]), c.common.none, { page: pg(rows) }));
  }
  const exp = D.exportUrl(txTab);
  p.replaceChildren(toolbar(ct.title, cust, txTab === 'deposits' && me.order_mode.enabled ? h('label', { class: 'inline-label' }, um, c.dep.filterUnmatched) : null,
    exp ? h('a', { class: 'btn btn-outline', href: exp, download: '' }, c.common.export) : h('button', { type: 'button', class: 'btn btn-outline', onclick: () => say(c.common.exported) }, c.common.export)), tabs, content);
};

// ---------- 提币 ----------
const WD_CLS: Record<string, string> = { pending: 'submitted', rejected: 'rejected', cancelled: 'expired', approved: 'invited', signing: 'invited', broadcast: 'in_progress', completed: 'approved', failed: 'needs_info' };
const wdBadge = (s: string) => status(WD_CLS[s] || 'submitted', (c.wd.status as Record<string, string>)[s] || s);
render.withdraw = async (p) => {
  const cw = c.wd;
  const [ov, list] = await Promise.all([D.overview(), D.withdrawals()]);
  const available = units(ov.available);
  // P5：余额一个数，提的时候选链；提现只能提到这条链上登记过的地址（{ chain, address }，老数据的字符串是 TRON）
  const wallets = (me.cashout_wallets || []).map((w) => (typeof w === 'string' ? { chain: 'tron', address: w } : w));
  const regOf = (ch: string) => wallets.filter((w) => w.chain === ch).map((w) => w.address);
  const kindCash = h('input', { type: 'radio', name: 'wd-kind', value: 'cashout', checked: true }) as HTMLInputElement;
  const kindPayout = h('input', { type: 'radio', name: 'wd-kind', value: 'payout' }) as HTMLInputElement;
  const chainSel = h('select', {}, ...CHAINS.map((ch) => h('option', { value: ch }, `${netName(ch)}（${netStd(ch)}）${regOf(ch).length ? '' : cw.chainNone}`))) as HTMLSelectElement;
  chainSel.value = CHAINS.find((ch) => regOf(ch).length) || 'eth';
  const toSel = h('select', { class: 'mono-input' }) as HTMLSelectElement;
  const noReg = h('p', { class: 'alert m0', 'data-no-wallet': '' });
  const payTo = h('input', { autocomplete: 'off', spellcheck: false, class: 'mono-input' }) as HTMLInputElement;
  const custWho = h('p', { class: 'hint m0' });
  const custPicker = customerPicker('mw-cust', ({ id, cust: x }) => { custWho.textContent = !id ? '' : x ? [x.customer_id, x.name, x.email].filter(Boolean).join(' · ') : CUST_RE.test(id) ? c.picker.isNew : ''; });
  const custIn = custPicker.input;
  const amt = h('input', { inputmode: 'decimal', autocomplete: 'off' }) as HTMLInputElement;
  const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6' }) as HTMLInputElement;
  const toField = field('mw-to', cw.toRegistered, toSel);
  const payField = field('mw-pay-to', cw.payTo, payTo);
  const custField = h('div', { class: 'stack' }, pickerField('mw-cust', cw.customer, custPicker, cw.customerHint), custWho);
  const fee = h('b'), freeze = h('b'), after = h('b');
  const summary = h('dl', { class: 'kv kv-tight' }, h('dt', {}, cw.fee), h('dd', {}, fee), h('dt', {}, cw.freeze), h('dd', {}, freeze), h('dt', {}, cw.after), h('dd', {}, after));
  const upd = () => {
    const a = parseUsdt(amt.value) || 0;
    const f = a ? calcFee(a, me.fee_out) : 0;
    const rule = describeFee(me.fee_out, lang);
    fee.textContent = !a ? rule : lang === 'en' ? `${fmtUsdt(f)} USDT (${rule})` : `${fmtUsdt(f)} USDT（${rule}）`;
    freeze.textContent = a ? `${fmtUsdt(a + f)} USDT` : '—';
    after.textContent = `${fmtUsdt(available - (a ? a + f : 0))} USDT`;
    after.classList.toggle('neg', a + f > available);
  };
  amt.addEventListener('input', upd);
  const onChange = () => {
    const ch = chainSel.value, cash = kindCash.checked, reg = regOf(ch);
    toSel.replaceChildren(...reg.map((a) => h('option', { value: a }, a)));
    noReg.textContent = tpl(cw.noWalletChain, { net: netName(ch) });
    toField.hidden = !cash || !reg.length; noReg.hidden = !cash || reg.length > 0;
    payField.hidden = cash; custField.hidden = cash;
    payTo.placeholder = ch === 'tron' ? 'T…' : '0x…';
  };
  chainSel.addEventListener('change', onChange); kindCash.addEventListener('change', onChange); kindPayout.addEventListener('change', onChange);
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, cw.submit) as HTMLButtonElement;
  const form = h('form', { class: 'card form-card wd-form', novalidate: true },
    h('div', { class: 'f' }, h('span', { class: 'lbl' }, cw.kind), h('div', { class: 'choices' }, h('label', {}, kindCash, cw.kindCashout), h('label', {}, kindPayout, cw.kindPayout))),
    field('mw-chain', cw.chain, chainSel, tpl(cw.chainFee, { fee: `${describeFee(me.fee_out, lang)}` })), toField, noReg, payField, custField, field('mw-amt', cw.amount, amt), summary, field('mw-code', cw.code, code), submit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const cash = kindCash.checked, ch = chainSel.value;
    const a = parseUsdt(amt.value);
    const cid = custIn.value.trim();
    // 和服务器（server/pay/core.js 的 chainAddress）同一套规则：全 0 地址付不出去，不收
    const okAddr = (v: string) => (ch === 'tron' ? isTronAddress(v) && v.trim() !== 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb' : isChecksumAddress(v.trim()) && !/^0x0{40}$/i.test(v.trim()));
    let bad = cash ? !regOf(ch).length : fieldErr(payTo, okAddr(payTo.value) ? null : tpl(cw.errAddressChain, { net: netName(ch) }));
    if (!cash) bad = fieldErr(custIn, !cid || CUST_RE.test(cid) ? null : c.orders.create.errCustomer) || bad;
    const f = a ? calcFee(a, me.fee_out) : 0;
    bad = fieldErr(amt, !a ? cw.errAmount : a + f > available ? cw.errInsufficient : null) || bad;
    bad = fieldErr(code, /^\d{6}$/.test(code.value.trim()) ? null : cw.errCode) || bad;
    if (bad) return;
    submit.disabled = true;
    try {
      const w = await D.withdraw({ kind: cash ? 'cashout' : 'payout', chain: ch, to: cash ? toSel.value : payTo.value.trim(), amount: amt.value.replace(/[,\s]/g, ''), customer_id: !cash && cid ? cid : undefined, code: code.value.trim() });
      say(tpl(cw.submitted, { amount: usd(units(w.amount) + units(w.fee)) }));
      await render.withdraw(p); updateCounts();
    } catch (err) {
      const k = (err as ApiErr).code;
      fieldErr(k === 'bad_code' ? code : k === 'invalid_address' || k === 'address_not_registered' ? (cash ? toSel : payTo) : amt, errText(err));
    } finally { submit.disabled = false; }
  });
  onChange(); upd();
  const cc = cw.cols;
  p.replaceChildren(
    toolbar(cw.title),
    h('div', { class: 'note-box', 'data-sla': '' }, cw.note),
    h('div', { class: 'wd-grid' }, h('div', {}, h('h2', { class: 'h-sm' }, cw.new), form),
      h('div', { class: 'stats stats-col' }, stat(c.overview.available, usd(ov.available), cw.balanceNote), stat(c.overview.frozen, usd(ov.frozen), 'USDT'))),
    h('h2', { class: 'h-sm' }, cw.history),
    table([cc.time, cc.id, cw.chainCol, cc.kind, cc.customer, cc.to, cc.amount, cc.fee, cc.source, cc.status], list.map((w: Wd) => {
      const st = h('span', { class: 'status-cell' }, wdBadge(w.status));
      // 批量打款里的单只能看：要取消就在"批量打款"里整批取消还没审核的部分
      if (w.status === 'pending' && !w.batch_no) st.append(h('button', { type: 'button', class: 'link-btn', onclick: () => cancelWd(w, p) }, cw.cancel));
      if (w.reason) st.append(h('span', { class: 'hint muted' }, `${cw.reason}：${w.reason}`));
      return [t(w.created_at), mono(w.withdrawal_no), chainTag(w.chain || 'tron'), cw.kinds[w.kind], w.customer_id ? mono(w.customer_id) : '—', mono(shortAddr(w.to), w.to), usd(w.amount), usd(w.fee), w.batch_no ? tpl(cw.sourceBatch, { no: w.batch_no }) : cw.sources[w.source], st];
    }), c.common.none, { page: pg(list) }),
  );
};

// ---------- 批量打款（第 3 批）：上传 → 逐行检查 → 按链汇总 + 动态码提交；批次记录、明细、取消还没审核的 ----------
type PbRow = { line: number; chain: string; to: string; amount: Amount; amount_text: string; fee: Amount; ok: boolean; errors: string[]; warnings: string[] };
type PbCheck = { rows: PbRow[]; totals: Record<string, { count: number; amount: string; fee: string; total: string }>; ok_count: number; bad_count: number; need: Amount; available: Amount; enough: boolean; service: { open: boolean; next_open_at?: string } };
const pb = { step: 1, csv: '', check: null as PbCheck | null, onlyValid: false, err: '', done: null as null | { n: number; no: string; late: boolean } };
const PB_ST: Record<string, string> = { pending: 'submitted', approved: 'invited', partially_rejected: 'needs_info', rejected: 'rejected', completed: 'approved', cancelled: 'expired' };
render['payout-batch'] = async (p) => {
  const cp = c.pb;
  const list = await D.raw('payout-batches');
  const reset = () => { pb.step = 1; pb.csv = ''; pb.check = null; pb.onlyValid = false; pb.err = ''; render['payout-batch'](p); };
  const resetBtn = h('button', { type: 'button', class: 'btn btn-outline', 'data-mb-reset': '', onclick: reset }, cp.reupload);
  const stepper = h('ol', { class: 'stepper-3', 'data-steps': String(pb.step) }, ...cp.steps.map((x: string, i: number) => h('li', { class: i + 1 < pb.step ? 'done' : i + 1 === pb.step ? 'on' : '' }, x)));
  let body: HTMLElement;
  if (pb.step === 1) {
    const file = h('input', { type: 'file', accept: '.csv,text/csv', 'data-mb-file': '', class: 'visually-hidden' }) as HTMLInputElement;
    file.addEventListener('change', async () => {
      const f = file.files?.[0]; if (!f) return;
      pb.csv = await f.text(); pb.err = ''; pb.done = null;
      try { pb.check = await D.raw('payout-batch-check', { csv: pb.csv }); pb.step = 2; }
      catch (e) {
        const k = (e as ApiErr).code;
        const n = pb.csv.split(/\r?\n/).filter((x) => x.trim()).length - 1;
        pb.err = k === 'too_many_items' ? tpl(cp.tooMany, { n }) : k === 'invalid_sheet' ? cp.badSheet : errText(e);
      }
      render['payout-batch'](p);
    });
    const tplHref = URL.createObjectURL(new Blob(['﻿chain,to,amount,customer_id,merchant_ref\n'], { type: 'text/csv' }));
    body = h('div', { class: 'card upload-card stack', 'data-mb-step': '1' },
      h('h2', { class: 'h-sm m0' }, cp.uploadTitle), h('p', { class: 'muted m0' }, cp.uploadHint),
      h('div', {}, h('label', { class: 'btn btn-primary btn-lg' }, cp.choose, file)),
      h('p', { class: 'hint muted m0' }, mono(cp.header), ' · ', h('a', { href: tplHref, download: 'payouts-template.csv' }, cp.template)),
      pb.err ? h('div', { class: 'stack-sm' }, h('p', { class: 'alert m0', 'data-mb-error': '' }, pb.err), h('div', {}, resetBtn)) : null,
      pb.done ? h('div', { class: 'info-box', 'data-mb-done': '' }, tpl(cp.submitted, { n: pb.done.n, no: pb.done.no }), pb.done.late ? h('b', { class: 'block' }, ` ${cp.late}`) : null) : null);
  } else if (pb.step === 2 && pb.check) {
    const k = pb.check;
    const warn = k.rows.filter((r) => r.ok && r.warnings.length).length;
    const msg = (r: PbRow) => {
      if (r.ok && !r.warnings.length) return h('span', { class: 'ok' }, `✓ ${cp.ok}`);
      const parts = r.errors.map((e) => e === 'invalid_amount' && /\.\d{7,}/.test(r.amount_text) ? cp.err.decimals : tpl((cp.err as Record<string, string>)[e] || e, { net: netName(r.chain) }));
      return h('span', { class: r.ok ? 'warn' : 'bad' }, ...(r.ok ? r.warnings.map((w) => `! ${(cp.err as Record<string, string>)[w] || w}`) : parts.map((x) => `× ${x}`)));
    };
    const only = h('input', { type: 'checkbox', id: 'mb-only-valid', checked: pb.onlyValid }) as HTMLInputElement;
    only.addEventListener('change', () => { pb.onlyValid = only.checked; note.hidden = true; });
    const note = h('p', { class: 'alert m0' }, cp.needOnlyValid); note.hidden = true;
    const next = h('button', { type: 'button', class: 'btn btn-primary', 'data-mb-next': '', disabled: !k.ok_count, onclick: () => {
      if (k.bad_count && !only.checked) { note.hidden = false; return; }
      pb.step = 3; render['payout-batch'](p);
    } }, cp.next);
    body = h('div', { class: 'card stack', 'data-mb-step': '2' },
      h('p', { class: 'm0' }, h('b', {}, tpl(cp.summary, { n: k.rows.length, ok: k.ok_count, bad: k.bad_count, warn })), ' ', h('span', { class: 'muted' }, cp.summaryNote)),
      table([cp.cols.line, cp.cols.chain, cp.cols.to, cp.cols.amount, cp.cols.check], k.rows.map((r) => [tpl(cp.lineNo, { n: r.line + 1 }), CHAINS.includes(r.chain as any) ? netName(r.chain) : r.chain || '—', mono(shortAddr(r.to || '—'), r.to), r.amount_text, msg(r)]), c.common.none,
        { rowAttrs: (i) => ({ 'data-row-line': String(k.rows[i].line), class: !k.rows[i].ok ? 'row-bad' : k.rows[i].warnings.length ? 'row-warn' : '' }), page: { size: 100, more: (n) => tpl(c.common.more, { n }) } }),
      h('p', { class: 'hint muted m0' }, cp.lineNote),
      k.bad_count ? h('label', { class: 'check-row' }, only, tpl(cp.onlyValid, { n: k.ok_count })) : null, note,
      h('div', { class: 'row-actions spread' }, resetBtn, next));
  } else {
    const k = pb.check!;
    const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6' }) as HTMLInputElement;
    const sub = h('button', { type: 'button', class: 'btn btn-primary', 'data-mb-submit': '', disabled: !k.enough }, cp.submit) as HTMLButtonElement;
    const failBox = h('div');
    sub.addEventListener('click', async () => {
      if (fieldErr(code, /^\d{6}$/.test(code.value.trim()) ? null : c.wd.errCode)) return;
      sub.disabled = true;
      try {
        const r = await D.raw('payout-batch-submit', { csv: pb.csv, code: code.value.trim(), only_valid: pb.onlyValid });
        pb.done = { n: r.accepted.length, no: r.batch_no, late: r.service && r.service.open === false };
        pb.step = 1; pb.csv = ''; pb.check = null; pb.onlyValid = false;
        await render['payout-batch'](p); updateCounts();
      } catch (e) {
        sub.disabled = false;
        if ((e as ApiErr).code === 'bad_code') fieldErr(code, errText(e));
        else failBox.replaceChildren(h('p', { class: 'alert m0' }, tpl(cp.failed, { why: errText(e) })));
      }
    });
    body = h('div', { class: 'card stack', 'data-mb-step': '3' },
      h('h2', { class: 'h-sm m0' }, cp.sumTitle),
      table([cp.cols.chain, cp.cols.count, cp.cols.amount, cp.cols.fee, cp.cols.total], Object.entries(k.totals).map(([ch, x]) => [chainTag(ch), String(x.count), usd(x.amount), usd(x.fee), h('b', {}, usd(x.total))]), c.common.none,
        { rowAttrs: (i) => ({ 'data-sum-chain': Object.keys(k.totals)[i] }) }),
      h('p', { class: 'm0', 'data-mb-available': '' }, tpl(cp.available, { v: usd(k.available) })),
      h('p', { class: 'm0' }, h('b', {}, tpl(cp.need, { v: usd(k.need) }))),
      !k.enough ? h('p', { class: 'alert m0', 'data-mb-short': '' }, tpl(cp.notEnough, { need: usd(k.need), have: usd(k.available) })) : null,
      k.service && !k.service.open ? h('p', { class: 'warn-box m0' }, cp.late) : null,
      field('mb-code', cp.code, code), failBox,
      h('div', { class: 'row-actions spread' }, h('button', { type: 'button', class: 'btn btn-outline', onclick: () => { pb.step = 2; render['payout-batch'](p); } }, cp.back), resetBtn, sub));
  }
  const items = list.items as { batch_no: string; status: string; count: number; total: Amount; created_at: string; source: string }[];
  p.replaceChildren(
    toolbar(cp.title, h('span', { class: 'muted' }, cp.sub)),
    stepper, body,
    h('p', { class: 'info-box' }, cp.apiNote),
    h('h2', { class: 'h-sm' }, cp.history),
    table([cp.cols.batch, cp.cols.source, cp.cols.count, cp.cols.total, cp.cols.status, cp.cols.time, ''], items.map((b) => [
      mono(b.batch_no), (cp.sources as Record<string, string>)[b.source] || b.source, String(b.count), usd(b.total),
      status(PB_ST[b.status] || 'submitted', (cp.status as Record<string, string>)[b.status] || b.status), t(b.created_at),
      h('span', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => pbDetail(b.batch_no) }, cp.view),
        b.status === 'pending' ? h('button', { type: 'button', class: 'link-btn bad', 'data-mb-cancel': '', onclick: () => pbCancel(b.batch_no, p) }, cp.cancel) : null),
    ]), cp.none, { rowAttrs: (i) => ({ 'data-mb-batch': items[i].batch_no }) }),
  );
};
async function pbDetail(no: string) {
  let d: any;
  try { d = await D.raw('payout-batch', undefined, `&batch_no=${encodeURIComponent(no)}`); } catch (e) { say(errText(e)); return; }
  const cp = c.pb;
  dialog(tpl(cp.itemsTitle, { no }), table([c.wd.cols.id, cp.cols.chain, cp.cols.to, cp.cols.amount, cp.cols.fee, cp.cols.status, cp.tx], d.items.map((w: any) => [mono(w.withdrawal_no), chainTag(w.chain), mono(shortAddr(w.to), w.to), usd(w.amount), usd(w.fee),
    h('span', { class: 'status-cell' }, wdBadge(w.status), w.reason ? h('span', { class: 'hint muted' }, w.reason) : null), w.txid ? mono(shortAddr(w.txid), w.txid) : '—']), c.common.none), c.common.close, null, false, true);
}
function pbCancel(no: string, p: HTMLElement) {
  const cp = c.pb;
  dialog(tpl(cp.cancelTitle, { no }), h('p', { class: 'm0' }, cp.cancelConfirm), cp.cancel, async () => {
    try { const r = await D.raw('payout-batch-cancel', { batch_no: no }); say(tpl(cp.cancelled, { n: r.cancelled })); } catch (e) { say(errText(e)); return; }
    await render['payout-batch'](p); updateCounts();
  }, true);
}
function cancelWd(w: Wd, p: HTMLElement) {
  dialog(c.wd.cancel, h('p', { class: 'm0' }, c.wd.cancelConfirm), c.wd.cancel, async () => {
    try { await D.cancelWithdrawal(w.withdrawal_no); } catch (e) { say(errText(e)); return; }
    say(tpl(c.wd.cancelled, { amount: usd(units(w.amount) + units(w.fee)) }));
    await render.withdraw(p); updateCounts();
  }, true);
}

// ---------- API 设置 ----------
render.api = async (p) => {
  const ca = c.api;
  const info = await D.api();
  const cb = h('input', { type: 'url', value: info.callback_url, class: 'mono-input' }) as HTMLInputElement;
  const ips = h('textarea', { rows: '4', class: 'mono-input', placeholder: '203.0.113.10' }) as HTMLTextAreaElement;
  ips.value = info.ip_whitelist.join('\n');
  const warn = h('p', { class: 'alert m0', 'data-ip-warn': '' }, ca.ipWarn); warn.hidden = info.ip_whitelist.length > 0;
  const cbForm = h('form', { class: 'stack', novalidate: true }, field('mapi-cb', ca.callbackUrl, cb, ca.callbackHint),
    h('div', { class: 'row-actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, c.common.save),
      h('button', { class: 'btn btn-outline', type: 'button', onclick: async () => { try { await D.testCallback(); say(ca.testSent); } catch (e) { say(errText(e)); } } }, ca.test)));
  cbForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (fieldErr(cb, !cb.value.trim() || /^https:\/\/[^\s/]+\.[^\s]+$/.test(cb.value.trim()) ? null : ca.errCallback)) return;
    try { await D.saveCallback(cb.value.trim()); say(c.common.saved); } catch { fieldErr(cb, ca.errCallback); }
  });
  const ipForm = h('form', { class: 'stack', novalidate: true }, field('mapi-ip', ca.ipTitle, ips, ca.ipHint), warn, h('div', {}, h('button', { class: 'btn btn-primary', type: 'submit' }, c.common.save)));
  ipForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const lines = ips.value.split('\n').map((x) => x.trim()).filter(Boolean);
    const badLine = lines.findIndex((x) => !/^(\d{1,3}\.){3}\d{1,3}$/.test(x) && !/^[0-9a-fA-F:]+:[0-9a-fA-F:]*$/.test(x));
    if (fieldErr(ips, badLine >= 0 ? tpl(ca.errIp, { n: badLine + 1 }) : null)) return;
    try { await D.saveIps(lines); warn.hidden = lines.length > 0; say(c.common.saved); } catch (err) { fieldErr(ips, errText(err)); }
  });
  const regen = h('button', { type: 'button', class: 'btn btn-outline', onclick: () => {
    const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6' }) as HTMLInputElement;
    dialog(ca.regen, h('div', { class: 'stack' }, h('p', { class: 'm0' }, ca.regenConfirm), field('mapi-code', ca.regenCode, code)), ca.regen, async () => {
      let r: { api_key: string; api_secret: string };
      try { r = await D.regenerate(code.value.trim()); } catch (e) { fieldErr(code, errText(e)); return false; }
      setTimeout(() => dialog(ca.secret, h('div', { class: 'stack' }, h('p', { class: 'm0' }, ca.regenDone), h('dl', { class: 'kv' }, h('dt', {}, ca.key), h('dd', {}, mono(r.api_key)), h('dt', {}, ca.secret), h('dd', {}, h('span', { class: 'copy-row secret-box' }, mono(r.api_secret), copyBtn(() => r.api_secret, c.common.copy, c.common.copied))))), c.common.confirm, () => { refresh(); }), 0);
    }, true);
  } }, ca.regen);
  const m = info.order_mode;
  p.replaceChildren(
    toolbar(ca.title, h('a', { class: 'btn btn-outline', href: `${base}docs/` }, ca.docs)),
    h('section', { class: 'card stack' }, h('h2', { class: 'h-sm m0' }, ca.keyTitle),
      h('dl', { class: 'kv' }, h('dt', {}, ca.key), h('dd', {}, info.api_key ? h('span', { class: 'copy-row' }, mono(info.api_key), copyBtn(() => info.api_key!, c.common.copy, c.common.copied, 'link-copy')) : '—'),
        h('dt', {}, ca.secret), h('dd', {}, h('span', { class: 'mono' }, info.has_secret ? '••••••••••••••••' : '—'), h('p', { class: 'hint muted m0' }, ca.secretHidden))), h('div', {}, regen)),
    h('section', { class: 'card stack' }, h('h2', { class: 'h-sm m0' }, ca.modeTitle),
      h('p', { class: 'm0' }, status(m.enabled ? 'approved' : 'expired', m.enabled ? ca.modeOn : ca.modeOffShort)),
      h('p', { class: 'hint muted m0' }, m.enabled ? settingsNote() : c.orders.modeOff)),
    h('section', { class: 'card stack' }, h('h2', { class: 'h-sm m0' }, ca.callbackTitle), cbForm),
    h('section', { class: 'card stack' }, h('h2', { class: 'h-sm m0' }, ca.ipTitle), ipForm),
  );
};

// ---------- 回调记录 ----------
render.callbacks = async (p) => {
  const cc = c.cb;
  const rows = await D.callbacks();
  p.replaceChildren(
    toolbar(cc.title),
    table([cc.cols.time, cc.cols.id, cc.cols.event, cc.cols.ref, cc.cols.attempts, cc.cols.result, cc.cols.actions], rows.map((x) => {
      const kind = x.status === 'ok' ? 'ok' : x.status === 'failed' ? 'failed' : 'retrying';
      const res = h('span', { class: 'status-cell' }, status(kind === 'ok' ? 'approved' : kind === 'failed' ? 'needs_info' : 'submitted', x.status === 'pending' && !x.attempts ? cc.results.queued : tpl(cc.results[kind], { code: x.last_code ?? cc.results.noResponse })));
      if (x.next_at && x.attempts) res.append(h('span', { class: 'hint muted' }, tpl(cc.next, { t: t(x.next_at) })));
      return [t(x.created_at), mono(x.id), (cc.events as Record<string, string>)[x.event] || x.event, mono(x.ref || '—'), String(x.attempts), res,
        h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: async () => { try { await D.resend(x.id); say(tpl(cc.resent, { id: x.id })); await render.callbacks(p); } catch (e) { say(errText(e)); } } }, cc.resend)];
    }), c.common.none, { page: pg(rows) }),
  );
};

// ---------- 启动 ----------
(async () => {
  if (setupToken) { showView('setup'); return; }
  if (PROTO) { showView('login'); return; }
  try { const info = await D.me(); if (info.authed) { await enter(); return; } } catch { /* 显示登录 */ }
  showView('login');
})();
