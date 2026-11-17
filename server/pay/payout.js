// 批量打款（第 3 批）的规则和记账：上限（后台可改）、凑批"三者取最小"和自动拆批、处理时段、逐笔审核、商户批量（上传表格 / 开放 API）、
// 按链凑批后的记账（ETH / BSC 一批一笔交易，失败整批回到已审核；TRON 逐笔记账，失败的回到已审核待签名）。
// 金额一律是 0.000001 USDT 为单位的整数（这里用 Number；单笔、每批都远小于 2^53）。链上交易的出具、签名核对、广播在 server/wallet/payout.js。
import { randomBytes } from 'node:crypto';
import { PayError, audit, getMeta, setMeta, ensureCustomer, post, wdCallback, withdrawalView, chainAddress, PAYOUT_CHAINS, CUSTOMER_RE } from './core.js';
import { calcFee, fmtUsdt, parseUsdt } from './money.js';

const U = 1_000_000;
/** 默认上限（技术方案 06 页）：单笔 5,000、每批 20,000、每天 30,000；热钱包上限 10,000、低于 2,000 提醒。管理员能在后台改（Q-B1） */
export const PAYOUT_DEFAULTS = Object.freeze({ perItem: 5_000 * U, perBatch: 20_000 * U, perDay: 30_000 * U, hotMax: 10_000 * U, hotLow: 2_000 * U });
export const LIMIT_KEYS = ['perItem', 'perBatch', 'perDay', 'hotMax', 'hotLow'];
/** 一张表 / 一次 API 最多 500 笔（Q-B6） */
export const MAX_ITEMS_PER_REQUEST = 500;
/** 一笔链上交易最多几笔：ETH / BSC 是 BatchPayout.MAX_ITEMS；TRON 每批 20 笔（Nile 实测后再调） */
export const MAX_ITEMS_PER_TX = Object.freeze({ eth: 100, bsc: 100, tron: 20 });
const META_LIMITS = 'payout_limits';
const TZ_MS = 8 * 3_600_000; // 东八区
const usdt = (u) => fmtUsdt(Number(u)).replace(/,/g, '');
const rid = (n = 4) => randomBytes(n).toString('hex').toUpperCase();
const ymd = (ms) => new Date(ms + TZ_MS).toISOString().slice(0, 10).replace(/-/g, '');
export const newBatchNo = (now = Date.now()) => `PB-${ymd(now)}-${rid(4)}`;
export const newTxBatchId = (chain, now = Date.now()) => `PT-${chain.toUpperCase()}-${ymd(now)}-${rid(3)}`;

// ---------- 上限（后台可改：原因 + 动态码 + 审计） ----------
export async function getPayoutLimits(q) {
  const saved = (await getMeta(q, META_LIMITS)) || {};
  return Object.fromEntries(LIMIT_KEYS.map((k) => [k, Number.isSafeInteger(Number(saved[k])) && Number(saved[k]) > 0 ? Number(saved[k]) : PAYOUT_DEFAULTS[k]]));
}
/** values：{ perItem, perBatch, perDay, hotMax, hotLow }（0.000001 单位，字符串或数字）；先核对动态码，再核对原因和数字 */
export async function updatePayoutLimits(db, { actor, reason, values = {}, code, verifyCode }) {
  if (!verifyCode || !(await verifyCode(String(code || '')))) throw new PayError('bad_code', 400);
  if (!String(reason || '').trim()) throw new PayError('reason_required', 422, 'reason');
  const before = await getPayoutLimits(db);
  const next = { ...before };
  for (const k of LIMIT_KEYS) {
    if (values[k] === undefined) continue;
    const v = typeof values[k] === 'number' ? values[k] : /^\d{1,16}$/.test(String(values[k])) ? Number(values[k]) : NaN;
    if (!Number.isSafeInteger(v) || v <= 0) throw new PayError('invalid_param', 422, k);
    next[k] = v;
  }
  // 哪条约束不满足写在 rows[0].rule（页面据此说清楚）
  const rule = (field, r) => Object.assign(new PayError('invalid_param', 422, field), { rows: [{ rule: r }] });
  if (next.perItem > next.perBatch) throw rule('perItem', 'per_item_le_per_batch');
  if (next.perBatch > next.perDay) throw rule('perBatch', 'per_batch_le_per_day');
  if (next.hotLow > next.hotMax) throw rule('hotLow', 'hot_low_le_hot_max');
  const toUsdt = (o) => Object.fromEntries(LIMIT_KEYS.map((k) => [k, usdt(o[k])]));
  await db.tx(async (t) => {
    await setMeta(t, META_LIMITS, next);
    await audit(t, actor, 'payout.limits', '', { reason: String(reason).trim().slice(0, 500), before: toUsdt(before), after: toUsdt(next) });
  });
  return next;
}

// ---------- 凑批 ----------
/** Q-B1：每批实际上限 = min(每批上限, 热钱包余额, 授权额度)；allowance 为 null（TRON 不用授权）时只比前两个。一样大时先报热钱包余额 */
export function effectiveBatchCap({ perBatch, hotBalance, allowance = null }) {
  const cands = [['hot_balance', BigInt(hotBalance)], ...(allowance === null || allowance === undefined ? [] : [['allowance', BigInt(allowance)]]), ['per_batch', BigInt(perBatch)]];
  let best = cands[0];
  for (const c of cands) if (c[1] < best[1]) best = c;
  return { cap: best[1], by: best[0] };
}

/**
 * 按审核通过的先后装批：一批合计不超过 cap、笔数不超过 MAX_ITEMS_PER_TX[chain]，装不下就开下一批；
 * 这一轮的总额不超过热钱包余额和授权额度（不够的留到下一轮）；单笔超单笔上限、超 cap 的不拆，放进 held。
 */
export function planPayoutBatches(items, { chain, perBatch, hotBalance, allowance = null, perItem }) {
  const { cap, by } = effectiveBatchCap({ perBatch, hotBalance, allowance });
  const maxN = MAX_ITEMS_PER_TX[chain];
  if (!maxN) throw new PayError('invalid_param', 422, 'chain');
  const hot = BigInt(hotBalance), al = allowance === null || allowance === undefined ? null : BigInt(allowance);
  const batches = [], held = [];
  let used = 0n, cur = null;
  for (const it of items) {
    const a = BigInt(it.amount);
    if (a > BigInt(perItem)) { held.push({ id: it.id, reason: 'exceeds_per_item_limit' }); continue; }
    if (a > cap) { held.push({ id: it.id, reason: a > hot ? 'exceeds_hot_balance' : al !== null && a > al ? 'exceeds_allowance' : 'exceeds_batch_cap' }); continue; }
    if (used + a > hot) { held.push({ id: it.id, reason: 'exceeds_hot_balance' }); continue; }
    if (al !== null && used + a > al) { held.push({ id: it.id, reason: 'exceeds_allowance' }); continue; }
    if (!cur || cur.total + a > cap || cur.items.length >= maxN) { cur = { items: [], total: 0n }; batches.push(cur); }
    cur.items.push(it);
    cur.total += a;
    used += a;
  }
  return { cap, by, batches, held };
}

// ---------- 处理时段（TU-6、Q-B7）：东八区 8:00（含）～ 23:00（不含） ----------
export function serviceWindow(nowMs = Date.now()) {
  const local = new Date(nowMs + TZ_MS);
  const h = local.getUTCHours();
  if (h >= 8 && h < 23) return { open: true };
  const day0 = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()); // 东八区当天 8:00 = UTC 0:00
  return { open: false, next_open_at: new Date(h < 8 ? day0 : day0 + 86_400_000).toISOString() };
}
/** 东八区今天 0 点（毫秒） */
export const dayStart = (nowMs = Date.now()) => { const l = new Date(nowMs + TZ_MS); return Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate()) - TZ_MS; };

// ---------- 审核 ----------
async function approvedToday(t, nowMs) {
  const [r] = await t.query(`select coalesce(sum(amount), 0)::bigint v from withdrawals where approved_at >= $1 and status in ('approved', 'signing', 'broadcast', 'completed')`, [new Date(dayStart(nowMs))]);
  return Number(r.v);
}
/** 审核一笔（在事务里）：超单笔上限、超当天上限的留在 pending；返回 null 表示通过，否则是原因 */
async function approveOne(t, id, { actor, now, limits, today }) {
  const [w] = await t.query(`select * from withdrawals where id = $1 for update`, [id]);
  if (!w) return 'not_found';
  if (w.status !== 'pending') return 'invalid_state';
  if (w.amount > limits.perItem) return 'exceeds_per_item_limit';
  if (today.v + w.amount > limits.perDay) return 'exceeds_daily_limit';
  await t.query(`update withdrawals set status = 'approved', approved_at = $2, approved_by = $3, updated_at = now() where id = $1`, [id, new Date(now), actor]);
  today.v += w.amount;
  await audit(t, actor, 'payout.approve', id, { amount: usdt(w.amount), chain: w.chain });
  await wdCallback(t, id);
  return null;
}
/** 审核要按"每天上限"算今天已通过的合计：两个审核同时进来会各算各的、合起来超上限，所以事务里先拿一把审核锁（事务结束自动释放） */
const APPROVE_LOCK = 7_310_331; // pg_advisory_xact_lock 的键，只给打款审核用
async function lockApprovals(t) { await t.query('select pg_advisory_xact_lock($1)', [APPROVE_LOCK]); }

/** Q-B3 单笔一单一审：pending → approved；超单笔上限 exceeds_per_item_limit、超每天上限 exceeds_daily_limit 的留在 pending */
export async function approvePayouts(db, { ids = [], actor, now = Date.now() }) {
  const list = [...new Set(ids.map(String))];
  if (!list.length || list.length > MAX_ITEMS_PER_REQUEST) throw new PayError('invalid_param', 422, 'ids');
  return db.tx(async (t) => {
    await lockApprovals(t);
    const limits = await getPayoutLimits(t);
    const today = { v: await approvedToday(t, now) };
    const approved = [], refused = [];
    for (const id of list) {
      const why = await approveOne(t, id, { actor, now, limits, today });
      if (why) refused.push({ id, reason: why }); else approved.push(id);
    }
    return { approved, refused };
  });
}
async function rejectOne(t, id, reason, actor, action = 'withdrawal.reject') {
  const [w] = await t.query(`update withdrawals set status = 'rejected', reason = $2, updated_at = now() where id = $1 and status = 'pending' returning *`, [id, reason]);
  if (!w) throw new PayError('invalid_state', 409);
  await post(t, w.merchant_id, 'unfreeze', w.amount + w.fee, -(w.amount + w.fee), id, w.customer_id);
  await audit(t, actor, action, id, { reason });
  await wdCallback(t, id);
}

/**
 * 已审核、还没凑进批次的单驳回（例如挂起的、收款地址转不了的）：退冻结、回调、记审计；原因必填（商户能看到）。
 * 已经凑进批次（signing / broadcast）的不能驳回：先作废那一批（没签名的），或等链上结果。
 */
export async function rejectApprovedPayout(db, { id, reason, actor }) {
  const why = String(reason || '').trim();
  if (!why) throw new PayError('reason_required', 422, 'reason');
  return db.tx(async (t) => {
    const [w] = await t.query(`update withdrawals set status = 'rejected', reason = $2, hold_reason = null, updated_at = now() where id = $1 and status = 'approved' and batch_id is null returning *`, [String(id || ''), why.slice(0, 500)]);
    if (!w) throw new PayError('invalid_state', 409);
    await post(t, w.merchant_id, 'unfreeze', w.amount + w.fee, -(w.amount + w.fee), w.id, w.customer_id);
    await audit(t, actor, 'payout.reject_approved', w.id, { reason: why.slice(0, 500), amount: usdt(w.amount), chain: w.chain, hold: w.hold_reason || null });
    await wdCallback(t, w.id);
    return withdrawalView(t, w.id);
  });
}
/** 挂起一笔已审核的单（收款地址转不了）：状态不变（对外仍是已审核），不再进批，等管理员驳回 */
export async function holdPayout(db, id, reason, actor = 'system') {
  const [w] = await db.query(`update withdrawals set hold_reason = $2, updated_at = now() where id = $1 and status in ('approved', 'signing', 'broadcast') returning id, chain, amount`, [String(id), String(reason).slice(0, 60)]);
  if (w) await audit(db, actor, 'payout.hold', w.id, { reason, chain: w.chain, amount: usdt(w.amount) });
  return Boolean(w);
}

/** 解除挂起（管理员确认收款地址没问题，例如代币已解除拉黑）：回到普通的已审核，下一轮照常凑批；记审计 */
export async function unholdPayout(db, { id, actor }) {
  const [w] = await db.query(`update withdrawals set hold_reason = null, updated_at = now() where id = $1 and status = 'approved' and batch_id is null and hold_reason is not null returning id, chain, amount`, [String(id || '')]);
  if (!w) throw new PayError('invalid_state', 409);
  await audit(db, actor, 'payout.unhold', w.id, { chain: w.chain, amount: usdt(w.amount) });
  return { ok: true };
}

// ---------- 商户批量 ----------
/** 商户批次的对外状态：有还没审的 pending；全取消 cancelled；驳回的占了全部（不算取消） rejected；有驳回 partially_rejected；全部完成 completed；其余 approved */
function batchStatus(items) {
  const n = (s) => items.filter((x) => x.status === s).length;
  const total = items.length, cancelled = n('cancelled'), rejected = n('rejected');
  if (n('pending')) return 'pending';
  if (cancelled === total) return 'cancelled';
  if (rejected && rejected + cancelled === total) return 'rejected';
  if (rejected) return 'partially_rejected';
  if (n('completed') + cancelled === total) return 'completed';
  return 'approved';
}
export async function payoutBatchView(q, batchNo, merchantId = null) {
  const [b] = await q.query(`select * from payout_batches where batch_no = $1 ${merchantId ? 'and merchant_id = $2' : ''}`, merchantId ? [batchNo, merchantId] : [batchNo]);
  if (!b) return null;
  const rows = await q.query(`select id from withdrawals where batch_ref = $1 order by batch_line, created_at, id`, [batchNo]);
  const items = [];
  for (const r of rows) items.push(await withdrawalView(q, r.id));
  return { batch_no: b.batch_no, merchant_id: b.merchant_id, source: b.source, status: batchStatus(items), count: b.item_count, total: Number(b.total), created_at: new Date(b.created_at).toISOString(), items };
}
export async function listPayoutBatches(q, merchantId, limit = 50) {
  const rows = await q.query(`select batch_no from payout_batches where merchant_id = $1 order by created_at desc limit $2`, [merchantId, limit]);
  const out = [];
  for (const r of rows) { const v = await payoutBatchView(q, r.batch_no, merchantId); out.push({ batch_no: v.batch_no, status: v.status, count: v.count, total: v.total, created_at: v.created_at, source: v.source, done: v.items.filter((x) => x.status === 'completed').length }); }
  return out;
}

/** Q-B4 商户批量逐行勾选一次审完：approve 里的通过，其余还在 pending 的全部驳回（有驳回时原因必填） */
export async function reviewPayoutBatch(db, { batchNo, approve = [], reason = '', actor, now = Date.now() }) {
  const ok = new Set(approve.map(String));
  return db.tx(async (t) => {
    const [b] = await t.query('select batch_no from payout_batches where batch_no = $1', [String(batchNo || '')]);
    if (!b) throw new PayError('not_found', 404);
    await lockApprovals(t);
    const pend = await t.query(`select id from withdrawals where batch_ref = $1 and status = 'pending' order by batch_line, created_at, id for update`, [b.batch_no]);
    if (!pend.length) throw new PayError('invalid_state', 409);
    for (const id of ok) if (!pend.some((p) => p.id === id)) throw new PayError('invalid_param', 422, 'approve');
    const rejectIds = pend.map((p) => p.id).filter((id) => !ok.has(id));
    const why = String(reason || '').trim();
    if (rejectIds.length && !why) throw new PayError('reason_required', 422, 'reason');
    const limits = await getPayoutLimits(t);
    const today = { v: await approvedToday(t, now) };
    for (const p of pend) {
      if (!ok.has(p.id)) continue;
      const r = await approveOne(t, p.id, { actor, now, limits, today });
      // 有一笔超上限：整个审核不生效（事务回滚），页面提示先驳回这笔或先改上限
      if (r) throw Object.assign(new PayError(r, 409, 'approve'), { rows: [{ id: p.id, code: r }] });
    }
    for (const id of rejectIds) await rejectOne(t, id, why.slice(0, 500), actor, 'payout.reject');
    return payoutBatchView(t, b.batch_no);
  });
}

/** 逐行检查（表格第 2 步和提交时共用）：返回 { ok, errors, warnings, row（规范化后） } */
export function checkPayoutRows(rows, merchant) {
  const out = rows.map((r, i) => {
    const errors = [];
    const chain = PAYOUT_CHAINS.includes(r?.chain) ? r.chain : null;
    if (!chain) errors.push('unknown_chain');
    const to = chain ? chainAddress(chain, r.to) : null;
    if (chain && !to) errors.push('invalid_address');
    const raw = String(r?.amount ?? '').trim();
    const amount = /^\d{1,12}(\.\d{1,6})?$/.test(raw) ? parseUsdt(raw) : null;
    if (!amount) errors.push('invalid_amount');
    const cid = r?.customer_id ? String(r.customer_id).trim() : '';
    if (cid && !CUSTOMER_RE.test(cid)) errors.push('invalid_customer_id');
    const ref = r?.merchant_ref ? String(r.merchant_ref).trim() : '';
    if (ref.length > 64) errors.push('invalid_merchant_ref');
    const fee = amount ? calcFee(amount, merchant.fee_out) : 0;
    return { index: i, line: r?.line ?? i + 1, chain: chain || String(r?.chain ?? ''), to: to || String(r?.to ?? ''), amount: amount || 0, fee, customer_id: cid || null, merchant_ref: ref || null, errors, warnings: [], ok: !errors.length };
  });
  // 重复行（同链、同地址、同金额）：每一行都标警告，但不算有问题（原型偏离第 4 条）
  const seen = new Map();
  for (const r of out) if (r.ok) { const k = `${r.chain}|${r.to.toLowerCase()}|${r.amount}`; seen.set(k, (seen.get(k) || 0) + 1); }
  for (const r of out) if (r.ok && seen.get(`${r.chain}|${r.to.toLowerCase()}|${r.amount}`) > 1) r.warnings.push('duplicate_row');
  return out;
}
/** 按链汇总：{ <链>: { count, amount, fee, total } }（金额是 USDT 字符串，网络费不另收） */
export function totalsByChain(rows) {
  const t = {};
  for (const r of rows) {
    const x = t[r.chain] || (t[r.chain] = { count: 0, amount: 0, fee: 0 });
    x.count++; x.amount += r.amount; x.fee += r.fee;
  }
  return Object.fromEntries(Object.entries(t).map(([c, x]) => [c, { count: x.count, amount: fmtUsdt(x.amount).replace(/,/g, ''), fee: fmtUsdt(x.fee).replace(/,/g, ''), total: fmtUsdt(x.amount + x.fee).replace(/,/g, '') }]));
}

/**
 * 商户提交一批（上传表格第 3 步、开放 API）：最多 500 行；有问题的行默认整张不收（invalid_rows，e.rows 列出 line、index、code），
 * onlyValid 时只收没问题的；一次冻结 sum(金额 + 付款手续费)；每笔一条 withdrawals（kind payout、batch_ref = 批次号、pending）。
 * 不在处理时段照样通知管理员（notify），返回 service.next_open_at。
 */
export async function submitPayoutBatch(db, merchant, { rows = [], source = 'web', onlyValid = false, now = Date.now(), notify = null, batchNo = null }) {
  if (!Array.isArray(rows) || !rows.length) throw new PayError('invalid_param', 422, 'rows');
  if (rows.length > MAX_ITEMS_PER_REQUEST) throw new PayError('too_many_items', 422, 'rows');
  const checked = checkPayoutRows(rows, merchant);
  const bad = checked.filter((r) => !r.ok);
  if (bad.length && !onlyValid) throw Object.assign(new PayError('invalid_rows', 422, 'rows'), { rows: bad.map((r) => ({ index: r.index, line: r.line, code: r.errors[0], errors: r.errors })) });
  const good = checked.filter((r) => r.ok);
  if (!good.length) throw Object.assign(new PayError('invalid_rows', 422, 'rows'), { rows: bad.map((r) => ({ index: r.index, line: r.line, code: r.errors[0], errors: r.errors })) });
  const no = batchNo || newBatchNo(now);
  const sum = good.reduce((s, r) => s + r.amount + r.fee, 0);
  const accepted = await db.tx(async (t) => {
    await t.query('insert into payout_batches (batch_no, merchant_id, source, item_count, total) values ($1, $2, $3, $4, $5)', [no, merchant.id, source, good.length, good.reduce((s, r) => s + r.amount, 0)]);
    // 一次冻结整批（余额不够时数据库约束拒绝，整批不收）；之后逐笔解冻 / 扣除
    await post(t, merchant.id, 'freeze', -sum, sum, no, null);
    const out = [];
    let k = 0;
    for (const r of good) {
      if (r.customer_id) await ensureCustomer(t, merchant.id, r.customer_id);
      const id = `WD-${ymd(now)}-${rid(4)}${(k++).toString(36).toUpperCase()}`;
      await t.query(`insert into withdrawals (id, merchant_id, kind, customer_id, to_address, amount, fee, source, status, merchant_ref, chain, batch_ref, batch_line, created_at) values ($1, $2, 'payout', $3, $4, $5, $6, $7, 'pending', $8, $9, $10, $11, clock_timestamp())`,
        [id, merchant.id, r.customer_id, r.to, r.amount, r.fee, source, r.merchant_ref, r.chain, no, k]);
      out.push({ line: r.line, index: r.index, withdrawal_no: id, chain: r.chain, to: r.to, amount: r.amount, fee: r.fee, status: 'pending', merchant_ref: r.merchant_ref, warnings: r.warnings });
    }
    await audit(t, `merchant:${merchant.id}`, 'payout.batch_submit', no, { count: good.length, source });
    return out;
  });
  const service = serviceWindow(now);
  if (notify) {
    const lines = Object.entries(totalsByChain(good)).map(([c, x]) => `- ${c.toUpperCase()}：${x.count} 笔，合计 ${x.amount} USDT`);
    try {
      await notify({ batch_no: no, merchant: merchant.name, count: good.length, service, text: lines.join('\n') });
      await db.query('update withdrawals set notified = true where batch_ref = $1', [no]);
    } catch (e) { console.error(`[payout] notify: ${e.message}`); }
  }
  return { batch_no: no, accepted, rejected_rows: bad.map((r) => ({ line: r.line, index: r.index, code: r.errors[0], errors: r.errors })), totals: totalsByChain(good), service };
}

/** 原型偏离第 6 条：商户取消还没审核的（pending），退冻结、逐笔回调；已审核的不动 */
export async function cancelPayoutBatch(db, merchantId, batchNo) {
  return db.tx(async (t) => {
    const [b] = await t.query('select batch_no from payout_batches where batch_no = $1 and merchant_id = $2', [String(batchNo || ''), merchantId]);
    if (!b) throw new PayError('not_found', 404);
    const rows = await t.query(`select id, status from withdrawals where batch_ref = $1 for update`, [b.batch_no]);
    let cancelled = 0;
    for (const r of rows.filter((x) => x.status === 'pending')) {
      const [w] = await t.query(`update withdrawals set status = 'cancelled', updated_at = now() where id = $1 and status = 'pending' returning *`, [r.id]);
      await post(t, w.merchant_id, 'unfreeze', w.amount + w.fee, -(w.amount + w.fee), w.id, w.customer_id);
      await wdCallback(t, w.id);
      cancelled++;
    }
    const kept = rows.filter((x) => !['pending', 'cancelled', 'rejected'].includes(x.status)).length;
    return { cancelled, kept };
  });
}

// ---------- 按链凑批后的记账 ----------
/** 已审核（approved、不在任何批次里）的单 → 一个打款交易批次；单状态 approved → signing（对外仍是 approved） */
export async function createPayoutTxBatch(db, { chain, ids, actor = 'system', id = null, total = null, extra = {} }) {
  if (!PAYOUT_CHAINS.includes(chain)) throw new PayError('invalid_param', 422, 'chain');
  const list = [...new Set((ids || []).map(String))];
  if (!list.length || list.length > MAX_ITEMS_PER_TX[chain]) throw new PayError('invalid_param', 422, 'ids');
  return db.tx(async (t) => {
    const rows = await t.query(`select id, chain, status, batch_id, amount, hold_reason from withdrawals where id = any($1::text[]) for update`, [list]);
    if (rows.length !== list.length) throw new PayError('not_found', 404);
    if (rows.some((r) => r.chain !== chain)) throw new PayError('chain_mismatch', 422, 'ids');
    if (rows.some((r) => r.status !== 'approved' || r.batch_id || r.hold_reason)) throw new PayError('invalid_state', 409);
    const bid = id || newTxBatchId(chain);
    const sum = total ?? rows.reduce((s, r) => s + Number(r.amount), 0);
    await t.query(`insert into payout_tx_batches (id, chain, status, item_ids, total, batch_hex, raw_hex, expect, created_by, nonce) values ($1, $2, 'planned', $3::jsonb, $4, $5, $6, $7::jsonb, $8, $9)`,
      [bid, chain, JSON.stringify(list), sum, extra.batchHex || null, extra.rawHex || null, extra.expect ? JSON.stringify(extra.expect) : null, actor, extra.nonce ?? null]);
    await t.query(`update withdrawals set status = 'signing', batch_id = $2, updated_at = now() where id = any($1::text[])`, [list, bid]);
    return bid;
  });
}
/** 一笔完成：冻结里扣金额和手续费、回调 */
async function completeOne(t, id, txid) {
  const [w] = await t.query(`update withdrawals set status = 'completed', txid = coalesce($2, txid), updated_at = now() where id = $1 and status in ('signing', 'broadcast') returning *`, [id, txid ?? null]);
  if (!w) throw new PayError('invalid_state', 409);
  await post(t, w.merchant_id, 'withdraw', 0, -w.amount, id, w.customer_id);
  if (w.fee) await post(t, w.merchant_id, 'fee_out', 0, -w.fee, id, w.customer_id);
  await wdCallback(t, id);
}
/** 一笔退回已审核（可以重新凑批）：冻结、账本都不动 */
async function backToApproved(t, id, reason = null) {
  await t.query(`update withdrawals set status = 'approved', batch_id = null, txid = null, tx_expires_at = null, gone_suspect_at = null, reason = coalesce($2, reason), updated_at = now() where id = $1 and status in ('signing', 'broadcast')`, [id, reason]);
}
/** ETH / BSC：一批一笔交易。成功每笔 completed；失败整批回到 approved（批次 failed） */
export async function settlePayoutBatch(db, id, { success, txid = null, error = null }) {
  return db.tx(async (t) => {
    const [b] = await t.query(`select * from payout_tx_batches where id = $1 for update`, [String(id)]);
    if (!b) throw new PayError('not_found', 404);
    if (!['planned', 'broadcast'].includes(b.status)) throw new PayError('invalid_state', 409);
    for (const wid of b.item_ids) {
      if (success) await completeOne(t, wid, txid || b.tx_hash);
      else await backToApproved(t, wid);
    }
    await t.query(`update payout_tx_batches set status = $2, tx_hash = coalesce($3, tx_hash), error = $4, updated_at = now() where id = $1`, [b.id, success ? 'confirmed' : 'failed', txid, success ? null : error || 'reverted']);
    return { id: b.id, status: success ? 'confirmed' : 'failed', count: b.item_ids.length };
  });
}
/** 没签名就作废的批次（页面关了、重新凑批）：单回到 approved */
export async function expirePayoutBatch(db, id) {
  return db.tx(async (t) => {
    const [b] = await t.query(`update payout_tx_batches set status = 'expired', updated_at = now() where id = $1 and status = 'planned' returning *`, [String(id)]);
    if (!b) return false;
    for (const wid of b.item_ids) await backToApproved(t, wid);
    return true;
  });
}
/** TRON 逐笔（Q-B2）：成功照记；失败回到已审核待签名（冻结不动）。全部有结果后批次 confirmed / partial / failed */
export async function settlePayoutItem(db, withdrawalId, { success, txid = null, reason = null }) {
  return db.tx(async (t) => {
    const [w] = await t.query(`select id, batch_id, status from withdrawals where id = $1 for update`, [String(withdrawalId)]);
    if (!w) throw new PayError('not_found', 404);
    if (!['signing', 'broadcast'].includes(w.status)) throw new PayError('invalid_state', 409);
    if (success) await completeOne(t, w.id, txid);
    else await backToApproved(t, w.id, reason);
    if (w.batch_id) {
      const [b] = await t.query(`select * from payout_tx_batches where id = $1 for update`, [w.batch_id]);
      if (b) {
        const res = { ...(b.expect?.results || {}), [w.id]: { ok: Boolean(success), txid, reason } };
        const done = b.item_ids.every((x) => res[x]);
        const okN = b.item_ids.filter((x) => res[x]?.ok).length;
        const status = !done ? b.status : okN === b.item_ids.length ? 'confirmed' : okN ? 'partial' : 'failed';
        await t.query(`update payout_tx_batches set expect = $2::jsonb, status = $3, updated_at = now() where id = $1`, [b.id, JSON.stringify({ ...(b.expect || {}), results: res }), status]);
      }
    }
    return withdrawalView(t, w.id);
  });
}

// ---------- 表格 ----------
const CHAIN_ALIAS = { eth: 'eth', ethereum: 'eth', erc20: 'eth', '以太坊': 'eth', bsc: 'bsc', bep20: 'bsc', bnb: 'bsc', tron: 'tron', trc20: 'tron', trx: 'tron' };
/** 链名别名 → eth / bsc / tron；认不出的原样留着（逐行检查报 unknown_chain） */
export const chainOf = (s) => CHAIN_ALIAS[String(s ?? '').trim().toLowerCase()] || String(s ?? '').trim();
/**
 * 商户上传的 CSV：第一行是表头 chain,to,amount,customer_id,merchant_ref（后两列可省，列的顺序按表头）；去掉 UTF-8 BOM；空行跳过；
 * line 是数据行的序号（从 1 起，不算表头）。不支持带引号的字段（地址、金额、编号里都没有逗号）
 */
export function parsePayoutSheet(text) {
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/);
  let head = null;
  const rows = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const cells = raw.split(',').map((x) => x.trim().replace(/^"(.*)"$/, '$1'));
    if (!head) {
      head = cells.map((x) => x.toLowerCase());
      if (!['chain', 'to', 'amount'].every((k) => head.includes(k))) throw new PayError('invalid_sheet', 422, 'csv');
      continue;
    }
    const get = (k) => { const i = head.indexOf(k); return i >= 0 ? cells[i] ?? '' : ''; };
    rows.push({ line: rows.length + 1, chain: chainOf(get('chain')), to: get('to'), amount: get('amount'), customer_id: get('customer_id') || '', merchant_ref: get('merchant_ref') || '' });
  }
  if (!head) throw new PayError('invalid_sheet', 422, 'csv');
  return { rows };
}
