// 运营后台：商户、归集、提币审核、异常到账、对账、钱包设置、系统状态。
// - 原型模式：使用 mock.ts 的模拟数据，签名只是模拟，密钥输入框的内容不会被读取或发送。
// - 正式模式：由 admin-pay-real.ts 负责（/api/wallet/，真实的浏览器签名）。
// 签名页面的核对规则：页面显示的收款地址和金额来自浏览器对交易原文的解码，不是服务器发来的文字。
import { calcFee, describeFee, fmtUsdt, parseUsdt, shortAddr, type FeeRule } from '../lib/money';
import * as M from './mock';
import { mountOverview, type OverviewData } from './admin-overview';
import { copyBtn, field, fieldErr, fmtTime, h, makeDialog, mono, stat, status, table, toast } from './ui';

const root = document.getElementById('admin-root')!;
const PROTO = root.dataset.prototype === '1';
const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!;
const say = (m: string) => toast(root, '[data-toast]', m);
export const dialog = makeDialog(root, 'p');
const t = (iso: string) => fmtTime(iso, 'zh');
const usd = (n: number) => fmtUsdt(n);
const U = 1_000_000;
const toolbar = (title: string, ...right: (HTMLElement | null)[]) => h('div', { class: 'toolbar' }, h('h1', { class: 'm0' }, title), h('div', { class: 'tool-actions' }, ...right));
export const minsAgo = (iso: string) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`; };
// 生产用主网的 Tronscan；测试环境和本地用 Nile 测试网的 Tronscan（主网上查不到测试网的交易）
export const TRONSCAN = root.dataset.walletEnv === 'production' ? 'https://tronscan.org' : 'https://nile.tronscan.org';
export const tronscan = (a: string) => h('a', { href: `${TRONSCAN}/#/address/${a}`, target: '_blank', rel: 'noopener noreferrer' }, 'Tronscan ↗');
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

const render: Record<string, (p: HTMLElement) => void> = {};
function show(tab: string) {
  const p = $(`[data-panel="${tab}"]`);
  if (!PROTO) return; // 正式模式由 admin-pay-real.ts 渲染
  render[tab.slice(2)](p);
  counts();
}
if (PROTO) root.querySelectorAll<HTMLElement>('[data-tab^="p-"]').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab!)));
function counts() {
  const set = (k: string, n: number, meaning: string) => { const b = root.querySelector<HTMLElement>(`[data-pcount="${k}"]`); if (b) { b.textContent = String(n); b.title = `${meaning}：${n}`; } };
  set('merchants', M.merchants.filter((m) => m.status === 'active').length, '已开通的商户');
  set('withdrawals', M.withdrawals.filter((w) => w.status === 'pending').length, '待审核的提币');
  set('anomalies', M.anomalies.filter((a) => !a.handled).length, '未处理的异常到账');
}
if (PROTO) counts();

// ============ 签名对话框（提币和归集共用） ============
interface SignItem { cells: (string | Node)[]; expected: { from: string; to: string; amount: number }; decoded: { from: string; to: string; amount: number; contract: string }; rule: (d: SignItem['decoded']) => string | null }
function signDialog(opts: { title: string; cols: string[]; items: SignItem[]; summary: [string, string][]; needMnemonic: boolean; okText: string; steps: string[]; onDone: () => void }) {
  const tamper = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const tableBox = h('div');
  const okBtn = $<HTMLButtonElement>('[data-pdialog-ok]');
  const check = (it: SignItem): string | null => {
    const d = it.decoded, e = it.expected;
    if (d.contract !== USDT_CONTRACT) return '合约不是 USDT';
    if (d.from !== e.from) return `付款地址不一致：交易里是 ${shortAddr(d.from)}`;
    if (d.to !== e.to) return `收款地址不一致：交易里是 ${shortAddr(d.to)}`;
    if (d.amount !== e.amount) return `金额不一致：交易里是 ${usd(d.amount)}`;
    return it.rule(d);
  };
  const paint = () => {
    // 演示：服务器把第 1 笔交易的收款地址换成了别人的地址
    opts.items.forEach((it, i) => (it.decoded = { ...it.decoded, to: tamper.checked && i === 0 ? 'TAttackerXk9fQ2m9sR7ZcY1hN4vB6pW3a' : it.expected.to }));
    const results = opts.items.map(check);
    tableBox.replaceChildren(table([...opts.cols, '浏览器核对'], opts.items.map((it, i) => [...it.cells, results[i] ? h('span', { class: 'bad' }, `✗ ${results[i]}`) : h('span', { class: 'ok' }, '✓ 一致')]), '—'));
    const bad = results.filter(Boolean).length;
    okBtn.disabled = bad > 0;
    blocked.hidden = bad === 0;
  };
  const blocked = h('p', { class: 'alert m0' }, '有交易没通过核对，页面已拦下，不能签名。请不要继续，并检查服务器是否被篡改。');
  const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6' }) as HTMLInputElement;
  const mn = h('textarea', { rows: '3', autocomplete: 'off', spellcheck: false, class: 'mono-input' }) as HTMLTextAreaElement;
  const hot = h('input', { type: 'password', autocomplete: 'off', spellcheck: false, class: 'mono-input' }) as HTMLInputElement;
  const body = h('div', { class: 'stack' },
    h('p', { class: 'hint muted m0' }, '浏览器已自行解码每一笔待签名的交易，并按规则逐项核对：付款地址、收款地址、金额、合约。下表显示的是解码出来的值。'),
    tableBox, blocked,
    h('dl', { class: 'kv kv-tight' }, ...opts.summary.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, h('b', {}, v))])),
    PROTO ? h('label', { class: 'check-row demo-row' }, tamper, '演示（仅原型）：假设服务器被攻破，把第 1 笔交易的收款地址换掉') : null,
    field('ps-code', '验证器动态码（6 位）', code),
    opts.needMnemonic ? field('ps-mn', '主助记词（只在本页面使用，签名后立即清除，不会发送给服务器）', mn) : null,
    field('ps-hot', '热钱包私钥（只在本页面使用，签名后立即清除，不会发送给服务器）', hot),
    PROTO ? h('p', { class: 'alert m0' }, '原型：随便输入几个字符即可。请不要在这里输入真实的私钥或助记词。') : null,
  );
  tamper.addEventListener('change', paint);
  dialog(opts.title, body, opts.okText, async () => {
    let bad = fieldErr(code, /^\d{6}$/.test(code.value.trim()) ? null : '请输入 6 位动态码');
    if (opts.needMnemonic) bad = fieldErr(mn, mn.value.trim() ? null : '请输入主助记词') || bad;
    bad = fieldErr(hot, hot.value.trim() ? null : '请输入热钱包私钥') || bad;
    if (bad) return false;
    // 签名后立即清除输入框里的密钥（原型不读取它们的内容）
    mn.value = ''; hot.value = '';
    okBtn.disabled = true;
    const list = h('ol', { class: 'progress-list' });
    body.replaceChildren(h('p', { class: 'm0' }, '签名完成，密钥已清除。服务器正在按顺序广播：'), list);
    for (const s of opts.steps) { list.append(h('li', {}, `⏳ ${s}`)); await new Promise((r) => setTimeout(r, 450)); (list.lastChild as HTMLElement).textContent = `✓ ${s}`; }
    await new Promise((r) => setTimeout(r, 400));
    okBtn.disabled = false;
    opts.onDone();
    return true;
  });
  paint();
}

// ============ 商户 ============
export const feeInputs = (rule: FeeRule, prefix: string, title: string) => {
  const pct = h('input', { inputmode: 'decimal', value: String(rule.ppm / 10000) }) as HTMLInputElement;
  const fixed = h('input', { inputmode: 'decimal', value: fmtUsdt(rule.fixed, 0) || '0' }) as HTMLInputElement;
  const min = h('input', { inputmode: 'decimal', value: fmtUsdt(rule.min, 0) || '0' }) as HTMLInputElement;
  const box = h('fieldset', { class: 'fee-set' }, h('legend', {}, title), h('div', { class: 'fgrid fgrid-3' }, field(`${prefix}-pct`, '百分比（%）', pct), field(`${prefix}-fixed`, '每笔固定（USDT）', fixed), field(`${prefix}-min`, '最低收费（USDT）', min)));
  const read = (): FeeRule | null => {
    const p = /^\d{1,2}(\.\d{1,4})?$/.test(pct.value.trim()) ? Math.round(Number(pct.value) * 10000) : null;
    const f = fixed.value.trim() === '0' ? 0 : parseUsdt(fixed.value), m = min.value.trim() === '0' ? 0 : parseUsdt(min.value);
    let bad = fieldErr(pct, p === null ? '请输入 0 到 99.9999 之间的数字' : null);
    bad = fieldErr(fixed, f === null ? '请输入金额' : null) || bad;
    bad = fieldErr(min, m === null ? '请输入金额' : null) || bad;
    return bad ? null : { ppm: p!, fixed: f!, min: m! };
  };
  return { box, read };
};
// 订单模式：匹配下限 L、上限 H、过期时间、回看时间，由管理员为每个商户填写
export const modeInputs = (mode: M.OrderMode, prefix: string) => {
  const on = h('input', { type: 'checkbox', checked: mode.enabled }) as HTMLInputElement;
  const low = h('input', { inputmode: 'decimal', value: String(mode.low / 10000) }) as HTMLInputElement;
  const high = h('input', { inputmode: 'decimal', value: String(mode.high / 10000) }) as HTMLInputElement;
  const ttl = h('input', { inputmode: 'numeric', value: String(mode.ttlMin) }) as HTMLInputElement;
  const back = h('input', { inputmode: 'numeric', value: String(mode.lookbackH) }) as HTMLInputElement;
  const grid = h('div', { class: 'fgrid fgrid-3' },
    field(`${prefix}-low`, '匹配下限（%）', low, '累计达到订单金额的这个比例，就算匹配成功（1 到 100）'),
    field(`${prefix}-high`, '匹配上限（%）', high, '累计超过这个比例，算超额付款（100 到 1000）'),
    field(`${prefix}-ttl`, '订单过期时间（分钟）', ttl, '5 到 1440'),
    field(`${prefix}-back`, '先到账后建单的回看时间（小时）', back, '0 到 72；0 表示不做这个方向的匹配'));
  on.addEventListener('change', () => (grid.hidden = !on.checked)); grid.hidden = !on.checked;
  const box = h('fieldset', { class: 'fee-set', 'data-order-mode': '' }, h('legend', {}, '订单模式'), h('label', { class: 'check-row' }, on, '开启订单模式（关闭时商户不能创建订单，到账只按客户记录）'), grid,
    h('p', { class: 'hint muted m0' }, '修改后只影响之后创建的订单；已经创建的订单按创建时的规则计算。'));
  const num = (i: HTMLInputElement) => (/^\d{1,4}(\.\d{1,4})?$/.test(i.value.trim()) ? Number(i.value) : NaN);
  const read = (): M.OrderMode | null => {
    const l = num(low), hh = num(high), tt = num(ttl), b = num(back);
    let bad = fieldErr(low, l >= 1 && l <= 100 ? null : '请输入 1 到 100');
    bad = fieldErr(high, hh >= 100 && hh <= 1000 ? null : '请输入 100 到 1000') || bad;
    bad = fieldErr(ttl, Number.isInteger(tt) && tt >= 5 && tt <= 1440 ? null : '请输入 5 到 1440 的整数') || bad;
    bad = fieldErr(back, Number.isInteger(b) && b >= 0 && b <= 72 ? null : '请输入 0 到 72 的整数') || bad;
    if (on.checked && bad) return null;
    return on.checked ? { enabled: true, low: Math.round(l * 10000), high: Math.round(hh * 10000), ttlMin: tt, lookbackH: b } : { ...mode, enabled: false };
  };
  return { box, read };
};
export const modeText = (m: M.OrderMode) => (m.enabled ? `${m.low / 10000}%–${m.high / 10000}% · ${m.ttlMin} 分钟 · 回看 ${m.lookbackH} 小时` : '未开启');
// 原型的概览：示例数据（和 mock 的量级一致）
render.overview = (p) => {
  const E = M.merchants.length === 0; // 空状态预览
  const z = (v: string) => (E ? '0.00' : v);
  const all: OverviewData = {
    funds: { collected_total: z('486215.40'), deposit_count: E ? 0 : 1287, owed_total: z('58402.18'), owed_available: z('57400.18'), owed_frozen: z('1002.00'),
      assets_total: z('63971.62'), unswept_total: z('12480.30'), hot_usdt: z('41491.32'), cold_usdt: z('10000.00'), cold_configured: true,
      profit_total: z('5569.44'), profit_now: z('0.00'), profit_after_sweep: z('5569.44'), income_fee_in: z('4862.15'), income_fee_out: z('706.00'), income_dust: z('1.29') },
    todo: { withdrawals_count: E ? 0 : M.withdrawals.filter((w) => w.status === 'pending').length, withdrawals_amount: z('3500.00'), kyb_pending: E ? 0 : 2, merchants_to_open: E ? 0 : 1, anomalies: E ? 0 : M.anomalies.filter((a) => !a.handled).length, callbacks_failed: E ? 0 : 1 },
    sweep: { unswept_total: z('12480.30'), address_count: E ? 0 : 38, over_threshold: E ? 0 : 21, over_threshold_total: z('11902.00'), threshold: '100.00', hot_trx: z('1520.40'), energy_left: E ? 0 : 1_300_000, energy_per_sweep: 65_000, month_sweep_trx: z('86.00') },
    periods: {
      today: { amount: z('8210.00'), count: E ? 0 : 23, fees_in: z('82.10'), active_merchants: E ? 0 : 3, new_customers: E ? 0 : 5, orders_done: E ? 0 : 14, orders_closed: E ? 0 : 15 },
      d7: { amount: z('61540.20'), count: E ? 0 : 171, fees_in: z('615.40'), active_merchants: E ? 0 : 4, new_customers: E ? 0 : 29, orders_done: E ? 0 : 102, orders_closed: E ? 0 : 110 },
      d30: { amount: z('240118.75'), count: E ? 0 : 652, fees_in: z('2401.19'), active_merchants: E ? 0 : 5, new_customers: E ? 0 : 118, orders_done: E ? 0 : 398, orders_closed: E ? 0 : 431 },
    },
    top_merchants: E ? [] : M.merchants.slice(0, 5).map((m, i) => ({ name: m.name, amount: ['98210.00', '61200.50', '40100.25', '26008.00', '14600.00'][i], count: [260, 170, 110, 72, 40][i] })),
    system: { tick_age_s: 38, recon: E ? null : { day: new Date().toISOString().slice(0, 10), diff: '0.00', complete: true }, db_bytes: E ? 2_000_000 : 41_000_000, disk: { used_mb: E ? 6_200 : 9_800, total_mb: 81_920 } },
  };
  // 原型里模拟两批数据先后回来
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  mountOverview(p, { db: async () => { await wait(300); return all; }, chain: async () => { await wait(900); return {}; } }, (tab) => root.querySelector<HTMLElement>(`[data-tab="${tab}"]`)?.click());
};
render.merchants = (p) => {
  const pending = M.approvedApps.filter((a) => !M.merchants.some((m) => m.name === a.company));
  const openBox = pending.length ? h('section', { class: 'card stack' }, h('h2', { class: 'h-sm m0' }, '开户已通过，待开通收付款'),
    table(['编号', '企业名称', '授权联系人邮箱', ''], pending.map((a) => [a.ref, a.company, a.email, h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => openMerchant(a) }, '开通商户')]), '—')) : null;
  p.replaceChildren(
    toolbar('商户'),
    openBox || h('span'),
    table(['商户', '状态', '收款费', '付款费', '订单模式（下限–上限 · 过期 · 回看）', '可用余额', '冻结', '客户数', 'API 提币'], M.merchants.map((m) => [
      m.name, status(m.status === 'active' ? 'approved' : 'expired', m.status === 'active' ? '已开通' : '已停用'), describeFee(m.feeIn), describeFee(m.feeOut), modeText(m.mode),
      usd(m.available), usd(m.frozen), String(M.customers.filter((x) => x.merchantId === m.id).length), m.ipWhitelist.length ? '已设白名单' : h('span', { class: 'muted' }, '未开放（没有白名单）')]), '暂无商户', { onRow: (i) => editMerchant(M.merchants[i]) }),
  );
};
function openMerchant(a: (typeof M.approvedApps)[number]) {
  const fin = feeInputs({ ppm: 10000, fixed: 0, min: 0 }, 'om-in', '收款手续费');
  const fout = feeInputs({ ppm: 0, fixed: 2 * U, min: 0 }, 'om-out', '付款手续费');
  const mode = modeInputs(M.defaultMode(), 'om-mode');
  dialog(`开通商户：${a.company}`, h('div', { class: 'stack' }, fin.box, fout.box, mode.box, h('p', { class: 'hint muted m0' }, `开通后，系统给授权联系人 ${a.email} 发送设置密码的邮件。`)), '开通并发送邮件', () => {
    const i = fin.read(), o = fout.read(), md = mode.read(); if (!i || !o || !md) return false;
    M.merchants.push({ id: 'm' + (M.merchants.length + 1), name: a.company, status: 'active', feeIn: i, feeOut: o, mode: md, available: 0, frozen: 0, customers: 0, ipWhitelist: [], cashoutWallets: [], since: new Date().toISOString() });
    say(`已开通 ${a.company}，并发送设置密码的邮件（原型：未实际发送）`); show('p-merchants');
  });
}
function editMerchant(m: M.Merchant) {
  const fin = feeInputs(m.feeIn, 'em-in', '收款手续费'), fout = feeInputs(m.feeOut, 'em-out', '付款手续费');
  const mode = modeInputs(m.mode, 'em-mode');
  const active = h('input', { type: 'checkbox', checked: m.status === 'active' }) as HTMLInputElement;
  const preview = h('p', { class: 'hint muted m0' }, `示例：收 1,000 USDT，收款费 ${usd(calcFee(1000 * U, m.feeIn))}；付 1,000 USDT，付款费 ${usd(calcFee(1000 * U, m.feeOut))}。`);
  const wallets = m.cashoutWallets.length ? h('ul', { class: 'plain-list' }, ...m.cashoutWallets.map((w) => h('li', {}, mono(w)))) : h('p', { class: 'm0 muted' }, '暂无（来自开户表的钱包授权 的钱包，审核通过后登记）');
  dialog(m.name, h('div', { class: 'stack' }, h('label', { class: 'check-row' }, active, '启用（停用后商户不能登录，API 返回 403，已分配的地址照常监控入账）'),
    fin.box, fout.box, preview, mode.box, h('div', { class: 'f' }, h('span', { class: 'lbl' }, '已登记的提现钱包'), wallets)), '保存', () => {
    const i = fin.read(), o = fout.read(), md = mode.read(); if (!i || !o || !md) return false;
    m.feeIn = i; m.feeOut = o; m.mode = md; m.status = active.checked ? 'active' : 'disabled';
    say('已保存。新的费率和订单模式从下一笔开始生效，已有记录不变。'); show('p-merchants');
  });
}

// ============ 客户（跨商户搜索） ============
let custMerchant = 'all', custQ = '';
render.customers = (p) => {
  const sel = h('select', { class: 'input-sm' }, h('option', { value: 'all' }, '全部商户'), ...M.merchants.map((m) => h('option', { value: m.id, selected: m.id === custMerchant }, m.name))) as HTMLSelectElement;
  sel.addEventListener('change', () => { custMerchant = sel.value; render.customers(p); });
  const q = h('input', { type: 'search', class: 'input-sm input-wide', placeholder: '客户标识、名称、邮箱或地址', value: custQ }) as HTMLInputElement;
  q.addEventListener('change', () => { custQ = q.value.trim(); render.customers(p); });
  const qs = custQ.toLowerCase();
  const list = M.customers.filter((x) => (custMerchant === 'all' || x.merchantId === custMerchant) && (!qs || [x.id, x.name, x.email, x.address].some((v) => v.toLowerCase().includes(qs))));
  const mName = (id: string) => M.merchants.find((m) => m.id === id)?.name || id;
  p.replaceChildren(
    toolbar('客户', sel, q),
    h('p', { class: 'hint muted' }, '商户的客户由商户自己定义标识，每个客户一个永久地址。这里可以跨商户查找任意客户。'),
    table(['商户', '客户标识', '名称', '地址', '累计收款', '笔数', '手续费', '未匹配', '最近付款'], list.map((x) => {
      const st = M.customerStats(x.merchantId, x.id);
      return [mName(x.merchantId), mono(x.id), x.name || '—', mono(shortAddr(x.address), x.address), usd(st.total), String(st.count), usd(st.fees), st.unmatched ? h('b', {}, usd(st.unmatched)) : '0.00', st.last ? t(st.last) : '—'];
    }), '没有找到客户', { onRow: (i) => adminCustomer(list[i]) }),
  );
};
function adminCustomer(x: M.Customer) {
  const st = M.customerStats(x.merchantId, x.id);
  const ds = M.deposits.filter((d) => d.merchantId === x.merchantId && d.customer === x.id);
  const os = M.orders.filter((o) => o.merchantId === x.merchantId && o.customer === x.id);
  const OS: Record<string, string> = { pending: '等待付款', partial: '部分付款', completed: '已完成', overpaid: '超额付款', expired: '已过期', expired_partial: '部分付款（已过期）' };
  dialog(`${x.name || x.id}`, h('div', { class: 'stack' },
    h('dl', { class: 'kv' }, h('dt', {}, '商户'), h('dd', {}, M.merchants.find((m) => m.id === x.merchantId)?.name || ''), h('dt', {}, '客户标识'), h('dd', {}, mono(x.id)),
      h('dt', {}, '邮箱'), h('dd', {}, x.email || '—'), h('dt', {}, '地址'), h('dd', {}, h('span', { class: 'copy-row' }, mono(x.address), tronscan(x.address))), h('dt', {}, '创建时间'), h('dd', {}, t(x.createdAt))),
    h('div', { class: 'stats' }, stat('累计收款', usd(st.total), 'USDT'), stat('笔数', String(st.count)), stat('手续费', usd(st.fees), 'USDT'), stat('未匹配', usd(st.unmatched), 'USDT')),
    h('h3', { class: 'h-sm m0' }, '订单'),
    table(['订单号', '金额', '已匹配', '状态'], os.map((o) => [mono(o.id), usd(o.amount), usd(o.matched), OS[o.status]]), '暂无'),
    h('h3', { class: 'h-sm m0' }, '到账'),
    table(['时间', '金额', '订单'], ds.map((d) => [t(d.time), usd(d.amount), d.orderId ? mono(d.orderId) : d.credited ? '未匹配' : '—']), '暂无'),
  ), '关闭', null);
}

// ============ 归集 ============
const sweepSel = new Set<string>(['s1', 's2', 's3', 's4']);
let sweepMin = '100', sweepMerchant = 'all', sweepTo: 'hot' | 'cold' = 'hot';
function sweepPlan() {
  let energy = M.wallet.hot.energy;
  return M.sweepRows.map((r) => {
    const sel = sweepSel.has(r.id);
    const useEnergy = energy >= M.ENERGY_PER_SWEEP; // 没选中的行：按剩余能量预估
    if (sel && useEnergy) energy -= M.ENERGY_PER_SWEEP;
    const trx = (useEnergy ? 0.35 : M.BURN_TRX_PER_SWEEP) + (r.activated ? 0 : M.ACTIVATE_TRX);
    return { r, sel, useEnergy, trx };
  });
}
render.sweep = (p) => {
  const plan = sweepPlan();
  const min = parseUsdt(sweepMin) ?? 0;
  const rows = plan.filter((x) => x.r.balance >= min && (sweepMerchant === 'all' || x.r.merchant === sweepMerchant));
  const total = M.sweepRows.reduce((s, r) => s + r.balance, 0);
  const chosen = plan.filter((x) => x.sel);
  const minInput = h('input', { inputmode: 'decimal', value: sweepMin, class: 'input-sm' }) as HTMLInputElement;
  minInput.addEventListener('change', () => { sweepMin = minInput.value; render.sweep(p); });
  const merchSel = h('select', { class: 'input-sm' }, h('option', { value: 'all' }, '全部商户'), ...[...new Set(M.sweepRows.map((r) => r.merchant))].map((m) => h('option', { value: m, selected: m === sweepMerchant }, m))) as HTMLSelectElement;
  merchSel.addEventListener('change', () => { sweepMerchant = merchSel.value; render.sweep(p); });
  const toSel = h('select', { class: 'input-sm', 'data-sweep-to': '' }, h('option', { value: 'hot', selected: sweepTo === 'hot' }, '热钱包'), h('option', { value: 'cold', selected: sweepTo === 'cold' }, '冷钱包')) as HTMLSelectElement;
  toSel.addEventListener('change', () => { sweepTo = toSel.value as 'hot' | 'cold'; });
  const allBtn = h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => { const all = rows.every((x) => x.sel); rows.forEach((x) => (all ? sweepSel.delete(x.r.id) : sweepSel.add(x.r.id))); render.sweep(p); } }, rows.length && rows.every((x) => x.sel) ? '取消全选' : '全选当前列表');
  const energyLeft = Math.floor(M.wallet.hot.energy / M.ENERGY_PER_SWEEP);
  const signBtn = h('button', { type: 'button', class: 'btn btn-primary', disabled: !chosen.length, onclick: () => signSweep(chosen, p) }, '签名并归集');
  p.replaceChildren(
    toolbar('归集', h('label', { class: 'inline-label' }, '金额 ≥', minInput), merchSel, allBtn),
    h('div', { class: 'stats' }, stat('未归集总额', usd(total), `USDT · ${M.sweepRows.length} 个地址`), stat('热钱包', usd(M.wallet.hot.usdt), `USDT · TRX ${usd(M.wallet.hot.trx)}`),
      stat('热钱包可借出能量', M.wallet.hot.energy.toLocaleString('en'), `大约够 ${energyLeft} 笔归集，24 小时内恢复`)),
    table(['', '商户', '客户', '地址', 'USDT 余额', '最后到账', '预估手续费（示意）', ''], rows.map((x) => {
      const cb = h('input', { type: 'checkbox', class: 'check', checked: x.sel, 'aria-label': `选择 ${x.r.address}` }) as HTMLInputElement;
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => { cb.checked ? sweepSel.add(x.r.id) : sweepSel.delete(x.r.id); render.sweep(p); });
      const feeCell = h('span', { class: 'status-cell' }, `≈ ${x.trx.toFixed(1)} TRX`, h('span', { class: `pill ${x.useEnergy ? 'energy' : 'burn'}` }, x.useEnergy ? '用能量' : '燃烧 TRX'), x.r.activated ? null : h('span', { class: 'pill' }, '首次，含激活'));
      return [cb, x.r.merchant, mono(x.r.customer), mono(shortAddr(x.r.address), x.r.address), h('b', {}, usd(x.r.balance)), t(x.r.lastDeposit), feeCell,
        x.r.balance < 3 * U ? h('span', { class: 'warn-text' }, '⚠️ 手续费高于余额') : ''];
    }), '暂无需要归集的地址', { onRow: (i) => { const id = rows[i].r.id; sweepSel.has(id) ? sweepSel.delete(id) : sweepSel.add(id); render.sweep(p); } }),
    h('p', { class: 'hint muted' }, '手续费按链上实时价格估算。能量不够的地址改为燃烧 TRX；从没归集过的地址要先激活（约 1.1 TRX，只需一次）。'),
    h('div', { class: 'sumbar' },
      h('span', {}, '已选 ', h('b', {}, String(chosen.length)), ' 个地址 · 合计 ', h('b', {}, `${usd(chosen.reduce((s, x) => s + x.r.balance, 0))} USDT`),
        ` · 借出能量 ${chosen.filter((x) => x.useEnergy).length} 笔、燃烧 TRX ${chosen.filter((x) => !x.useEnergy).length} 笔 · 预估手续费约 ${chosen.reduce((s, x) => s + x.trx, 0).toFixed(1)} TRX`),
      h('span', { class: 'sumbar-actions' }, '归集到：', toSel, signBtn)),
  );
};
function signSweep(chosen: ReturnType<typeof sweepPlan>, p: HTMLElement) {
  const dest = sweepTo === 'hot' ? M.wallet.hot.address : M.wallet.cold.address;
  const allowed = [M.wallet.hot.address, M.wallet.cold.address];
  const sum = chosen.reduce((s, x) => s + x.r.balance, 0);
  const items: SignItem[] = chosen.map((x, i) => ({
    cells: [`${x.r.merchant} · ${x.r.customer}`, `#${1041 + i} ${shortAddr(x.r.address)}`, `→ ${sweepTo === 'hot' ? '热钱包' : '冷钱包'}`, usd(x.r.balance)],
    expected: { from: x.r.address, to: dest, amount: x.r.balance },
    decoded: { from: x.r.address, to: dest, amount: x.r.balance, contract: USDT_CONTRACT },
    rule: (d) => (allowed.includes(d.to) ? null : '收款地址不是热钱包或冷钱包（写在代码里的地址）'),
  }));
  const steps = [
    ...(chosen.some((x) => !x.r.activated) ? [`激活 ${chosen.filter((x) => !x.r.activated).length} 个新地址`] : []),
    `借出能量给 ${chosen.filter((x) => x.useEnergy).length} 个地址` + (chosen.some((x) => !x.useEnergy) ? `，给 ${chosen.filter((x) => !x.useEnergy).length} 个地址转 TRX 手续费` : ''),
    `转出 ${chosen.length} 笔 USDT，合计 ${usd(sum)}`, '收回借出的能量',
  ];
  signDialog({
    title: `签名并归集（${chosen.length} 笔）`, cols: ['商户', '付款地址（序号）', '收款', '金额'], items, needMnemonic: true, okText: '签名并广播', steps,
    summary: [['合计归集', `${usd(sum)} USDT → ${sweepTo === 'hot' ? '热钱包' : '冷钱包'}`], ['预估手续费', `约 ${chosen.reduce((s, x) => s + x.trx, 0).toFixed(1)} TRX`]],
    onDone: () => {
      const ids = new Set(chosen.map((x) => x.r.id));
      for (let i = M.sweepRows.length - 1; i >= 0; i--) if (ids.has(M.sweepRows[i].id)) M.sweepRows.splice(i, 1);
      if (sweepTo === 'hot') M.wallet.hot.usdt += sum; else M.wallet.cold.usdt += sum;
      M.wallet.hot.energy -= chosen.filter((x) => x.useEnergy).length * M.ENERGY_PER_SWEEP;
      sweepSel.clear(); say(`已归集 ${usd(sum)} USDT`); render.sweep(p);
    },
  });
}

// ============ 提币审核 ============
const wdSel = new Set<string>(['WD-0031', 'WD-0030', 'WD-0029']);
let wdFilter: 'pending' | 'all' = 'pending';
const WD_CLS: Record<M.WdStatus, [string, string]> = { pending: ['submitted', '待审核'], rejected: ['rejected', '已驳回'], cancelled: ['expired', '已取消'], signing: ['invited', '已批准'], broadcast: ['in_progress', '已广播'], completed: ['approved', '已完成'], failed: ['needs_info', '失败'] };
render.withdrawals = (p) => {
  const list = M.withdrawals.filter((w) => wdFilter === 'all' || w.status === 'pending');
  const chosen = M.withdrawals.filter((w) => w.status === 'pending' && wdSel.has(w.id));
  const need = chosen.reduce((s, w) => s + w.amount, 0);
  const short = need > M.wallet.hot.usdt;
  const filters = h('div', { class: 'filters' },
    h('button', { type: 'button', 'aria-pressed': String(wdFilter === 'pending'), onclick: () => { wdFilter = 'pending'; render.withdrawals(p); } }, `待审核 ${M.withdrawals.filter((w) => w.status === 'pending').length}`),
    h('button', { type: 'button', 'aria-pressed': String(wdFilter === 'all'), onclick: () => { wdFilter = 'all'; render.withdrawals(p); } }, `全部 ${M.withdrawals.length}`));
  p.replaceChildren(
    toolbar('提币审核', h('span', { class: 'muted' }, `热钱包 ${usd(M.wallet.hot.usdt)} USDT`)),
    h('p', { class: 'hint muted' }, '每一笔提币都要人工审核（后台和 API 发起的都一样）。有新的提币申请时，系统给你发邮件，1 分钟内的多笔合并成一封。商户看到的处理时效：东八区 8:00–23:00 内 1 小时处理。'),
    filters,
    table(['', '编号', '提交时间', '已等待', '商户', '类型', '客户', '收款地址', '金额', '手续费', '来源', '状态'], list.map((w) => {
      const pend = w.status === 'pending';
      const cb = h('input', { type: 'checkbox', class: 'check', checked: pend && wdSel.has(w.id), disabled: !pend, 'aria-label': `选择 ${w.id}` }) as HTMLInputElement;
      cb.addEventListener('change', () => { cb.checked ? wdSel.add(w.id) : wdSel.delete(w.id); render.withdrawals(p); });
      const st = h('span', { class: 'status-cell' }, status(...WD_CLS[w.status]));
      if (w.txid) st.append(mono(w.txid.slice(0, 8) + '…', w.txid));
      return [cb, mono(w.id), t(w.time), pend ? minsAgo(w.time) : '—', w.merchant, w.kind === 'payout' ? '代付' : '商户提现', w.customer ? mono(w.customer) : '—', mono(shortAddr(w.to), w.to), h('b', {}, usd(w.amount)), usd(w.fee), w.source === 'api' ? 'API' : '后台', st];
    }), wdFilter === 'pending' ? '暂无待审核的提币' : '暂无提币'),
    short ? h('p', { class: 'alert' }, `热钱包余额不足：已选 ${usd(need)} USDT，热钱包只有 ${usd(M.wallet.hot.usdt)} USDT。请先归集，或少选几笔。`) : h('span'),
    h('div', { class: 'sumbar' }, h('span', {}, '已选 ', h('b', {}, String(chosen.length)), ' 笔 · 合计打出 ', h('b', {}, `${usd(need)} USDT`), ' · 使用热钱包能量'),
      h('span', { class: 'sumbar-actions' },
        h('button', { type: 'button', class: 'btn btn-outline btn-on-dark', disabled: !chosen.length, onclick: () => rejectWd(chosen, p) }, '驳回'),
        h('button', { type: 'button', class: 'btn btn-primary', disabled: !chosen.length || short, onclick: () => signWd(chosen, p) }, `批准并签名（${chosen.length} 笔）`))),
  );
};
function signWd(chosen: M.Withdrawal[], p: HTMLElement) {
  const hot = M.wallet.hot.address;
  const items: SignItem[] = chosen.map((w) => {
    const m = M.merchants.find((x) => x.id === w.merchantId);
    return {
      cells: [w.merchant, w.kind === 'payout' ? '代付' : '商户提现', mono(shortAddr(w.to), w.to), usd(w.amount)],
      expected: { from: hot, to: w.to, amount: w.amount }, decoded: { from: hot, to: w.to, amount: w.amount, contract: USDT_CONTRACT },
      rule: (d) => (w.kind === 'cashout' && !m?.cashoutWallets.includes(d.to) ? '商户提现的地址不是这个商户登记的钱包' : null),
    };
  });
  const sum = chosen.reduce((s, w) => s + w.amount, 0);
  signDialog({
    title: `签名并打款（${chosen.length} 笔）`, cols: ['商户', '类型', '收款地址', '金额'], items, needMnemonic: false, okText: '签名并广播',
    summary: [['合计打出', `${usd(sum)} USDT`], ['手续费', '使用热钱包能量（不燃烧 TRX）']],
    steps: [`广播 ${chosen.length} 笔交易`, '等待链上确认', '写账本、发回调给商户'],
    onDone: () => {
      for (const w of chosen) {
        w.status = 'completed'; w.txid = M.fakeTx();
        const m = M.merchants.find((x) => x.id === w.merchantId); if (m) m.frozen -= w.amount + w.fee;
      }
      M.wallet.hot.usdt -= sum; wdSel.clear();
      say(`${chosen.length} 笔提币已完成`); render.withdrawals(p); counts();
    },
  });
}
function rejectWd(chosen: M.Withdrawal[], p: HTMLElement) {
  const reason = h('textarea', { rows: '3' }) as HTMLTextAreaElement;
  dialog(`驳回 ${chosen.length} 笔提币`, h('div', { class: 'stack' }, field('pr-reason', '驳回原因（商户能看到）', reason), h('p', { class: 'hint muted m0' }, '驳回后，冻结的金额退回商户的可用余额，并发回调通知商户。')), '驳回', () => {
    if (fieldErr(reason, reason.value.trim() ? null : '请填写驳回原因')) return false;
    for (const w of chosen) {
      w.status = 'rejected'; w.reason = reason.value.trim();
      const m = M.merchants.find((x) => x.id === w.merchantId); if (m) { m.frozen -= w.amount + w.fee; m.available += w.amount + w.fee; }
    }
    wdSel.clear(); say('已驳回，冻结金额已退回'); render.withdrawals(p); counts();
  }, true);
}

// ============ 异常到账 ============
const ANOM: Record<M.Anomaly['type'], [string, string]> = {
  token: ['不支持的币', '不入账。需要时由你手动处理（例如联系商户后原路退回）'],
  below_min: ['低于 1 USDT', '不入账、不通知，只记录（防止垃圾转账）'],
};
render.anomalies = (p) => {
  p.replaceChildren(
    toolbar('异常到账'),
    h('p', { class: 'hint muted' }, '不支持的币每天检查一次，最多晚 24 小时出现在这里。过期后才到的 USDT 不算异常：已入账，记为客户未匹配的到账。'),
    table(['时间', '类型', '商户', '客户', '地址', '金额', '系统的处理', ''], M.anomalies.map((a) => [
      t(a.time), status(a.type === 'token' ? 'needs_info' : 'submitted', ANOM[a.type][0]), a.merchant, mono(a.customer), mono(shortAddr(a.address), a.address), a.amount, h('span', { class: 'hint' }, ANOM[a.type][1]),
      a.handled ? h('span', { class: 'muted' }, '已处理') : h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => { a.handled = true; say('已标记为已处理'); render.anomalies(p); counts(); } }, '标记已处理')]), '暂无异常到账'),
  );
};

// ============ 对账 ============
render.recon = (p) => {
  p.replaceChildren(
    toolbar('对账', h('button', { type: 'button', class: 'btn btn-outline', onclick: () => say('原型：正式版会立即重新核对一次') }, '立即核对')),
    h('p', { class: 'hint muted' }, '每天核对一次：所有商户余额之和，是否等于"收款地址里还没归集的 USDT + 热钱包 + 冷钱包 − 已知的手续费支出"。不一致时发邮件通知你。'),
    table(['日期', '商户余额合计', '链上合计', '已知手续费支出', '差额', '结果'], M.recon.map((r) => [
      r.date, usd(r.balances), usd(r.chain), usd(r.fees), r.diff ? h('b', { class: 'neg' }, usd(r.diff)) : '0.00',
      r.diff ? h('span', { class: 'status-cell' }, status('needs_info', '不一致'), h('span', { class: 'hint muted' }, '已发邮件')) : status('approved', '一致')]), '暂无对账记录（第一次对账在明天）'),
    h('h2', { class: 'h-sm' }, '按商户核对客户合计'),
    h('p', { class: 'hint muted' }, '每个商户下，所有客户的收款合计必须等于这个商户的收款合计。'),
    table(['商户', '商户收款合计', '客户收款合计', '客户数', '结果'], M.merchants.filter((m) => M.deposits.some((d) => d.merchantId === m.id)).map((m) => {
      const ds = M.deposits.filter((d) => d.merchantId === m.id && d.credited);
      const total = ds.reduce((s, d) => s + d.amount, 0);
      const byCust = M.customers.filter((x) => x.merchantId === m.id).reduce((s, x) => s + M.customerStats(m.id, x.id).total, 0);
      return [m.name, usd(total), usd(byCust), String(M.customers.filter((x) => x.merchantId === m.id).length), status(total === byCust ? 'approved' : 'needs_info', total === byCust ? '一致' : '不一致')];
    }), '暂无'),
  );
};

// ============ 钱包设置 ============
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'.split(' ');
render.wallet = (p) => {
  const w = M.wallet;
  const hot = w.hot;
  const initCard = w.initialized
    ? h('section', { class: 'card stack' }, h('h2', { class: 'h-sm m0' }, '主助记词（收款地址）'),
      h('dl', { class: 'kv' }, h('dt', {}, '状态'), h('dd', {}, status('approved', '已初始化')), h('dt', {}, '推导路径'), h('dd', {}, mono("m/44'/195'/0'/0/序号")),
        h('dt', {}, '公钥指纹'), h('dd', {}, mono('3f9a1c07')), h('dt', {}, '第 1 个地址（用来核对）'), h('dd', {}, mono(w.firstAddress)), h('dt', {}, '已分配地址'), h('dd', {}, '325 个')),
      h('p', { class: 'hint muted m0' }, '系统只保存公钥，无法动用任何收款地址里的钱。助记词请离线抄写两份，分开保存。'),
      PROTO ? h('div', {}, h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: initFlow }, '演示初始化流程（仅原型）')) : null)
    : h('section', { class: 'card stack' }, h('h2', { class: 'h-sm m0' }, '主助记词（收款地址）'), h('p', { class: 'm0' }, '还没有初始化。初始化后才能给商户分配收款地址。'), h('div', {}, h('button', { type: 'button', class: 'btn btn-primary', onclick: initFlow }, '初始化主助记词')));
  const days = Math.floor(hot.energyMax / M.ENERGY_PER_SWEEP);
  p.replaceChildren(
    toolbar('钱包设置'),
    initCard,
    h('section', { class: 'card stack' }, h('h2', { class: 'h-sm m0' }, '热钱包'),
      h('dl', { class: 'kv' }, h('dt', {}, '地址'), h('dd', {}, h('span', { class: 'copy-row' }, mono(hot.address), copyBtn(() => hot.address, '复制', '已复制', 'link-copy'), tronscan(hot.address))),
        h('dt', {}, 'USDT'), h('dd', {}, usd(hot.usdt)), h('dt', {}, 'TRX'), h('dd', {}, usd(hot.trx)), h('dt', {}, '质押的 TRX'), h('dd', {}, usd(hot.stakedTrx)),
        h('dt', {}, '能量'), h('dd', {}, h('meter', { min: '0', max: String(hot.energyMax), value: String(hot.energy) }), ` ${hot.energy.toLocaleString('en')} / ${hot.energyMax.toLocaleString('en')}`),
        h('dt', {}, '每天大约可以'), h('dd', {}, `用能量归集 ${days} 笔（能量用完后 24 小时内恢复）`)),
      h('p', { class: 'hint muted m0' }, '质押 TRX、增加能量：在 TronLink 或 Tronscan 里操作，不需要在这里设置。热钱包里只放够几天提币的钱。')),
    h('section', { class: 'card stack' }, h('h2', { class: 'h-sm m0' }, '冷钱包'),
      h('dl', { class: 'kv' }, h('dt', {}, '地址'), h('dd', {}, h('span', { class: 'copy-row' }, mono(w.cold.address), tronscan(w.cold.address))), h('dt', {}, 'USDT'), h('dd', {}, usd(w.cold.usdt)))),
    h('p', { class: 'note-box' }, '热钱包和冷钱包的地址写在代码仓库的配置文件里，签名页面只允许把钱归集到这两个地址。修改地址要提交 PR，服务器改不了。'),
  );
};
function initFlow() {
  const pick = [3, 11, 20];
  const words = h('ol', { class: 'mnemonic' }, ...TEST_MNEMONIC.map((w) => h('li', {}, w)));
  const step1 = h('div', { class: 'stack' },
    h('p', { class: 'alert m0' }, '原型：下面是公开的测试助记词，任何人都知道，绝对不能用来存钱。正式版由浏览器随机生成，只显示这一次。'),
    h('p', { class: 'm0' }, '请用纸笔（或金属板）按顺序抄写下面 24 个单词，抄两份，分开保存。不要拍照，不要存进任何云端（包括 iCloud 密码）。'),
    words);
  dialog('初始化主助记词 · 第 1 步：抄写', step1, '我已抄写好', () => {
    const inputs = pick.map((n) => h('input', { autocomplete: 'off', spellcheck: false }) as HTMLInputElement);
    const step2 = h('div', { class: 'stack' }, h('p', { class: 'm0' }, '为了确认抄对了，请填写下面几个位置的单词：'), ...inputs.map((inp, i) => field(`pm-${i}`, `第 ${pick[i]} 个单词`, inp)));
    setTimeout(() => dialog('初始化主助记词 · 第 2 步：确认', step2, '确认', () => {
      let bad = false;
      inputs.forEach((inp, i) => { bad = fieldErr(inp, inp.value.trim().toLowerCase() === TEST_MNEMONIC[pick[i] - 1] ? null : '不对，请对照抄写的内容') || bad; });
      if (bad) return false;
      M.wallet.initialized = true;
      setTimeout(() => dialog('初始化完成', h('div', { class: 'stack' }, h('p', { class: 'm0' }, '浏览器只把公钥交给了服务器，助记词已从页面清除。'),
        h('dl', { class: 'kv' }, h('dt', {}, '第 1 个地址'), h('dd', {}, mono(M.wallet.firstAddress))),
        h('p', { class: 'hint muted m0' }, '建议用 TronLink 导入同一个助记词，确认第 1 个地址一致。')), '完成', () => show('p-wallet')), 0);
    }), 0);
  });
}

// ============ 系统状态 ============
// 第 1 批新加的"钱包提供方"：原型在第 1 批原型文件里，这个站内原型只放说明
render.routes = (p) => {
  p.replaceChildren(toolbar('钱包提供方'), h('p', { class: 'note-box' }, '原型模式没有这一页的模拟数据：以太坊、BSC 都用合约钱包，按链整体切换（动态码、原因必填、审计）。正式页面在测试环境查看。'));
};
render.status = (p) => {
  p.replaceChildren(
    toolbar('系统状态'),
    h('div', { class: 'stats' }, stat('链上监控最后一次运行', '12 秒前', '每 15 秒一次（worker）'), stat('最近 60 分钟', '60 / 60 次', '没有漏跑'), stat('处理到的区块', '75,301,228', '链上最新已确认：75,301,231')),
    h('section', { class: 'card stack' }, h('h2', { class: 'h-sm m0' }, '回调队列'), h('dl', { class: 'kv' }, h('dt', {}, '等待发送'), h('dd', {}, '0'), h('dt', {}, '重试中'), h('dd', {}, '1'), h('dt', {}, '24 小时内放弃'), h('dd', {}, '1'))),
    h('section', { class: 'card stack' }, h('h2', { class: 'h-sm m0' }, '用量'),
      h('div', { class: 'quota' }, ...M.quota.map((q) => {
        const pct = q.used / q.limit;
        return h('div', { class: 'quota-row' }, h('span', {}, q.name), h('meter', { min: '0', max: '1', low: '0.5', high: '0.7', optimum: '0', value: String(pct) }),
          h('span', { class: pct >= 0.7 ? 'neg' : '' }, `${q.used.toLocaleString('en')} / ${q.limit.toLocaleString('en')} ${q.unit}（${Math.round(pct * 100)}%）`));
      })),
      h('p', { class: 'hint muted m0' }, '超过 5 分钟没有运行，或者任何一项用量达到 70% 时，系统发邮件提醒你。')),
  );
};
