// 商户后台的数据层：页面只和这里打交道，数据格式和 /api/merchant/ 的返回一致（金额可以是数字或字符串）。
// - 正式模式：调用 /api/merchant/?a=<动作>
// - 原型模式：用 mock.ts 的模拟数据，按同样的格式返回
import { parseUsdt } from '../lib/money';
import { manualMatch, matchOnCreate, stateOf, unmatch } from '../lib/matching';
import * as M from './mock';

export type Amount = number | string;
export interface Mode { enabled: boolean; low: number; high: number; ttlMin: number; lookbackH: number }
export interface Me { authed: boolean; email?: string; merchant?: { id: string; name: string; order_mode: Mode; fee_in: { ppm: number; fixed: number; min: number }; fee_out: { ppm: number; fixed: number; min: number }; cashout_wallets: string[] } }
export interface ChainAddr { chain: 'eth' | 'bsc' | 'tron'; address: string }
export interface Dep { id: string; customer_id: string; chain?: string; address: string; txid: string; amount: Amount; fee: Amount; credited: Amount; result: string; order_no: string | null; matched_by: string | null; time: string; confirmations?: number }
export interface Cust { customer_id: string; name: string; email: string; remark: string; address: string | null; addresses?: ChainAddr[]; total: Amount; count: number; fees: Amount; unmatched: Amount; last_payment_at: string | null; created_at: string }
export interface OrderItem { order_no: string; merchant_order_no: string; customer_id: string; amount: Amount; matched: Amount; status: M.OrderState; created_at: string; expires_at: string }
export interface OrderFull extends OrderItem { address: string | null; network?: string; chain?: string | null; addresses?: ChainAddr[]; pay_url: string; deposits: { id: string; txid: string; amount: Amount; matched_by: string; time: string }[] }
export interface Wd { withdrawal_no: string; kind: 'payout' | 'cashout'; customer_id: string | null; to: string; amount: Amount; fee: Amount; status: string; txid: string | null; reason: string | null; source: 'web' | 'api'; created_at: string }
export interface Led { id: string; type: M.LedgerType; amount: Amount; available_after: Amount; ref: string; customer_id: string | null; created_at: string }
export interface Cb { id: string; event: string; ref: string; status: 'pending' | 'ok' | 'failed'; attempts: number; last_code: number | null; next_at: string | null; created_at: string }
/** 列表最多取这么多条；更早的记录用导出查看 */
export const MAX_ROWS = 1000;
export type List<T> = T[] & { truncated?: boolean };
export interface ApiInfo { api_key: string | null; has_secret: boolean; callback_url: string; ip_whitelist: string[]; order_mode: Mode }

/** 金额转成整数（最小单位），负数也支持 */
export const units = (v: Amount | null | undefined): number => {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  const neg = v.startsWith('-');
  return (parseUsdt(neg ? v.slice(1) : v) ?? 0) * (neg ? -1 : 1);
};
export class ApiErr extends Error { constructor(public code: string, public status = 400, public field?: string) { super(code); } }

export interface MerchantData {
  proto: boolean;
  me(): Promise<Me>;
  login(email: string, password: string, code: string): Promise<void>;
  logout(): Promise<void>;
  setupBegin(token: string, password: string): Promise<{ qr: string; secret: string }>;
  setupConfirm(token: string, code: string): Promise<void>;
  overview(): Promise<{ today_by_chain?: { chain: string; total: Amount; count: number }[]; chains?: string[]; available: Amount; frozen: Amount; today: Amount; today_count: number; today_fees: Amount; open_orders: number; unmatched: Amount; unmatched_count: number; pending_withdrawals: number; recent: Dep[] }>;
  customers(q: string, onePage?: boolean): Promise<Cust[]>;
  customer(id: string, days: number): Promise<{ customer: Cust; stats: { total: Amount; count: number; fees: Amount; unmatched: Amount }; orders: OrderItem[]; deposits: Dep[]; payouts: { withdrawal_no: string; amount: Amount; status: string; created_at: string }[] }>;
  saveCustomer(b: { customer_id: string; name?: string; email?: string; remark?: string }, create?: boolean): Promise<Cust>;
  orders(status: string, customerId: string): Promise<OrderItem[]>;
  order(id: string): Promise<{ order: OrderFull; unmatched: Dep[] }>;
  createOrder(b: { customer_id: string; customer_name?: string; customer_email?: string; merchant_order_no: string; amount: string; chain?: string }): Promise<OrderFull>;
  customerAddresses(id: string): Promise<{ customer_id: string; addresses: ChainAddr[]; chains: string[] }>;
  match(orderNo: string, depositId: string, on: boolean): Promise<void>;
  deposits(customerId: string, onlyUnmatched: boolean): Promise<Dep[]>;
  ledger(customerId: string): Promise<Led[]>;
  withdraw(b: { kind: string; to: string; amount: string; customer_id?: string; code: string }): Promise<Wd>;
  withdrawals(): Promise<Wd[]>;
  cancelWithdrawal(id: string): Promise<void>;
  api(): Promise<ApiInfo>;
  regenerate(code: string): Promise<{ api_key: string; api_secret: string }>;
  saveCallback(url: string): Promise<void>;
  saveIps(ips: string[]): Promise<void>;
  testCallback(): Promise<void>;
  callbacks(): Promise<Cb[]>;
  resend(id: string): Promise<void>;
  exportUrl(type: 'deposits' | 'ledger' | 'customer', customerId?: string): string | null;
}

// ---------- 正式模式 ----------
export function realData(): MerchantData {
  const call = async (a: string, body?: unknown, qs = '') => {
    const res = await fetch(`/api/merchant/?a=${a}${qs}`, body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-topup-csrf': '1' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiErr(data?.error?.code || `http_${res.status}`, res.status, data?.error?.field);
    return data;
  };
  const q = (o: Record<string, string | number | undefined>) => Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `&${k}=${encodeURIComponent(String(v))}`).join('');
  /** 列表接口一页 50 到 100 条：一页一页取完（最多 MAX_ROWS 条），页面上再分段显示。取不完时标记 truncated */
  const all = async <T,>(a: string, qs = '', pages = MAX_ROWS): Promise<List<T>> => {
    const items: T[] = []; let cursor: string | undefined;
    do {
      const r = await call(a, undefined, qs + q({ cursor }));
      items.push(...r.items); cursor = r.next_cursor || undefined;
    } while (cursor && items.length < pages);
    return Object.assign(items, { truncated: !!cursor });
  };
  return {
    proto: false,
    me: () => call('me'),
    login: async (email, password, code) => { await call('login', { email, password, code }); },
    logout: async () => { await call('logout', {}); },
    setupBegin: (token, password) => call('setup-begin', { token, password }),
    setupConfirm: async (token, code) => { await call('setup-confirm', { token, code }); },
    overview: () => call('overview'),
    customers: async (s, onePage) => (onePage ? (await call('customers', undefined, q({ q: s }))).items : all('customers', q({ q: s }))),
    customer: (id, days) => call('customer', undefined, q({ customer_id: id, days })),
    saveCustomer: (b) => call('customer-save', b),
    orders: (status, customerId) => all('orders', q({ status, customer_id: customerId })),
    order: (id) => call('order', undefined, q({ order_no: id })),
    createOrder: (b) => call('order-create', b),
    customerAddresses: (id) => call('customer-addresses', undefined, q({ customer_id: id })),
    match: async (orderNo, depositId, on) => { await call(on ? 'match' : 'unmatch', { order_no: orderNo, deposit_id: depositId }); },
    deposits: (customerId, only) => all('deposits', q({ customer_id: customerId, matched: only ? 'false' : '' })),
    ledger: (customerId) => all('ledger', q({ customer_id: customerId })),
    withdraw: (b) => call('withdraw', b),
    withdrawals: () => all('withdrawals'),
    cancelWithdrawal: async (id) => { await call('withdraw-cancel', { withdrawal_no: id }); },
    api: () => call('api'),
    regenerate: (code) => call('api-regen', { code }),
    saveCallback: async (url) => { await call('callback-save', { callback_url: url }); },
    saveIps: async (ips) => { await call('ip-save', { ip_whitelist: ips }); },
    testCallback: async () => { await call('callback-test', {}); },
    callbacks: () => all('callbacks'),
    resend: async (id) => { await call('callback-resend', { id }); },
    exportUrl: (type, customerId) => `/api/merchant/?a=export&type=${type === 'customer' ? 'deposits' : type}${customerId ? `&customer_id=${encodeURIComponent(customerId)}` : ''}`,
  };
}

// ---------- 原型模式（模拟数据） ----------
export function protoData(): MerchantData {
  const me = M.me;
  const mine = <T extends { merchantId: string }>(xs: T[]) => xs.filter((x) => x.merchantId === me.id);
  const dep = (d: M.Deposit): Dep => ({ id: d.id, customer_id: d.customer, address: d.address, txid: d.txid, amount: d.amount, fee: d.fee, credited: d.credited ? d.amount - d.fee : 0, result: d.result, order_no: d.orderId, matched_by: d.matchType || null, time: d.time, confirmations: d.confirmations });
  const cust = (c: M.Customer): Cust => { const s = M.customerStats(me.id, c.id); return { customer_id: c.id, name: c.name, email: c.email, remark: c.remark, address: c.address, total: s.total, count: s.count, fees: s.fees, unmatched: s.unmatched, last_payment_at: s.last || null, created_at: c.createdAt }; };
  const ord = (o: M.Order): OrderItem => { o.status = stateOf(o); return { order_no: o.id, merchant_order_no: o.merchantNo, customer_id: o.customer, amount: o.amount, matched: o.matched, status: o.status, created_at: o.createdAt, expires_at: o.expiresAt }; };
  const full = (o: M.Order): OrderFull => ({ ...ord(o), address: M.customerOf(me.id, o.customer)?.address || '', pay_url: `${location.origin}${location.pathname.replace(/merchant\/?$/, '')}pay/${o.id}/`,
    deposits: M.deposits.filter((d) => d.orderId === o.id).map((d) => ({ id: d.id, txid: d.txid, amount: d.amount, matched_by: d.matchType || 'deposit', time: d.time })) });
  const wd = (w: M.Withdrawal): Wd => ({ withdrawal_no: w.id, kind: w.kind, customer_id: w.customer || null, to: w.to, amount: w.amount, fee: w.fee, status: w.status === 'signing' ? 'approved' : w.status, txid: w.txid || null, reason: w.reason || null, source: w.source, created_at: w.time });
  const sortD = <T extends { time: string }>(xs: T[]) => [...xs].sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  const api = { key: 'topup_test_7f3a9c21e84b', callback: 'https://api.acme-export.example/topup/callback' };
  const CB: Record<string, string> = { deposit: 'deposit', order: 'order.matched', withdrawal: 'withdrawal.updated' };
  return {
    proto: true,
    me: async () => ({ authed: false }),
    login: async (email, password, code) => { if (!email.includes('@') || !password || !/^\d{6}$/.test(code)) throw new ApiErr('bad_credentials', 401); },
    logout: async () => {},
    setupBegin: async (token, password) => { if (password.length < 12) throw new ApiErr('weak_password'); return { qr: '', secret: 'JBSWY3DPEHPK3PXP' }; },
    setupConfirm: async (token, code) => { if (!/^\d{6}$/.test(code)) throw new ApiErr('bad_code'); },
    overview: async () => {
      const ds = mine(M.deposits);
      const today = ds.filter((d) => d.credited && Date.now() - Date.parse(d.time) < 864e5);
      const un = ds.filter((d) => d.credited && !d.orderId);
      return { available: me.available, frozen: me.frozen, today: today.reduce((s, d) => s + d.amount, 0), today_count: today.length, today_fees: today.reduce((s, d) => s + d.fee, 0),
        open_orders: mine(M.orders).filter((o) => ['pending', 'partial'].includes(stateOf(o))).length, unmatched: un.reduce((s, d) => s + d.amount, 0), unmatched_count: un.length,
        pending_withdrawals: mine(M.withdrawals).filter((w) => w.status === 'pending').length, recent: sortD(ds).slice(0, 6).map(dep) };
    },
    customers: async (s) => { const qs = s.trim().toLowerCase(); return mine(M.customers).filter((x) => !qs || [x.id, x.name, x.email].some((v) => v.toLowerCase().includes(qs))).map(cust); },
    customer: async (id, days) => {
      const c = M.customerOf(me.id, id); if (!c) throw new ApiErr('not_found', 404);
      const since = days ? Date.now() - days * 864e5 : 0;
      const s = M.customerStats(me.id, id, since);
      return { customer: cust(c), stats: { total: s.total, count: s.count, fees: s.fees, unmatched: s.unmatched },
        orders: mine(M.orders).filter((o) => o.customer === id && Date.parse(o.createdAt) >= since).map(ord),
        deposits: sortD(mine(M.deposits).filter((d) => d.customer === id && Date.parse(d.time) >= since)).map(dep),
        payouts: mine(M.withdrawals).filter((w) => w.customer === id && Date.parse(w.time) >= since).map((w) => ({ withdrawal_no: w.id, amount: w.amount, status: w.status, created_at: w.time })) };
    },
    saveCustomer: async (b, create) => {
      if (create && M.customerOf(me.id, b.customer_id)) throw new ApiErr('duplicate_customer');
      const c = M.ensureCustomer(me.id, b.customer_id, b.name || '', b.email || '');
      if (b.name !== undefined) c.name = b.name; if (b.email !== undefined) c.email = b.email; if (b.remark !== undefined) c.remark = b.remark;
      return cust(c);
    },
    orders: async (status, customerId) => mine(M.orders).map(ord).filter((o) => (!status || o.status === status) && (!customerId || o.customer_id.includes(customerId))).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)),
    order: async (id) => {
      const o = M.orders.find((x) => x.id === id); if (!o) throw new ApiErr('not_found', 404);
      return { order: full(o), unmatched: sortD(mine(M.deposits).filter((d) => d.customer === o.customer && d.credited && !d.orderId)).map(dep) };
    },
    customerAddresses: async (id) => ({ customer_id: id, addresses: [], chains: [] }),
    createOrder: async (b) => {
      if (!me.mode.enabled) throw new ApiErr('order_mode_disabled', 403);
      const amount = parseUsdt(b.amount); if (!amount) throw new ApiErr('invalid_param', 422, 'amount');
      if (M.orders.some((o) => o.merchantNo === b.merchant_order_no)) throw new ApiErr('duplicate_merchant_order_no', 409, 'merchant_order_no');
      M.ensureCustomer(me.id, b.customer_id, b.customer_name || '', b.customer_email || '');
      const now = Date.now();
      const o: M.Order = { merchantId: me.id, id: `ORD-20260929-${String(413 + M.orders.length).padStart(4, '0')}`, merchantNo: b.merchant_order_no, customer: b.customer_id, amount, matched: 0, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + me.mode.ttlMin * 60000).toISOString(), status: 'pending', low: me.mode.low, high: me.mode.high };
      M.orders.unshift(o);
      matchOnCreate(o, mine(M.deposits), me.mode.lookbackH);
      return full(o);
    },
    match: async (orderNo, depositId, on) => {
      const o = M.orders.find((x) => x.id === orderNo)!, d = M.deposits.find((x) => x.id === depositId)!;
      if (!(on ? manualMatch(o, d) : unmatch(o, d))) throw new ApiErr(on ? 'cannot_match' : 'not_matched', 409);
    },
    deposits: async (customerId, only) => sortD(mine(M.deposits).filter((d) => (!customerId || d.customer.includes(customerId)) && (!only || (d.credited && !d.orderId)))).map(dep),
    ledger: async (customerId) => M.ledger.filter((l) => !customerId || (l.customer || '').includes(customerId)).map((l, i) => ({ id: String(i), type: l.type, amount: l.amount, available_after: l.balance, ref: l.ref, customer_id: l.customer || null, created_at: l.time })),
    withdraw: async (b) => {
      if (!/^\d{6}$/.test(b.code)) throw new ApiErr('bad_code');
      const a = parseUsdt(b.amount)!;
      const fee = me.feeOut.fixed + Math.ceil((a * me.feeOut.ppm) / 1e6);
      if (a + fee > me.available) throw new ApiErr('insufficient_balance', 422);
      if (b.customer_id) M.ensureCustomer(me.id, b.customer_id);
      const w: M.Withdrawal = { id: `WD-${String(32 + M.withdrawals.length).padStart(4, '0')}`, merchant: me.name, merchantId: me.id, kind: b.kind as 'payout', customer: b.customer_id || undefined, to: b.to, amount: a, fee, source: 'web', status: 'pending', time: new Date().toISOString() };
      M.withdrawals.unshift(w);
      M.ledger.unshift({ time: w.time, type: 'freeze', amount: -(a + fee), balance: me.available - a - fee, ref: w.id, customer: b.customer_id || undefined });
      me.available -= a + fee; me.frozen += a + fee;
      return wd(w);
    },
    withdrawals: async () => mine(M.withdrawals).map(wd),
    cancelWithdrawal: async (id) => {
      const w = M.withdrawals.find((x) => x.id === id)!;
      w.status = 'cancelled'; me.available += w.amount + w.fee; me.frozen -= w.amount + w.fee;
      M.ledger.unshift({ time: new Date().toISOString(), type: 'unfreeze', amount: w.amount + w.fee, balance: me.available, ref: w.id, customer: w.customer });
    },
    api: async () => ({ api_key: api.key, has_secret: true, callback_url: api.callback, ip_whitelist: [...me.ipWhitelist], order_mode: me.mode }),
    regenerate: async (code) => { if (!/^\d{6}$/.test(code)) throw new ApiErr('bad_code'); return { api_key: api.key, api_secret: Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('') }; },
    saveCallback: async (url) => { api.callback = url; },
    saveIps: async (ips) => { me.ipWhitelist = ips; },
    testCallback: async () => { M.callbacks.unshift({ id: 'evt_test' + Date.now().toString(36).slice(-4), time: new Date().toISOString(), event: 'deposit', ref: 'test', attempts: 1, result: 'ok', code: 200 }); },
    callbacks: async () => M.callbacks.map((x) => ({ id: x.id, event: CB[x.event] || x.event, ref: x.ref, status: x.result === 'retrying' ? 'pending' : x.result, attempts: x.attempts, last_code: x.code, next_at: x.next || null, created_at: x.time })),
    resend: async (id) => { const x = M.callbacks.find((c) => c.id === id); if (x) { x.attempts += 1; x.result = 'ok'; x.code = 200; x.next = undefined; } },
    exportUrl: () => null,
  };
}

