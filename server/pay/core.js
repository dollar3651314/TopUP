// 收付款核心服务：客户、订单、到账、匹配、余额、提币。
// 所有改动余额的操作都在一个事务里：先更新 balances（有 >= 0 约束），再追加一条账本记录。
// 同一个客户的匹配操作都先锁住这个客户的记录（SELECT … FOR UPDATE），到账和建单同时发生也不会重复匹配。
import { randomBytes } from 'node:crypto';
import { calcFee } from './money.js';
import { matchOnDeposit, matchOnCreate, manualMatch as ruleManual, unmatch as ruleUnmatch, stateOf } from './matching.js';
import { isValidAddress } from './tron.js';
import { isChecksumAddress, checksumAddress } from '../wallet/evm-payout-codec.js';

export const MIN_CREDIT = 1_000_000; // 低于 1 USDT 的到账不入账
export const CUSTOMER_RE = /^[A-Za-z0-9_.@-]{1,128}$/;
export const ORDER_NO_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OPEN = ['pending', 'partial'];
export const PAYOUT_CHAINS = ['eth', 'bsc', 'tron'];
const TRON_ZERO = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';

/** 按链校验收款地址：ETH / BSC 是 0x 地址（大小写混合的必须校验和正确，返回 EIP-55 写法），TRON 是 Base58；不对返回 null */
export function chainAddress(chain, to) {
  const s = typeof to === 'string' ? to.trim() : '';
  // 全 0 地址（TRON 是 T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb）付不出去：BatchPayout 会整批回滚，TRON 会烧掉，一律不收
  if (chain === 'tron') return isValidAddress(s) && s !== TRON_ZERO ? s : null;
  if (chain === 'eth' || chain === 'bsc') return isChecksumAddress(s) && !/^0x0{40}$/i.test(s) ? checksumAddress(s) : null;
  return null;
}
/** 商户登记的提现地址：元素是 { chain, address }；老数据里的字符串当作 TRON。返回规范化后的数组，有不对的抛出 invalid_address */
export function normalizeCashoutWallets(list, field = 'cashout_wallets') {
  if (!Array.isArray(list)) throw new PayError('invalid_param', 422, field);
  // 出错时 rows 写明第几行（从 1 起），页面据此提示"第 N 行"
  const bad = (code, i) => Object.assign(new PayError(code, 422, field), { rows: [{ line: i + 1, code }] });
  return list.map((w, i) => {
    const chain = typeof w === 'string' ? 'tron' : w?.chain;
    if (!PAYOUT_CHAINS.includes(chain)) throw bad('invalid_param', i);
    const address = chainAddress(chain, typeof w === 'string' ? w : w.address);
    if (!address) throw bad('invalid_address', i);
    return { chain, address };
  });
}
/** 这个地址是不是商户在这条链上登记过的提现地址（同一串 0x 登记在以太坊不算登记在 BSC） */
export function isRegisteredCashout(merchant, chain, address) {
  return (merchant.cashout_wallets || []).some((w) => {
    const c = typeof w === 'string' ? 'tron' : w?.chain;
    const a = typeof w === 'string' ? w : w?.address;
    if (c !== chain || typeof a !== 'string') return false;
    return chain === 'tron' ? a === address : a.toLowerCase() === address.toLowerCase();
  });
}

export class PayError extends Error {
  constructor(code, status = 422, field) { super(code); this.code = code; this.status = status; this.field = field; }
}
const rid = (n = 6) => randomBytes(n).toString('hex').slice(0, n * 2).toUpperCase();
const day = (d = new Date()) => d.toISOString().slice(0, 10).replace(/-/g, '');
const iso = (v) => (v ? new Date(v).toISOString() : null);
export const newId = {
  merchant: () => `m_${rid(5).toLowerCase()}`,
  order: () => `ORD-${day()}-${rid(4)}`,
  withdrawal: () => `WD-${day()}-${rid(4)}`,
  event: () => `evt_${randomBytes(8).toString('hex')}`,
  batch: () => `B-${day()}-${rid(4)}`,
};

// ---------- 通用 ----------
export async function getMeta(q, key, fallback = null) {
  const [r] = await q.query('select value from pay_meta where key = $1', [key]);
  return r ? r.value : fallback;
}
export async function setMeta(q, key, value) {
  await q.query(`insert into pay_meta (key, value) values ($1, $2::jsonb)
    on conflict (key) do update set value = excluded.value, updated_at = now()`, [key, JSON.stringify(value)]);
}
export async function audit(q, actor, action, target = '', detail = {}) {
  await q.query('insert into pay_audit (actor, action, target, detail) values ($1, $2, $3, $4::jsonb)', [actor, action, target, JSON.stringify(detail)]);
}
/** 生成一条待发送的回调（由每分钟的任务发送，失败自动重试） */
export async function enqueueCallback(q, merchantId, type, data) {
  const id = newId.event();
  const payload = { id, type, created_at: new Date().toISOString(), data };
  await q.query('insert into callbacks (id, merchant_id, event, payload) values ($1, $2, $3, $4::jsonb)', [id, merchantId, type, JSON.stringify(payload)]);
  return id;
}

/** 改余额并追加账本：dAvail、dFrozen 是可用和冻结的变化量；余额不够时数据库约束会拒绝 */
export async function post(q, merchantId, type, dAvail, dFrozen, ref, customerId = null) {
  let b;
  try {
    [b] = await q.query('update balances set available = available + $2, frozen = frozen + $3 where merchant_id = $1 returning available, frozen, debt', [merchantId, dAvail, dFrozen]);
  } catch (e) {
    if (/check constraint/i.test(e.message)) throw new PayError('insufficient_balance');
    throw e;
  }
  if (!b) throw new PayError('merchant_not_found', 404);
  await q.query('insert into ledger (merchant_id, type, amount, available_after, frozen_after, ref, customer_id, debt_after) values ($1, $2, $3, $4, $5, $6, $7, $8)',
    [merchantId, type, type === 'withdraw' || type === 'fee_out' ? dFrozen : dAvail, b.available, b.frozen, ref, customerId, b.debt]);
  return b;
}
/**
 * v1.1 冲正和欠款：改可用余额和欠款并追加账本（reversal、debt_repay）。debt_after 是变动后的欠款。
 * 账本 amount 默认是可用余额的变化（dAvail）；冲正一行写入账净额（amount），明细（detail）写从可用余额扣多少、记成欠款多少。
 * 可用余额不许为负、欠款不许为负（数据库约束）；调用方先算好不会越界的金额
 */
export async function postDebt(q, merchantId, type, dAvail, dDebt, ref, customerId = null, { amount = dAvail, detail = {} } = {}) {
  const [b] = await q.query('update balances set available = available + $2, debt = debt + $3 where merchant_id = $1 returning available, frozen, debt', [merchantId, dAvail, dDebt]);
  if (!b) throw new PayError('merchant_not_found', 404);
  await q.query('insert into ledger (merchant_id, type, amount, available_after, frozen_after, ref, customer_id, debt_after, detail) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)',
    [merchantId, type, amount, b.available, b.frozen, ref, customerId, b.debt, JSON.stringify(detail)]);
  return b;
}
/** 有欠款（到账被冲正、余额不够扣）时不能提币：开放 API、商户后台的提币和批量打款都挡（409 debt_outstanding），已有的待审核单也不能通过。lock：在事务里锁住余额行 */
export async function assertNoDebt(q, merchantId, lock = false) {
  const [b] = await q.query(`select debt from balances where merchant_id = $1${lock ? ' for update' : ''}`, [merchantId]);
  if (b && Number(b.debt) > 0) throw new PayError('debt_outstanding', 409);
}
/** 到账入账后先还欠款：还 min(可用余额, 欠款)，账本追加一行 debt_repay（同一个事务里，到账、手续费两行之后） */
export async function repayDebt(q, merchantId, ref, customerId = null) {
  const [b] = await q.query('select available, debt from balances where merchant_id = $1 for update', [merchantId]);
  const x = b ? Math.min(Number(b.available), Number(b.debt)) : 0;
  if (x <= 0) return 0;
  await postDebt(q, merchantId, 'debt_repay', -x, -x, ref, customerId);
  return x;
}

// ---------- 商户 ----------
export const DEFAULT_MODE = { enabled: true, low: 900_000, high: 1_100_000, ttlMin: 30, lookbackH: 24 };
export function checkMode(m) {
  const ok = m && typeof m.enabled === 'boolean' && Number.isInteger(m.low) && m.low >= 10_000 && m.low <= 1_000_000
    && Number.isInteger(m.high) && m.high >= 1_000_000 && m.high <= 10_000_000
    && Number.isInteger(m.ttlMin) && m.ttlMin >= 5 && m.ttlMin <= 1440 && Number.isInteger(m.lookbackH) && m.lookbackH >= 0 && m.lookbackH <= 72;
  if (!ok) throw new PayError('invalid_order_mode', 422, 'order_mode');
  return { enabled: m.enabled, low: m.low, high: m.high, ttlMin: m.ttlMin, lookbackH: m.lookbackH };
}
export function checkFee(f, field) {
  const ok = f && [f.ppm, f.fixed, f.min].every((x) => Number.isInteger(x) && x >= 0) && f.ppm < 1_000_000;
  if (!ok) throw new PayError('invalid_fee', 422, field);
  return { ppm: f.ppm, fixed: f.fixed, min: f.min };
}
export async function createMerchant(db, { id = newId.merchant(), name, kybRef = null, feeIn, feeOut, mode = DEFAULT_MODE, cashoutWallets = [] }) {
  if (!name) throw new PayError('invalid_param', 422, 'name');
  cashoutWallets = normalizeCashoutWallets(cashoutWallets);
  return db.tx(async (t) => {
    await t.query(`insert into merchants (id, name, kyb_ref, fee_in, fee_out, order_mode, cashout_wallets) values ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb)`,
      [id, name, kybRef, JSON.stringify(checkFee(feeIn, 'fee_in')), JSON.stringify(checkFee(feeOut, 'fee_out')), JSON.stringify(checkMode(mode)), JSON.stringify(cashoutWallets)]);
    await t.query('insert into balances (merchant_id) values ($1)', [id]);
    return getMerchant(t, id);
  });
}
export async function getMerchant(q, id) {
  const [m] = await q.query('select m.*, b.available, b.frozen from merchants m join balances b on b.merchant_id = m.id where m.id = $1', [id]);
  return m || null;
}

// ---------- 客户 ----------
/** 取得客户；不存在时创建（不生成地址） */
export async function ensureCustomer(t, merchantId, customerId, { name = '', emailEnc = '', emailHash = '' } = {}) {
  if (!CUSTOMER_RE.test(customerId || '')) throw new PayError('invalid_param', 422, 'customer_id');
  const [found] = await t.query('select * from customers where merchant_id = $1 and customer_id = $2', [merchantId, customerId]);
  if (found) return found;
  // K1：建客户不生成任何地址（不再派生 TRON 地址，不需要 TRON 主助记词）；地址在客户发起充值时按链生成（server/wallet/addresses.js）
  const [c] = await t.query(`insert into customers (merchant_id, customer_id, name, email_enc, email_hash) values ($1, $2, $3, $4, $5)
    on conflict (merchant_id, customer_id) do nothing returning *`, [merchantId, customerId, String(name).slice(0, 200), emailEnc, emailHash]);
  if (c) return c;
  // 并发时另一个请求先建好了：用那一条（这次推导的序号作废，不影响任何人的资金）
  const [again] = await t.query('select * from customers where merchant_id = $1 and customer_id = $2', [merchantId, customerId]);
  return again;
}
const lockCustomer = (t, merchantId, customerId) => t.query('select 1 from customers where merchant_id = $1 and customer_id = $2 for update', [merchantId, customerId]);

// ---------- 订单与匹配 ----------
const toOrder = (r) => ({ id: r.id, customer: r.customer_id, amount: r.amount, matched: r.matched, createdAt: iso(r.created_at), expiresAt: iso(r.expires_at), status: r.status, low: r.low, high: r.high });
const toDeposit = (r) => ({ id: String(r.id), customer: r.customer_id, amount: r.amount, time: iso(r.time), credited: r.result === 'credited', orderId: r.order_id, matchType: r.match_type || undefined });

export async function orderView(q, id) {
  const [o] = await q.query('select * from orders where id = $1', [id]);
  if (!o) return null;
  const ds = await q.query('select id, txid, amount, match_type, time from deposits where order_id = $1 order by time', [id]);
  return {
    order_no: o.id, merchant_order_no: o.merchant_order_no, customer_id: o.customer_id, amount: o.amount, matched: o.matched, status: o.status,
    created_at: iso(o.created_at), expires_at: iso(o.expires_at), deposits: ds.map((d) => ({ id: String(d.id), txid: d.txid, amount: d.amount, matched_by: d.match_type, time: iso(d.time) })),
  };
}
async function orderCallback(t, merchantId, orderId, manual = false) {
  const v = await orderView(t, orderId);
  await enqueueCallback(t, merchantId, 'order.matched', { ...v, manual });
}
/** 把规则函数修改过的订单、到账写回数据库 */
async function saveOrder(t, o) { await t.query('update orders set matched = $2, status = $3 where id = $1', [o.id, o.matched, o.status]); }
async function saveDepositMatch(t, d) {
  await t.query('update deposits set order_id = $2, match_type = $3, matched_at = case when $2::text is null then null else now() end where id = $1', [Number(d.id), d.orderId, d.matchType || null]);
}
async function refreshUnmatched(t, merchantId, customerId) {
  await t.query(`update customers set unmatched = coalesce((select sum(amount) from deposits where merchant_id = $1 and customer_id = $2 and result = 'credited' and order_id is null), 0)
    where merchant_id = $1 and customer_id = $2`, [merchantId, customerId]);
}

export async function createOrder(db, merchant, { customerId, customerName = '', customerEmailEnc = '', customerEmailHash = '', merchantOrderNo, amount, chain = null }) {
  const mode = merchant.order_mode;
  if (!mode.enabled) throw new PayError('order_mode_disabled', 403);
  if (!ORDER_NO_RE.test(merchantOrderNo || '')) throw new PayError('invalid_param', 422, 'merchant_order_no');
  if (!Number.isInteger(amount) || amount <= 0) throw new PayError('invalid_param', 422, 'amount');
  return db.tx(async (t) => {
    const c = await ensureCustomer(t, merchant.id, customerId, { name: customerName, emailEnc: customerEmailEnc, emailHash: customerEmailHash });
    await lockCustomer(t, merchant.id, customerId);
    const id = newId.order();
    const now = new Date();
    try {
      await t.query(`insert into orders (id, merchant_id, merchant_order_no, customer_id, amount, status, low, high, created_at, expires_at, chain)
        values ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10)`,
        [id, merchant.id, merchantOrderNo, customerId, amount, mode.low, mode.high, now, new Date(now.getTime() + mode.ttlMin * 60_000), chain]);
    } catch (e) {
      if (/unique|duplicate/i.test(e.message)) throw new PayError('duplicate_merchant_order_no', 409, 'merchant_order_no');
      throw e;
    }
    // 方向二：先到账、后建订单
    if (mode.lookbackH > 0) {
      const [row] = await t.query('select * from orders where id = $1', [id]);
      const o = toOrder(row);
      const since = new Date(now.getTime() - mode.lookbackH * 3_600_000);
      const cands = (await t.query(`select * from deposits where merchant_id = $1 and customer_id = $2 and result = 'credited' and order_id is null and time >= $3 and time <= $4 order by time`,
        [merchant.id, customerId, since, now])).map(toDeposit);
      const hit = matchOnCreate(o, cands, mode.lookbackH);
      if (hit.length) {
        for (const d of hit) await saveDepositMatch(t, d);
        await saveOrder(t, o);
        await refreshUnmatched(t, merchant.id, customerId);
        await orderCallback(t, merchant.id, id);
      }
    }
    return { ...(await orderView(t, id)), address: c.address };
  });
}

/** 手动匹配 / 解除匹配：只允许同一个客户，不改余额 */
export async function setMatch(db, merchantId, orderId, depositId, match, actor) {
  return db.tx(async (t) => {
    const [row] = await t.query('select * from orders where id = $1 and merchant_id = $2', [orderId, merchantId]);
    if (!row) throw new PayError('not_found', 404);
    await lockCustomer(t, merchantId, row.customer_id);
    const [drow] = await t.query('select * from deposits where id = $1 and merchant_id = $2', [Number(depositId), merchantId]);
    if (!drow) throw new PayError('not_found', 404);
    const o = toOrder((await t.query('select * from orders where id = $1', [orderId]))[0]);
    const d = toDeposit(drow);
    const ok = match ? ruleManual(o, d) : ruleUnmatch(o, d);
    if (!ok) throw new PayError(match ? 'cannot_match' : 'not_matched', 409);
    await saveDepositMatch(t, d);
    await saveOrder(t, o);
    await refreshUnmatched(t, merchantId, row.customer_id);
    await audit(t, actor, match ? 'order.match' : 'order.unmatch', orderId, { deposit: depositId });
    await orderCallback(t, merchantId, orderId, true);
    return orderView(t, orderId);
  });
}

/**
 * v1.1 冲正：到账被冲正时解除它的订单匹配（订单 matched 减回、状态按现在重算），发 order.matched 回调。在调用方的事务里；返回订单号（没匹配为 null）
 */
export async function releaseDepositMatch(t, drow, now = Date.now()) {
  if (!drow.order_id) return null;
  await lockCustomer(t, drow.merchant_id, drow.customer_id);
  const [row] = await t.query('select * from orders where id = $1 for update', [drow.order_id]);
  if (!row) return null;
  const o = toOrder(row), d = toDeposit(drow);
  if (!ruleUnmatch(o, d, now)) return null;
  await saveDepositMatch(t, d);
  await saveOrder(t, o);
  await refreshUnmatched(t, drow.merchant_id, drow.customer_id);
  await orderCallback(t, drow.merchant_id, o.id);
  return o.id;
}

/**
 * 到了过期时间、还没达到下限的订单：改为已过期或部分付款（已过期）。由每分钟的任务调用。
 * 过期后再等 EXPIRY_GRACE_MS 才处理：链上确认和扫描要 1～2 分钟，过期前付的钱可能过期后才扫到；
 * 扫到时按链上付款时间匹配（matchOnDeposit），订单这时还没关闭，就能匹配上
 */
export const EXPIRY_GRACE_MS = 5 * 60_000;
export async function expireOrders(db, now = new Date()) {
  const due = await db.query(`select id, merchant_id from orders where status in ('pending', 'partial') and expires_at <= $1 limit 500`, [new Date(now.getTime() - EXPIRY_GRACE_MS)]);
  for (const { id, merchant_id } of due) {
    await db.tx(async (t) => {
      const [row] = await t.query(`select * from orders where id = $1 and status in ('pending', 'partial') for update`, [id]);
      if (!row) return;
      const o = toOrder(row);
      o.status = stateOf(o, now.getTime());
      if (OPEN.includes(o.status)) return;
      await saveOrder(t, o);
      await orderCallback(t, merchant_id, id);
    });
  }
  return due.length;
}

// ---------- 到账 ----------
/**
 * 记一笔链上到账（已确认的 USDT 转账）。重复的转账（同一条链、交易号 + 日志序号）自动忽略。
 * chain：eth / bsc 的到账按（链、地址）在 customer_addresses 里找客户（停用的旧地址照常入账）；
 * 不带 chain 的是 TRON，按原来的 customers.address 找。
 * 返回 { status: 'ignored' | 'duplicate' | 'below_min' | 'credited', ... }
 */
export async function recordDeposit(db, { chain = 'tron', txid, logIndex, block, to, amount, time, rawAmount = null }) {
  if (!['eth', 'bsc', 'tron'].includes(chain)) throw new Error(`recordDeposit: unsupported chain ${chain}`);
  amount = Number(amount);
  return db.tx(async (t) => {
    // 找客户：ETH、BSC 按 customer_addresses（地址不分大小写）；TRON 先按 customer_addresses（第 2 批的合约地址只在这里，T 开头区分大小写），
    // 找不到再按第 0 批的 customers.address。legacy：钱在第 0 批的助记词地址上（由原来的浏览器签名归集，要记 customers.onchain）
    let legacy = false;
    let [c] = chain !== 'tron'
      ? await t.query(`select c.*, m.fee_in, m.order_mode from customer_addresses a join customers c on c.merchant_id = a.merchant_id and c.customer_id = a.customer_id
          join merchants m on m.id = c.merchant_id where a.chain = $1 and lower(a.address) = lower($2)`, [chain, to])
      : await t.query(`select c.*, m.fee_in, m.order_mode, a.provider addr_provider from customer_addresses a join customers c on c.merchant_id = a.merchant_id and c.customer_id = a.customer_id
          join merchants m on m.id = c.merchant_id where a.chain = 'tron' and a.address = $1`, [to]);
    if (chain === 'tron') {
      if (c) legacy = c.addr_provider === 'legacy_hd';
      else {
        [c] = await t.query('select c.*, m.fee_in, m.order_mode from customers c join merchants m on m.id = c.merchant_id where c.address = $1', [to]);
        legacy = Boolean(c);
      }
    }
    if (!c) return { status: 'ignored' };
    await lockCustomer(t, c.merchant_id, c.customer_id);
    const credited = amount >= MIN_CREDIT;
    // 手续费最多等于到账金额（最低收费大于到账金额时，不能让余额变成负数、整个扫链停住）
    const fee = credited ? Math.min(calcFee(amount, c.fee_in), amount) : 0;
    const [d] = await t.query(`insert into deposits (chain, txid, log_index, block, address, merchant_id, customer_id, amount, fee, result, time, raw_amount)
      values ($11, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $12) on conflict (chain, txid, log_index) do nothing returning *`,
      [txid, logIndex, block, to, c.merchant_id, c.customer_id, amount, fee, credited ? 'credited' : 'below_min', new Date(time), chain, rawAmount === null ? null : String(rawAmount)]);
    if (!d) return { status: 'duplicate' };
    // 不论是否入账，钱都在这个地址上，归集时要算进去（TRON 的旧归集和对账用；ETH、BSC 归集前向链上查余额）
    if (legacy) await t.query('update customers set onchain = onchain + $3 where merchant_id = $1 and customer_id = $2', [c.merchant_id, c.customer_id, amount]);
    if (!credited) {
      await t.query(`insert into anomalies (type, merchant_id, customer_id, address, amount, ref) values ('below_min', $1, $2, $3, $4, $5) on conflict do nothing`,
        [c.merchant_id, c.customer_id, to, `${amount / 1e6} USDT`, `${txid}:${logIndex}`]); // 同一笔交易里可能有几次转账
      return { status: 'below_min', deposit: d };
    }
    const ref = txid.slice(0, 16);
    await post(t, c.merchant_id, 'deposit', amount, 0, ref, c.customer_id);
    if (fee) await post(t, c.merchant_id, 'fee_in', -fee, 0, ref, c.customer_id);
    await repayDebt(t, c.merchant_id, ref, c.customer_id); // v1.1：有欠款时到账先还欠款
    await t.query('update customers set total = total + $3, count = count + 1, fees = fees + $4, last_at = greatest(coalesce(last_at, $5), $5) where merchant_id = $1 and customer_id = $2',
      [c.merchant_id, c.customer_id, amount, fee, new Date(time)]);
    let order = null;
    if (c.order_mode.enabled) {
      const opens = (await t.query(`select * from orders where merchant_id = $1 and customer_id = $2 and status in ('pending', 'partial')`, [c.merchant_id, c.customer_id])).map(toOrder);
      const dep = toDeposit(d);
      // 用链上的付款时间判断订单是否已过期：扫描晚了几秒，也不会把按时付的钱当成过期
      order = matchOnDeposit(dep, opens, new Date(time).getTime());
      if (order) { await saveDepositMatch(t, dep); await saveOrder(t, order); }
    }
    await refreshUnmatched(t, c.merchant_id, c.customer_id);
    await enqueueCallback(t, c.merchant_id, 'deposit', {
      customer_id: c.customer_id, chain, address: to, txid, amount, fee, credited: amount - fee, order_no: order ? order.id : null, time: new Date(time).toISOString(),
    });
    if (order) await orderCallback(t, c.merchant_id, order.id);
    return { status: 'credited', deposit: d, order: order ? order.id : null };
  });
}

// ---------- 提币 ----------
export async function requestWithdrawal(db, merchant, { kind, chain = 'tron', to, amount, customerId = null, source, merchantRef = null }) {
  await assertNoDebt(db, merchant.id); // 有欠款先说欠款（参数再对也提不了）；事务里锁住余额行再查一次
  if (!['payout', 'cashout'].includes(kind)) throw new PayError('invalid_param', 422, 'kind');
  if (!PAYOUT_CHAINS.includes(chain)) throw new PayError('invalid_param', 422, 'chain');
  const addr = chainAddress(chain, to);
  if (!addr) throw new PayError('invalid_address', 422, 'to');
  to = addr;
  if (kind === 'cashout' && !isRegisteredCashout(merchant, chain, to)) throw new PayError('address_not_registered', 422, 'to');
  if (!Number.isInteger(amount) || amount <= 0) throw new PayError('invalid_param', 422, 'amount');
  if (customerId !== null && !CUSTOMER_RE.test(customerId)) throw new PayError('invalid_param', 422, 'customer_id');
  merchantRef = normMerchantRef(merchantRef);
  const fee = calcFee(amount, merchant.fee_out);
  return withRefGuard(db, merchant.id, [merchantRef], () => db.tx(async (t) => {
    await assertNoDebt(t, merchant.id, true);
    if (merchantRef) await assertRefFree(t, merchant.id, merchantRef);
    if (customerId && kind === 'payout') await ensureCustomer(t, merchant.id, customerId);
    const id = newId.withdrawal();
    await post(t, merchant.id, 'freeze', -(amount + fee), amount + fee, id, customerId);
    await t.query(`insert into withdrawals (id, merchant_id, kind, customer_id, to_address, amount, fee, source, status, merchant_ref, chain) values ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10)`,
      [id, merchant.id, kind, kind === 'payout' ? customerId : null, to, amount, fee, source, merchantRef, chain]);
    await wdCallback(t, id);
    return withdrawalView(t, id);
  }));
}

// ---------- 提现单号（merchant_ref）：同一商户永久唯一（单笔、后台、批量每一行一起算，任何状态都算） ----------
export const MERCHANT_REF_MAX = 64;
/** 规范化：去掉首尾空格；没填、空串、只有空格是 null（不算单号）；超过 64 字、不是字符串或数字 422 invalid_param（不截断） */
export function normMerchantRef(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' && typeof v !== 'number') throw new PayError('invalid_param', 422, 'merchant_ref');
  const ref = String(v).trim();
  if (!ref) return null;
  if (ref.length > MERCHANT_REF_MAX) throw new PayError('invalid_param', 422, 'merchant_ref');
  return ref;
}
/** 409 duplicate_merchant_ref，带原来那笔的提现号 */
export function duplicateRefError(withdrawalNo) {
  return Object.assign(new PayError('duplicate_merchant_ref', 409, 'merchant_ref'), { withdrawal_no: withdrawalNo });
}
/** 已用过这个单号的提现号（没有是 null） */
export async function findByMerchantRef(q, merchantId, ref) {
  const [w] = await q.query(`select id from withdrawals where merchant_id = $1 and merchant_ref = $2 and merchant_ref <> ''`, [merchantId, ref]);
  return w ? w.id : null;
}
export async function assertRefFree(q, merchantId, ref) {
  const used = await findByMerchantRef(q, merchantId, ref);
  if (used) throw duplicateRefError(used);
}
const isRefConflict = (e) => e?.code === '23505' && /withdrawals_merchant_ref_unique/.test(`${e.constraint_name || ''} ${e.constraint || ''} ${e.message || ''} ${e.detail || ''}`);
/** 两个同号请求同时进来：数据库唯一索引拒绝后一笔，这里换成 409 并查出先成功的那笔 */
export async function withRefGuard(db, merchantId, refs, fn) {
  try { return await fn(); } catch (e) {
    if (!isRefConflict(e)) throw e;
    for (const ref of refs.filter(Boolean)) { const used = await findByMerchantRef(db, merchantId, ref); if (used) throw duplicateRefError(used); }
    throw duplicateRefError(null);
  }
}
// approved：审核通过、等凑批签名；signing：已凑进一批、等签名（对外都是 approved）
export const WD_PUBLIC = { pending: 'pending', approved: 'approved', signing: 'approved', broadcast: 'broadcast', completed: 'completed', rejected: 'rejected', cancelled: 'cancelled', failed: 'failed' };
export async function withdrawalView(q, id) {
  const [w] = await q.query('select * from withdrawals where id = $1', [id]);
  if (!w) return null;
  return { withdrawal_no: w.id, kind: w.kind, chain: w.chain || 'tron', batch_no: w.batch_ref || null, customer_id: w.customer_id, to: w.to_address, amount: w.amount, fee: w.fee, status: WD_PUBLIC[w.status], txid: w.txid, reason: w.reason, merchant_ref: w.merchant_ref, source: w.source, created_at: iso(w.created_at) };
}
export async function wdCallback(t, id) {
  const v = await withdrawalView(t, id);
  const [w] = await t.query('select merchant_id from withdrawals where id = $1', [id]);
  await enqueueCallback(t, w.merchant_id, 'withdrawal.updated', v);
}
/** 状态流转。from 是允许的原状态 */
export async function moveWithdrawal(t, id, from, to, extra = {}) {
  const [w] = await t.query(`update withdrawals set status = $3, reason = coalesce($4, reason), txid = coalesce($5, txid), batch_id = coalesce($6, batch_id), updated_at = now()
    where id = $1 and status = any($2::text[]) returning *`, [id, from, to, extra.reason ?? null, extra.txid ?? null, extra.batchId ?? null]);
  if (!w) throw new PayError('invalid_state', 409);
  return w;
}
export async function cancelWithdrawal(db, merchantId, id) {
  return db.tx(async (t) => {
    const [own] = await t.query('select batch_ref from withdrawals where id = $1 and merchant_id = $2', [id, merchantId]);
    if (!own) throw new PayError('not_found', 404);
    // 批量打款里的单不能单笔取消：只能整批取消还没审核的部分（payout-batch-cancel），2026-11-14 定
    if (own.batch_ref) throw new PayError('batch_item_cancel', 409, 'withdrawal_no');
    const w = await moveWithdrawal(t, id, ['pending'], 'cancelled');
    await post(t, w.merchant_id, 'unfreeze', w.amount + w.fee, -(w.amount + w.fee), id, w.customer_id);
    await wdCallback(t, id);
    return withdrawalView(t, id);
  });
}
export async function rejectWithdrawal(db, id, reason, actor) {
  if (!reason) throw new PayError('invalid_param', 422, 'reason');
  return db.tx(async (t) => {
    const w = await moveWithdrawal(t, id, ['pending'], 'rejected', { reason: String(reason).slice(0, 500) });
    await post(t, w.merchant_id, 'unfreeze', w.amount + w.fee, -(w.amount + w.fee), id, w.customer_id);
    await audit(t, actor, 'withdrawal.reject', id, { reason });
    await wdCallback(t, id);
    return withdrawalView(t, id);
  });
}
/** 管理员批准并签名后：进入 signing（已批准），广播后进入 broadcast */
export async function markWithdrawal(db, id, to, extra = {}) {
  const from = { signing: ['pending', 'approved'], broadcast: ['signing'] }[to];
  if (!from) throw new Error('bad transition');
  return db.tx(async (t) => { await moveWithdrawal(t, id, from, to, extra); await wdCallback(t, id); return withdrawalView(t, id); });
}
/** 链上确认成功：从冻结里扣除金额和手续费；失败：解冻 */
export async function settleWithdrawal(db, id, success) {
  return db.tx(async (t) => {
    const w = await moveWithdrawal(t, id, ['broadcast', 'signing'], success ? 'completed' : 'failed');
    if (success) {
      await post(t, w.merchant_id, 'withdraw', 0, -w.amount, id, w.customer_id);
      if (w.fee) await post(t, w.merchant_id, 'fee_out', 0, -w.fee, id, w.customer_id);
    } else {
      await post(t, w.merchant_id, 'unfreeze', w.amount + w.fee, -(w.amount + w.fee), id, w.customer_id);
    }
    await wdCallback(t, id);
    return withdrawalView(t, id);
  });
}
