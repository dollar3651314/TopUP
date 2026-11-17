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
  'over_threshold_total', 'threshold', 'hot_trx', 'month_sweep_trx', 'fees_in',
  // 对账的各链明细
  'receivable',
  // v1.1 冲正和欠款
  'debt', 'debt_after', 'taken', 'debt_added', 'net', 'gross', 'from_available', 'to_debt', 'merchant_debt']);
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
  batch_item_cancel: 'This withdrawal belongs to a batch payout; cancel the batch instead (only its not-yet-reviewed items)',
  merchant_disabled: 'Account disabled', not_found: 'Not found', invalid_param: 'Invalid or missing parameter', insufficient_balance: 'Amount + fee exceeds available balance',
  duplicate_merchant_order_no: 'merchant_order_no already used', duplicate_merchant_ref: 'merchant_ref already used by another withdrawal (see error.withdrawal_no)', idempotency_conflict: 'Idempotency-Key reused with a different request', order_mode_disabled: 'Order mode is not enabled for this account',
  idempotency_key_required: 'Idempotency-Key header is required', rate_limited: 'Too many requests', wallet_not_initialized: 'Service not ready', invalid_address: 'Invalid TRON address',
  address_not_registered: 'Address is not a registered cash-out wallet', invalid_state: 'Not allowed in the current state', request_in_progress: 'A request with this Idempotency-Key is still in progress', cannot_match: 'Deposit cannot be matched to this order', not_matched: 'Deposit is not matched to this order',
  debt_outstanding: 'Outstanding debt from a reversed deposit; withdrawals are blocked until later deposits repay it',
  node_busy: 'Blockchain node is busy, try again later', rpc_unreachable: 'Blockchain node is unreachable, try again later',
  node_error: 'Blockchain node returned an error, try again later', stale_page: 'The page is out of date, reload it',
};
export function errorResponse(e) {
  if (e instanceof PayError) return json(e.status, { error: { code: e.code, message: MESSAGES[e.code] || e.code, ...(e.field ? { field: e.field } : {}), ...(e.withdrawal_no ? { withdrawal_no: e.withdrawal_no } : {}), ...(e.rows ? { rows: e.rows } : {}) } });
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

// ---------- 对账查询的时间段（v1.1）：from、to 是带时区的 ISO 8601，区间 [from, to)，一次最多 31 天 ----------
export const MAX_RANGE_DAYS = 31;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|z|([+-])(\d{2}):?(\d{2}))$/;
/**
 * 解析一个带时区的 ISO 8601 时间。格式错、没带时区、日期不存在 → 422 invalid_param（field）。
 * 返回 { us: 距 1970 的微秒数, sql: 统一成 UTC 的字符串（给数据库比较用，保留到微秒） }
 */
export function parseIsoTime(v, field) {
  const m = ISO_RE.exec(String(v ?? '').trim());
  const bad = () => new PayError('invalid_param', 422, field);
  if (!m) throw bad();
  const [y, mo, d, h, mi, s = 0] = m.slice(1, 7).map((x) => Number(x || 0));
  const frac = (m[7] || '').padEnd(6, '0');
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) throw bad();
  if (new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d) throw bad(); // 2 月 30 日之类
  let off = 0;
  if (m[9]) {
    const oh = Number(m[10]), om = Number(m[11]);
    if (oh > 23 || om > 59) throw bad();
    off = (m[9] === '-' ? -1 : 1) * (oh * 60 + om) * 60_000;
  }
  const sec = Date.UTC(y, mo - 1, d, h, mi, s) - off; // 整秒（毫秒数）
  if (!Number.isFinite(sec) || sec < 0) throw bad(); // 换成 UTC 后早于 1970 年的也拒（所以要先算时区再比）
  return { us: sec * 1000 + Number(frac), sql: `${new Date(sec).toISOString().slice(0, 19)}.${frac}Z` };
}
/**
 * 查询参数里的时间段。from、to 都没带返回 null（旧调用，行为不变），除非 always（withdrawals/list 总按时间段查）。
 * 只带一个时补另一个：to 不传 = 现在，from 不传 = to − 31 天。
 * from 晚于 to → field from；超过 31 天 → field to。返回 { from, to }（数据库比较用的 UTC 字符串，保留到微秒）
 */
export function timeRange(q, nowMs, { always = false } = {}) {
  const rawFrom = q.get('from'), rawTo = q.get('to');
  const hasFrom = rawFrom !== null && rawFrom !== '';
  const hasTo = rawTo !== null && rawTo !== '';
  if (!hasFrom && !hasTo && !always) return null;
  const to = hasTo ? parseIsoTime(rawTo, 'to') : parseIsoTime(new Date(nowMs).toISOString(), 'to');
  const from = hasFrom ? parseIsoTime(rawFrom, 'from') : parseIsoTime(new Date(Math.floor(to.us / 1000) - MAX_RANGE_DAYS * 86_400_000).toISOString(), 'from');
  if (from.us > to.us) throw new PayError('invalid_param', 422, 'from');
  if (to.us - from.us > MAX_RANGE_DAYS * 86_400_000_000) throw new PayError('invalid_param', 422, 'to');
  return { from: from.sql, to: to.sql };
}
/** 从早到晚翻页的游标：上一页最后一条的（时间，编号），时间保留到微秒；对外是不透明字符串 */
export const encodeCursor = (t, id) => Buffer.from(JSON.stringify([t, String(id)])).toString('base64url');
const CURSOR_ID = { bigint: /^\d{1,18}$/, text: /^[A-Za-z0-9_-]{1,64}$/ };
/** 解开游标；被改过的（解不开、时间不是真实日期、编号格式不对）→ 422 invalid_param（field cursor），不让它跑到数据库报 500 */
export function decodeCursor(c, idCast = 'bigint') {
  const bad = () => new PayError('invalid_param', 422, 'cursor');
  let t, id;
  try { [t, id] = JSON.parse(Buffer.from(String(c), 'base64url').toString('utf8')); } catch { throw bad(); }
  if (typeof t !== 'string' || typeof id !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(t) || !(CURSOR_ID[idCast] || CURSOR_ID.text).test(id)) throw bad();
  try { parseIsoTime(t, 'cursor'); } catch { throw bad(); }
  return { t, id };
}
/** 旧接口（不带时间段）的数字游标：只认 maxDigits 位以内的数字，别的 → 422 invalid_param（field cursor） */
export function numCursor(c, maxDigits = 15) {
  const s = String(c);
  if (!new RegExp(`^\\d{1,${maxDigits}}$`).test(s)) throw new PayError('invalid_param', 422, 'cursor');
  return Number(s);
}
/** select 里取出微秒精度的 UTC 时间字符串（游标用） */
export const usText = (col) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
/**
 * 按时间段从早到晚翻一页（对账查询共用）：where 已限定商户等条件，vals 是它用到的参数。
 * 排序（时间列, id），游标是上一页最后一条的（时间, id），所以翻页途中新进的记录不改变已翻过的页。
 */
export async function rangePage(db, { table, timeCol, idCast, where, vals, range, cursor, limit }) {
  vals = [...vals];
  const p = (v) => { vals.push(v); return `$${vals.length}`; };
  // 时间一律按文本传进去再在库里转（$n::text::timestamptz）：直接写 $n::timestamptz 时数据库驱动会把参数当时间、
  // 先在程序里转成 Date 再发，微秒被截成毫秒（区间边界和游标都会错位）
  const ts = (v) => `${p(v)}::text::timestamptz`;
  if (range.from) where += ` and ${timeCol} >= ${ts(range.from)}`;
  where += ` and ${timeCol} < ${ts(range.to)}`;
  if (cursor) {
    // 游标那一条的时间直接从库里取（记录的创建时间不会变）；那一条查不到时才用游标里的时间
    const c = decodeCursor(cursor, idCast);
    const id = p(c.id);
    where += ` and (${timeCol}, id) > (coalesce((select ${timeCol} from ${table} where id = ${id}::text::${idCast} and merchant_id = $1), ${ts(c.t)}), ${id}::text::${idCast})`;
  }
  const rows = await db.query(`select *, ${usText(timeCol)} as cursor_t from ${table} where ${where} order by ${timeCol}, id limit ${p(limit + 1)}`, vals);
  const more = rows.length > limit;
  const items = more ? rows.slice(0, limit) : rows;
  return { items, next_cursor: more ? encodeCursor(items.at(-1).cursor_t, items.at(-1).id) : null };
}
