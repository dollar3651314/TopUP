// 双向匹配规则的单元测试
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchOnDeposit, matchOnCreate, manualMatch, unmatch, stateOf } from '../server/pay/matching.js';

const U = 1_000_000;
const NOW = Date.parse('2026-09-29T10:00:00Z');
const iso = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString();
const order = (id, amount, minAgo = 5, ttl = 30, customer = 'c1') => ({ id, customer, amount, matched: 0, createdAt: iso(minAgo), expiresAt: iso(minAgo - ttl), status: 'pending', low: 900_000, high: 1_100_000 });
const dep = (id, amount, minAgo = 1, customer = 'c1') => ({ id, customer, amount, time: iso(minAgo), credited: true, orderId: null });

test('累计正好等于下限 L 为已完成，少 1 个最小单位为部分付款', () => {
  const o = order('o1', 100 * U);
  matchOnDeposit(dep('d1', 90 * U - 1), [o], NOW);
  assert.equal(o.status, 'partial');
  matchOnDeposit(dep('d2', 1), [o], NOW);
  assert.equal(o.matched, 90 * U);
  assert.equal(o.status, 'completed');
});

test('累计正好等于上限 H 为已完成，多 1 个最小单位为超额付款', () => {
  const a = order('a', 100 * U); matchOnDeposit(dep('d', 110 * U), [a], NOW); assert.equal(a.status, 'completed');
  const b = order('b', 100 * U); matchOnDeposit(dep('d', 110 * U + 1), [b], NOW); assert.equal(b.status, 'overpaid');
});

test('多笔到账累计，已完成的订单不再接收新的到账', () => {
  const o = order('o', 100 * U);
  const d1 = dep('d1', 50 * U), d2 = dep('d2', 45 * U), d3 = dep('d3', 10 * U);
  matchOnDeposit(d1, [o], NOW); matchOnDeposit(d2, [o], NOW);
  assert.equal(o.status, 'completed');
  assert.equal(matchOnDeposit(d3, [o], NOW), null);
  assert.equal(d3.orderId, null);
});

test('多个未完成订单：优先选加上这笔后落在 L 到 H 之间的，否则选最早创建的', () => {
  const early = order('early', 500 * U, 20), later = order('later', 100 * U, 10);
  const d = dep('d', 100 * U);
  assert.equal(matchOnDeposit(d, [later, early], NOW).id, 'later');
  const e2 = order('e2', 500 * U, 20), l2 = order('l2', 300 * U, 10);
  assert.equal(matchOnDeposit(dep('x', 50 * U), [l2, e2], NOW).id, 'e2');
});

test('只匹配同一个客户，不匹配已过期的订单', () => {
  const other = order('other', 100 * U, 5, 30, 'c2');
  assert.equal(matchOnDeposit(dep('d', 100 * U), [other], NOW), null);
  const expired = order('exp', 100 * U, 60, 30);
  assert.equal(matchOnDeposit(dep('d2', 100 * U), [expired], NOW), null);
});

test('先到账后建订单：只在回看时间内匹配，累计超过 H 时一笔都不匹配', () => {
  const o = order('o', 100 * U, 0);
  const old = dep('old', 100 * U, 25 * 60), fresh = dep('fresh', 95 * U, 60);
  assert.deepEqual(matchOnCreate(o, [old, fresh], 24).map((d) => d.id), ['fresh']);
  assert.equal(old.orderId, null);
  assert.equal(o.status, 'completed');
  const o2 = order('o2', 100 * U, 0);
  const big = dep('big', 300 * U, 10);
  assert.deepEqual(matchOnCreate(o2, [big], 24), []);
  assert.equal(big.orderId, null);
  assert.equal(o2.status, 'pending');
});

test('回看时间为 0 时不做先到账后建单的匹配', () => {
  const o = order('o', 100 * U, 0);
  assert.deepEqual(matchOnCreate(o, [dep('d', 100 * U, 5)], 0), []);
});

test('已经匹配过的到账不会被第二个订单使用（不重复匹配）', () => {
  const d = dep('d', 100 * U, 5);
  const o1 = order('o1', 100 * U, 0), o2 = order('o2', 100 * U, 0);
  assert.equal(matchOnCreate(o1, [d], 24).length, 1);
  assert.equal(matchOnCreate(o2, [d], 24).length, 0);
  assert.equal(matchOnDeposit(d, [o2], NOW), null);
});

test('手动匹配只允许同一个客户；解除匹配后重新计算状态', () => {
  const o = order('o', 100 * U, 60, 30); // 已过期
  const mine = dep('m', 50 * U, 10), theirs = dep('t', 50 * U, 10, 'c2');
  assert.equal(manualMatch(o, theirs, NOW), false);
  assert.equal(manualMatch(o, mine, NOW), true);
  assert.equal(o.status, 'expired_partial');
  assert.equal(unmatch(o, mine, NOW), true);
  assert.equal(o.matched, 0);
  assert.equal(o.status, 'expired');
  assert.equal(mine.orderId, null);
});

test('到了过期时间还没达到 L：累计为 0 为已过期，大于 0 为部分付款（已过期）', () => {
  const o = order('o', 100 * U, 40, 30);
  assert.equal(stateOf(o, NOW), 'expired');
  o.matched = 10 * U;
  assert.equal(stateOf(o, NOW), 'expired_partial');
});
