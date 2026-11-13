// 付款页面的交互：显示金额、地址和二维码，倒计时，实时显示状态。
// - 原型模式：订单来自模拟数据；页面下方的"原型操作"按钮模拟付款、部分付款和过期。
// - 正式模式：每 5 秒查询一次 /api/pay/（页面在后台时暂停），订单结束后停止查询。
import copy from '../i18n/merchant.json';
import { fmtUsdt, parseUsdt } from '../lib/money';
import { orders, me, customerOf, type OrderState } from './mock';
import { qrDataUrl, tpl } from './ui';

const root = document.getElementById('pay-root')!;
const lang = (root.dataset.lang || 'en') as 'en' | 'zh';
const PROTO = root.dataset.prototype === '1';
const c = copy[lang].pay;
const cn = copy[lang].chain;
type Net = { chain: string; network: string; address: string };
const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!;

interface PayState { nets?: Net[]; fixed?: boolean; id: string; merchant: string; amount: number; received: number; address: string; expiresAt: number; status: OrderState; confirmations: number; low: number; high: number }

// 订单号：/pay/<订单号>/，也兼容 ?o=<订单号>
const params = new URLSearchParams(location.search);
const id = decodeURIComponent((location.pathname.match(/\/pay\/([^/]+)\/?$/) || [])[1] || params.get('o') || '');

// 语言切换：保留订单号和参数
document.querySelectorAll<HTMLAnchorElement>('a[data-keep-query]').forEach((a) => {
  const target = (lang === 'en' ? '/zh/pay/' : '/pay/') + (id ? `${encodeURIComponent(id)}/` : '');
  a.href = target + location.search;
});

function protoOrder(): PayState | null {
  const found = orders.find((o) => o.id === id) || (!id ? orders.find((o) => o.status === 'pending') : undefined);
  if (!found) {
    // 原型：商户后台刚创建的订单不在模拟数据里，由链接参数带过来（正式版从 /api/pay/ 查询）
    const amount = parseUsdt(params.get('a') || ''), address = params.get('addr') || '';
    if (!amount || !address) return null;
    return { id, merchant: me.name, amount, received: Number(params.get('got')) || 0, address, expiresAt: Number(params.get('exp')) || Date.now() + 30 * 60_000, status: 'pending', confirmations: 0, low: me.mode.low, high: me.mode.high };
  }
  return {
    id: found.id, merchant: me.name, amount: found.amount, received: found.matched, address: customerOf(found.merchantId, found.customer)?.address || '',
    expiresAt: Date.parse(found.expiresAt), status: found.status, confirmations: 0, low: found.low, high: found.high,
  };
}
const open = (s: PayState) => s.status === 'pending' || s.status === 'partial';
let st: PayState | null = PROTO ? protoOrder() : null;
const initial = st ? { ...st } : null;

// 多链：付款人选的网络（按订单记在本页的会话里，刷新不丢；付款前可以改选）
const pickKey = `topup-pay-net:${id}`;
let picked: string | null = (() => { try { return sessionStorage.getItem(pickKey); } catch { return null; } })();
const setPick = (v: string | null) => { picked = v; try { if (v) sessionStorage.setItem(pickKey, v); else sessionStorage.removeItem(pickKey); } catch { /* 存不了也能用 */ } paint(); };
const netName = (ch: string) => (cn.names as Record<string, string>)[ch] || ch;
const netStd = (ch: string) => (cn.std as Record<string, string>)[ch] || '';
/** 当前用的网络：只有一个可选（或商户指定了链）时直接用它；多个时要付款人先选 */
function currentNet(s: PayState): Net | null {
  const nets = s.nets || [];
  if (!nets.length) return null;
  if (nets.length === 1) return nets[0];
  return nets.find((n) => n.chain === picked) || null;
}
function paintChoose(s: PayState) {
  const box = $('[data-pay-chains]');
  const nets = s.nets || [];
  const rows = ['eth', 'bsc', 'tron'].map((ch) => {
    const n = nets.find((x) => x.chain === ch);
    const b = document.createElement('button');
    b.type = 'button'; b.className = `chain-choice${n ? '' : ' disabled'}`; b.disabled = !n; b.dataset.net = ch;
    const dot = document.createElement('span'); dot.className = `chain-tag c-${ch}`; dot.textContent = netName(ch);
    const txt = document.createElement('span'); txt.className = 'stack-sm';
    const std = document.createElement('span'); std.className = 'muted'; std.textContent = netStd(ch);
    const hint = document.createElement('span'); hint.className = 'hint muted'; hint.textContent = (c.netHint as Record<string, string>)[ch] || '';
    txt.append(std, hint);
    b.append(dot, txt);
    if (!n) { const later = document.createElement('span'); later.className = 'later-tag'; later.textContent = cn.later; b.append(later); }
    else b.addEventListener('click', () => setPick(ch));
    return b;
  });
  box.replaceChildren(...rows);
}

// 查询状态失败（服务器 500、网络不通）：没拿到过订单时不能说成"链接写错"，提示"暂时查不到；已付款不要重复付"
let unavailable = false;
function paint() {
  // 文字只在出错时放进去（藏起来的文字也算在页面文字里，恢复后要整段拿掉）
  const un = $('[data-pay-unavailable]');
  un.hidden = !unavailable; un.textContent = unavailable ? c.unavailable : '';
  if (!st) { $('[data-pay-notfound]').hidden = unavailable; $('[data-pay-card]').hidden = true; return; }
  const net = currentNet(st);
  const multi = (st.nets?.length || 0) > 1;
  if (net) st.address = net.address;
  $('[data-pay-network]').textContent = net ? tpl(c.networkOf, { net: netName(net.chain), std: netStd(net.chain) }) : st.nets ? c.stepChoose : c.network;
  $('[data-pay-network]').hidden = !net && !!st.nets;
  $('[data-pay-warn]').textContent = net ? tpl(c.warnOf, { net: netName(net.chain), std: netStd(net.chain) }) : c.warn;
  $('[data-pay-change]').hidden = !multi || !net;
  $('[data-pay-change]').onclick = () => setPick(null);
  const choosing = !!st.nets && !net && open(st);
  $('[data-pay-choose]').hidden = !choosing;
  if (choosing) paintChoose(st);
  root.querySelector<HTMLElement>('[data-pay-step="choose"]')!.hidden = !multi;
  $('[data-pay-card]').hidden = false;
  $('[data-pay-merchant]').textContent = tpl(c.requests, { m: st.merchant });
  $('[data-pay-amount]').textContent = fmtUsdt(st.amount);
  $('[data-pay-address]').textContent = st.address;
  $('[data-pay-order]').textContent = st.id;
  const img = $<HTMLImageElement>('[data-pay-qr]');
  if (st.address && (!img.dataset.for || img.dataset.for !== st.address)) { img.src = qrDataUrl(st.address); img.dataset.for = st.address; }

  const confirming = open(st) && st.confirmations > 0;
  const finished = !open(st);
  $('[data-pay-live]').hidden = finished || confirming || choosing;
  const conf = $('[data-pay-confirming]');
  const partialOpen = st.status === 'partial' && !confirming;
  conf.hidden = !confirming && !partialOpen;
  conf.textContent = confirming ? tpl(c.confirmingN, { n: st.confirmations }) : tpl(c.partialOpen, { got: fmtUsdt(st.received), left: fmtUsdt(Math.max(0, st.amount - st.received)) });

  const res = $('[data-pay-result]');
  res.hidden = !finished;
  if (finished) {
    const v = { amount: fmtUsdt(st.amount), got: fmtUsdt(st.received) };
    const [title, body, icon] = st.status === 'completed' ? [c.done, tpl(c.doneBody, { amount: fmtUsdt(st.received) }), 'ok']
      : st.status === 'overpaid' ? [c.overpaid, tpl(c.overpaidBody, v), 'ok']
      : st.status === 'expired_partial' ? [c.partialExpired, tpl(c.partialExpiredBody, v), 'warn']
      : [c.expired, c.expiredBody, 'expired'];
    $('[data-pay-result-title]').textContent = title;
    $('[data-pay-result-body]').textContent = body;
    $('[data-pay-icon]').className = `pay-icon ${icon}`;
  }
  const step = st.status === 'completed' || st.status === 'overpaid' ? 'completed' : confirming ? 'confirming' : 'waiting';
  const order = ['choose', 'waiting', 'confirming', 'completed'];
  const curStep = choosing ? 'choose' : step;
  root.querySelectorAll<HTMLElement>('[data-pay-step]').forEach((li) => {
    const i = order.indexOf(li.dataset.payStep!), cur = order.indexOf(curStep);
    li.className = i < cur || (step === 'completed' && i === cur) ? 'done' : i === cur && open(st!) ? 'on' : '';
  });
  tick();
}

function tick() {
  if (!st) return;
  const left = Math.max(0, st.expiresAt - Date.now());
  const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
  $('[data-pay-timer]').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  if (left === 0 && open(st) && st.confirmations === 0) { st.status = st.received > 0 ? 'expired_partial' : 'expired'; paint(); }
}
setInterval(tick, 1000);

root.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
  if (!st) return;
  const text = b.dataset.copy === 'address' ? st.address : fmtUsdt(st.amount, 0).replace(/,/g, '');
  try { await navigator.clipboard.writeText(text); } catch { /* 剪贴板不可用 */ }
  const old = b.textContent; b.textContent = c.copied; setTimeout(() => (b.textContent = old), 1500);
}));

// ---------- 原型：模拟链上确认 ----------
let sim = 0;
function simulate(amount: number) {
  if (!st || !open(st)) return;
  clearInterval(sim);
  st.confirmations = 1; paint();
  sim = window.setInterval(() => {
    st!.confirmations += 2;
    if (st!.confirmations >= 19) {
      clearInterval(sim);
      st!.confirmations = 0; st!.received += amount;
      // 与 lib/matching.ts 相同的规则：累计达到 L 为已完成，超过 H 为超额付款
      const r = BigInt(st!.received) * 1_000_000n, a = BigInt(st!.amount);
      st!.status = r >= a * BigInt(st!.low) ? (r > a * BigInt(st!.high) ? 'overpaid' : 'completed') : 'partial';
    }
    paint();
  }, 250);
}
root.querySelectorAll<HTMLButtonElement>('[data-sim]').forEach((b) => b.addEventListener('click', () => {
  if (!st || !initial) return;
  const k = b.dataset.sim;
  if (k === 'reset') { clearInterval(sim); st = { ...initial, status: 'pending', received: 0, confirmations: 0, expiresAt: Math.max(initial.expiresAt, Date.now() + 24 * 60_000) }; }
  else if (k === 'pay') simulate(Math.max(0, st.amount - st.received));
  else if (k === 'partial') simulate(Math.round(st.amount / 2));
  else if (k === 'expire') { clearInterval(sim); st.expiresAt = Date.now(); st.confirmations = 0; if (open(st)) st.status = st.received > 0 ? 'expired_partial' : 'expired'; }
  paint();
}));

// ---------- 正式模式：查询订单状态 ----------
async function poll() {
  if (PROTO || !id) return;
  if (document.visibilityState === 'visible') {
    try {
      const r = await fetch(`/api/pay/?o=${encodeURIComponent(id)}`);
      unavailable = !r.ok && r.status !== 404;
      if (r.ok) {
        const d = await r.json();
        st = { id: d.order_no, merchant: d.merchant, amount: parseUsdt(d.amount) || 0, received: parseUsdt(d.matched) ?? 0, address: d.address || '', expiresAt: Date.parse(d.expires_at), status: d.status, confirmations: 0, low: d.low, high: d.high,
          nets: Array.isArray(d.addresses) ? d.addresses : undefined, fixed: !!d.chain };
      }
      else if (r.status === 404) st = null;
    } catch { unavailable = true; /* 网络暂时不通：保持当前显示，并提示暂时查不到 */ }
    paint();
    if (st && !open(st)) return;
  }
  setTimeout(poll, 5000);
}
if (PROTO) paint(); else if (id) poll(); else paint();
