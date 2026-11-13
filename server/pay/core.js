// 收付款核心服务：客户、订单、到账、匹配、余额、提币。
// 所有改动余额的操作都在一个事务里：先更新 balances（有 >= 0 约束），再追加一条账本记录。
// 同一个客户的匹配操作都先锁住这个客户的记录（SELECT … FOR UPDATE），到账和建单同时发生也不会重复匹配。
import { randomBytes } from 'node:crypto';
import { calcFee } from './money.js';
import { matchOnDeposit, matchOnCreate, manualMatch as ruleManual, unmatch as ruleUnmatch, stateOf } from './matching.js';
import { deriveAddress, isValidAddress } from './tron.js';

export const MIN_CREDIT = 1_000_000; // 低于 1 USDT 的到账不入账
export const CUSTOMER_RE = /^[A-Za-z0-9_.@-]{1,128}$/;
export const ORDER_NO_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OPEN = ['pending', 'partial'];

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
async function post(q, merchantId, type, dAvail, dFrozen, ref, customerId = null) {
  let b;
  try {
    [b] = await q.query('update balances set available = available + $2, frozen = frozen + $3 where merchant_id = $1 returning available, frozen', [merchantId, dAvail, dFrozen]);
  } catch (e) {
    if (/check constraint/i.test(e.message)) throw new PayError('insufficient_balance');
    throw e;
  }
  if (!b) throw new PayError('merchant_not_found', 404);
  await q.query('insert into ledger (merchant_id, type, amount, available_after, frozen_after, ref, customer_id) values ($1, $2, $3, $4, $5, $6, $7)',
    [merchantId, type, type === 'withdraw' || type === 'fee_out' ? dFrozen : dAvail, b.available, b.frozen, ref, customerId]);
  return b;
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
  for (const w of cashoutWallets) if (!isValidAddress(w)) throw new PayError('invalid_address', 422, 'cashout_wallets');
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
/** 取得客户；不存在时创建，并在同一个事务里推导一个新地址（序号加 1） */
export async function ensureCustomer(t, merchantId, customerId, { name = '', emailEnc = '', emailHash = '' } = {}) {
  if (!CUSTOMER_RE.test(customerId || '')) throw new PayError('invalid_param', 422, 'customer_id');
  const [found] = await t.query('select * from customers where merchant_id = $1 and customer_id = $2', [merchantId, customerId]);
  if (found) return found;
  const xpub = await getMeta(t, 'xpub');
  if (!xpub) throw new PayError('wallet_not_initialized', 503);
  const [n] = await t.query(`insert into pay_meta (key, value) values ('next_index', '1'::jsonb)
    on conflict (key) do update set value = to_jsonb((pay_meta.value)::text::int + 1), updated_at = now() returning value`);
  const index = Number(n.value) - 1;
  const address = deriveAddress(xpub, index);
  const [c] = await t.query(`insert into customers (merchant_id, customer_id, name, email_enc, email_hash, address, hd_index) values ($1, $2, $3, $4, $5, $6, $7)
    on conflict (merchant_id, customer_id) do nothing returning *`, [merchantId, customerId, String(name).slice(0, 200), emailEnc, emailHash, address, index]);
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

export async function createOrder(db, merchant, { customerId, customerName = '', customerEmailEnc = '', customerEmailHash = '', merchantOrderNo, amount }) {
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
      await t.query(`insert into orders (id, merchant_id, merchant_order_no, customer_id, amount, status, low, high, created_at, expires_at)
        values ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9)`,
        [id, merchant.id, merchantOrderNo, customerId, amount, mode.low, mode.high, now, new Date(now.getTime() + mode.ttlMin * 60_000)]);
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
 * 记一笔链上到账（已确认的 USDT 转账）。重复的转账（同一交易号 + 日志序号）自动忽略。
 * 返回 { status: 'ignored' | 'duplicate' | 'below_min' | 'credited', ... }
 */
export async function recordDeposit(db, { txid, logIndex, block, to, amount, time }) {
  return db.tx(async (t) => {
    const [c] = await t.query('select c.*, m.fee_in, m.order_mode from customers c join merchants m on m.id = c.merchant_id where c.address = $1', [to]);
    if (!c) return { status: 'ignored' };
    await lockCustomer(t, c.merchant_id, c.customer_id);
    const credited = amount >= MIN_CREDIT;
    // 手续费最多等于到账金额（最低收费大于到账金额时，不能让余额变成负数、整个扫链停住）
    const fee = credited ? Math.min(calcFee(amount, c.fee_in), amount) : 0;
    const [d] = await t.query(`insert into deposits (txid, log_index, block, address, merchant_id, customer_id, amount, fee, result, time)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict (txid, log_index) do nothing returning *`,
      [txid, logIndex, block, to, c.merchant_id, c.customer_id, amount, fee, credited ? 'credited' : 'below_min', new Date(time)]);
    if (!d) return { status: 'duplicate' };
    // 不论是否入账，钱都在这个地址上，归集时要算进去
    await t.query('update customers set onchain = onchain + $3 where merchant_id = $1 and customer_id = $2', [c.merchant_id, c.customer_id, amount]);
    if (!credited) {
      await t.query(`insert into anomalies (type, merchant_id, customer_id, address, amount, ref) values ('below_min', $1, $2, $3, $4, $5) on conflict do nothing`,
        [c.merchant_id, c.customer_id, to, `${amount / 1e6} USDT`, `${txid}:${logIndex}`]); // 同一笔交易里可能有几次转账
      return { status: 'below_min', deposit: d };
    }
    const ref = txid.slice(0, 16);
    await post(t, c.merchant_id, 'deposit', amount, 0, ref, c.customer_id);
    if (fee) await post(t, c.merchant_id, 'fee_in', -fee, 0, ref, c.customer_id);
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
      customer_id: c.customer_id, address: to, txid, amount, fee, credited: amount - fee, order_no: order ? order.id : null, time: new Date(time).toISOString(),
    });
    if (order) await orderCallback(t, c.merchant_id, order.id);
    return { status: 'credited', deposit: d, order: order ? order.id : null };
  });
}

// ---------- 提币 ----------
export async function requestWithdrawal(db, merchant, { kind, to, amount, customerId = null, source, merchantRef = null }) {
  if (!['payout', 'cashout'].includes(kind)) throw new PayError('invalid_param', 422, 'kind');
  if (!isValidAddress(to)) throw new PayError('invalid_address', 422, 'to');
  if (kind === 'cashout' && !merchant.cashout_wallets.includes(to)) throw new PayError('address_not_registered', 422, 'to');
  if (!Number.isInteger(amount) || amount <= 0) throw new PayError('invalid_param', 422, 'amount');
  if (customerId !== null && !CUSTOMER_RE.test(customerId)) throw new PayError('invalid_param', 422, 'customer_id');
  const fee = calcFee(amount, merchant.fee_out);
  return db.tx(async (t) => {
    if (customerId && kind === 'payout') await ensureCustomer(t, merchant.id, customerId);
    const id = newId.withdrawal();
    await post(t, merchant.id, 'freeze', -(amount + fee), amount + fee, id, customerId);
    await t.query(`insert into withdrawals (id, merchant_id, kind, customer_id, to_address, amount, fee, source, status, merchant_ref) values ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)`,
      [id, merchant.id, kind, kind === 'payout' ? customerId : null, to, amount, fee, source, merchantRef]);
    await wdCallback(t, id);
    return withdrawalView(t, id);
  });
}
const WD_PUBLIC = { pending: 'pending', signing: 'approved', broadcast: 'broadcast', completed: 'completed', rejected: 'rejected', cancelled: 'cancelled', failed: 'failed' };
export async function withdrawalView(q, id) {
  const [w] = await q.query('select * from withdrawals where id = $1', [id]);
  if (!w) return null;
  return { withdrawal_no: w.id, kind: w.kind, customer_id: w.customer_id, to: w.to_address, amount: w.amount, fee: w.fee, status: WD_PUBLIC[w.status], txid: w.txid, reason: w.reason, merchant_ref: w.merchant_ref, source: w.source, created_at: iso(w.created_at) };
}
async function wdCallback(t, id) {
  const v = await withdrawalView(t, id);
  const [w] = await t.query('select merchant_id from withdrawals where id = $1', [id]);
  await enqueueCallback(t, w.merchant_id, 'withdrawal.updated', v);
}
/** 状态流转。from 是允许的原状态 */
async function moveWithdrawal(t, id, from, to, extra = {}) {
  const [w] = await t.query(`update withdrawals set status = $3, reason = coalesce($4, reason), txid = coalesce($5, txid), batch_id = coalesce($6, batch_id), updated_at = now()
    where id = $1 and status = any($2::text[]) returning *`, [id, from, to, extra.reason ?? null, extra.txid ?? null, extra.batchId ?? null]);
  if (!w) throw new PayError('invalid_state', 409);
  return w;
}
export async function cancelWithdrawal(db, merchantId, id) {
  return db.tx(async (t) => {
    const [own] = await t.query('select 1 from withdrawals where id = $1 and merchant_id = $2', [id, merchantId]);
    if (!own) throw new PayError('not_found', 404);
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
  const from = { signing: ['pending'], broadcast: ['signing'] }[to];
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
