// 到账和订单的双向匹配规则。纯函数，不读写数据库：
// 原型直接调用；正式版在服务器端的事务里（先锁住客户）调用同一套规则。
// 金额是整数（最小单位 0.000001 USDT），L 和 H 按百万分之一存（90% = 900000），全部整数比较。


const reachesLow = (sum, o) => BigInt(sum) * 1_000_000n >= BigInt(o.amount) * BigInt(o.low);
const exceedsHigh = (sum, o) => BigInt(sum) * 1_000_000n > BigInt(o.amount) * BigInt(o.high);
const isOpen = (o) => o.status === 'pending' || o.status === 'partial';

/** 按累计金额和是否过期计算订单状态 */
export function stateOf(o, now = Date.now()){
  if (reachesLow(o.matched, o)) return exceedsHigh(o.matched, o) ? 'overpaid' : 'completed';
  if (now >= Date.parse(o.expiresAt)) return o.matched > 0 ? 'expired_partial' : 'expired';
  return o.matched > 0 ? 'partial' : 'pending';
}

/**
 * 方向一：到账时。只在这个客户未过期、未完成的订单里选：
 * 优先选"加上这笔后累计落在 L 到 H 之间"的订单；都不满足时选最早创建的。返回匹配到的订单，没有则返回 null。
 */
export function matchOnDeposit(d, orders, now = Date.now()){
  if (!d.credited || d.orderId) return null;
  const open = orders.filter((o) => o.customer === d.customer && isOpen(o) && now < Date.parse(o.expiresAt))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (!open.length) return null;
  const fit = open.find((o) => reachesLow(o.matched + d.amount, o) && !exceedsHigh(o.matched + d.amount, o));
  const o = fit || open[0];
  o.matched += d.amount;
  o.status = stateOf(o, now);
  d.orderId = o.id; d.matchType = 'deposit';
  return o;
}

/**
 * 方向二：建订单时。取这个客户回看时间内的未匹配到账，从最早的开始累计；
 * 累计达到 L 时如果不超过 H，就把这些到账匹配给订单；否则一笔都不匹配。返回匹配到的到账。
 */
export function matchOnCreate(o, deposits, lookbackH){
  if (lookbackH <= 0) return [];
  const since = Date.parse(o.createdAt) - lookbackH * 3_600_000;
  const cands = deposits.filter((d) => d.customer === o.customer && d.credited && !d.orderId && Date.parse(d.time) >= since && Date.parse(d.time) <= Date.parse(o.createdAt))
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const picked = [];
  let sum = 0;
  for (const d of cands) {
    picked.push(d); sum += d.amount;
    if (reachesLow(sum, o)) break;
  }
  if (!reachesLow(sum, o) || exceedsHigh(sum, o)) return [];
  for (const d of picked) { d.orderId = o.id; d.matchType = 'order'; }
  o.matched = sum;
  o.status = stateOf(o);
  return picked;
}

/** 手动匹配：只允许同一个客户、还没匹配的到账 */
export function manualMatch(o, d, now = Date.now()){
  if (d.customer !== o.customer || d.orderId || !d.credited) return false;
  d.orderId = o.id; d.matchType = 'manual';
  o.matched += d.amount;
  o.status = stateOf(o, now);
  return true;
}

/** 解除匹配：到账回到"未匹配"，订单状态重新计算 */
export function unmatch(o, d, now = Date.now()){
  if (d.orderId !== o.id) return false;
  d.orderId = null; d.matchType = undefined;
  o.matched -= d.amount;
  o.status = stateOf(o, now);
  return true;
}
