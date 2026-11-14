// 收付款接口的公共工具：密钥派生、金额格式、错误响应、查询。
import { hkdfSync, createHmac } from 'node:crypto';
import { json } from '../kyb/http.js';
import { PayError } from './core.js';
import { fmtUsdt, parseUsdt } from './money.js';

/** 收付款用的密钥：和开户（KYB）一样由 APP_SECRET 派生，但用不同的用途标签，两边互不相通 */
export function derivePayKeys(appSecret) {
  if (!appSecret || appSecret.length < 32) throw new Error('APP_SECRET missing or too short (need 32+ chars)');
  const k = (info) => Buffer.from(hkdfSync('sha256', Buffer.from(appSecret, 'utf8'), Buffer.from('topup-pay-v1'), Buffer.from(info), 32));
  // search：客户邮箱的检索哈希
  return { enc: k('enc'), session: k('session'), token: k('token'), search: k('search') };
}

/** 客户邮箱的检索哈希。统一去掉首尾空格、转小写后做 HMAC；数据库里不存明文邮箱，没有密钥也算不出哈希 */
export function emailHash(keys, email) {
  const e = String(email ?? '').trim().toLowerCase();
  return e ? createHmac('sha256', keys.search).update(e).digest('hex') : '';
}

/** 对外的金额一律是字符串，例如 "100.50"（开发者文档） */
export const amt = (u) => (u === null || u === undefined ? null : fmtUsdt(u).replace(/,/g, ''));
const AMOUNT_KEYS = new Set(['amount', 'matched', 'fee', 'credited', 'available', 'frozen', 'total', 'fees', 'unmatched', 'balance', 'available_after', 'frozen_after', 'payouts',
  // 后台接口（这些字段漏转换时，页面会把 0.000001 USDT 为单位的整数当成 USDT 显示，放大 100 万倍）
  'onchain', 'balances', 'chain', 'diff', 'usdt', 'trx', 'burn_trx', 'deposits_total', 'customers_total', 'addresses', 'hot', 'cold', 'today', 'today_fees',
  // 运营后台"概览"
  'collected_total', 'owed_total', 'owed_available', 'owed_frozen', 'assets_total', 'unswept_total', 'hot_usdt', 'cold_usdt',
  'profit_total', 'profit_now', 'profit_after_sweep', 'income_fee_in', 'income_fee_out', 'income_dust', 'withdrawals_amount',
  'over_threshold_total', 'threshold', 'hot_trx', 'month_sweep_trx', 'fees_in']);
// 注意：只有值是数字时才转换，所以 hot、cold 作为地址（字符串）时不受影响；数量类的字段不要用上面的名字（例如 total 是金额，地址数量用 address_count）
/** 把对象里的金额字段（整数）转成字符串 */
export function money(v) {
  if (Array.isArray(v)) return v.map(money);
  if (v && typeof v === 'object' && !(v instanceof Date)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, AMOUNT_KEYS.has(k) && typeof x === 'number' ? amt(x) : money(x)]));
  return v;
}
/** 请求里的金额：字符串或数字，最多 6 位小数 */
export function parseAmount(v, field = 'amount') {
  const u = typeof v === 'number' || typeof v === 'string' ? parseUsdt(String(v)) : null;
  if (!u) throw new PayError('invalid_param', 422, field);
  return u;
}

const MESSAGES = {
  invalid_signature: 'Missing or invalid signature', timestamp_expired: 'Timestamp is more than 5 minutes from server time', ip_not_allowed: 'Request IP is not whitelisted for withdrawals',
  merchant_disabled: 'Account disabled', not_found: 'Not found', invalid_param: 'Invalid or missing parameter', insufficient_balance: 'Amount + fee exceeds available balance',
  duplicate_merchant_order_no: 'merchant_order_no already used', idempotency_conflict: 'Idempotency-Key reused with a different request', order_mode_disabled: 'Order mode is not enabled for this account',
  idempotency_key_required: 'Idempotency-Key header is required', rate_limited: 'Too many requests', wallet_not_initialized: 'Service not ready', invalid_address: 'Invalid TRON address',
  address_not_registered: 'Address is not a registered cash-out wallet', invalid_state: 'Not allowed in the current state', request_in_progress: 'A request with this Idempotency-Key is still in progress', cannot_match: 'Deposit cannot be matched to this order', not_matched: 'Deposit is not matched to this order',
};
export function errorResponse(e) {
  if (e instanceof PayError) return json(e.status, { error: { code: e.code, message: MESSAGES[e.code] || e.code, ...(e.field ? { field: e.field } : {}), ...(e.rows ? { rows: e.rows } : {}) } });
  if (e?.status && e.message) return json(e.status, { error: { code: e.message, message: MESSAGES[e.message] || e.message } });
  console.error(`[pay] ${e?.stack || e}`);
  return json(500, { error: { code: 'internal_error', message: 'Internal error' } });
}

/** 翻页：按自增 id 倒序，cursor 是上一页最后一条的 id */
export function page(rows, limit) {
  const more = rows.length > limit;
  const items = more ? rows.slice(0, limit) : rows;
  return { items, next_cursor: more ? String(items[items.length - 1].cursor) : null };
}
export const limitOf = (q) => Math.min(100, Math.max(1, Number(q.get('limit')) || 50));
export const iso = (v) => (v ? new Date(v).toISOString() : null);
