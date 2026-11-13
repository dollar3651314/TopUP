// 开放 API：签名、时间戳、Idempotency-Key、IP 白名单、商户隔离，以及主要接口
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { createTestDb } from '../server/pay/db.js';
import { migrate } from '../server/pay/schema.js';
import * as core from '../server/pay/core.js';
import { createOps } from '../server/pay/ops.js';
import { createApiV1, createRateLimiter, signRequest, canonicalPath } from '../server/pay/api-v1.js';
import { createMemRedis } from '../server/kyb/memredis.js';
import { derivePayKeys, emailHash } from '../server/pay/common.js';
import { backfillEmailHash } from '../server/pay/schema.js';
import { encryptJson, decryptJson } from '../server/kyb/crypto.js';

const U = 1_000_000;
const XPUB = HDKey.fromMasterSeed(mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')).derive("m/44'/195'/0'").publicExtendedKey;
const HOT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const keys = derivePayKeys('test-app-secret-test-app-secret-0123456789');

async function setup({ redis } = {}) {
  const db = await createTestDb(); await migrate(db);
  await core.setMeta(db, 'xpub', XPUB);
  const ops = createOps({ db, keys, payBase: 'https://pay.test' });
  const mk = async (id) => { const m = await core.createMerchant(db, { id, name: id, feeIn: { ppm: 10_000, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 2 * U, min: 0 } }); return { m, cred: await ops.regenerateSecret(m) }; };
  const a = await mk('ma'), b = await mk('mb');
  let ip = '203.0.113.10';
  // 传入 redis 时，两个 API 实例（相当于两个函数实例）共享同一个 Redis
  const api = createApiV1({ db, keys, ops, getIp: () => ip, redis });
  const api2 = createApiV1({ db, keys, ops, getIp: () => ip, redis });
  const call = async (cred, method, path, body, { ts = Math.floor(Date.now() / 1000), sig, idem = randomUUID(), url, instance = api } = {}) => {
    const raw = body ? JSON.stringify(body) : '';
    const full = url || `https://api.test/api/v1/${path}`;
    const s = sig ?? signRequest(cred.api_secret, String(ts), method, canonicalPath(full), raw);
    const res = await instance(new Request(full, { method, body: raw || undefined, headers: { 'content-type': 'application/json', 'x-topup-key': cred.api_key, 'x-topup-timestamp': String(ts), 'x-topup-signature': s, ...(method === 'POST' ? { 'idempotency-key': idem } : {}) } }));
    return { status: res.status, body: await res.json() };
  };
  return { db, ops, a, b, call, api2, setIp: (v) => (ip = v) };
}

test('签名：没有签名、签名错误、时间戳过期都返回 401', async () => {
  const { a, call } = await setup();
  assert.equal((await call(a.cred, 'GET', 'balance/', null, { sig: 'deadbeef' })).status, 401);
  assert.equal((await call(a.cred, 'GET', 'balance/', null, { ts: Math.floor(Date.now() / 1000) - 400 })).body.error.code, 'timestamp_expired');
  const ok = await call(a.cred, 'GET', 'balance/');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { available: '0.00', frozen: '0.00', currency: 'USDT' });
  // 线上经过改写后的地址（/api/v1?p=balance/）和商户签名时的地址一致
  assert.equal(canonicalPath('https://x/api/v1?p=orders/&order_no=A'), '/api/v1/orders/?order_no=A');
  // trailingSlash 开启时，改写目标是 /api/v1/?p=...（没有结尾的 / 会 404）
  assert.equal(canonicalPath('https://x/api/v1/?p=orders/&order_no=A'), '/api/v1/orders/?order_no=A');
  assert.equal((await call(a.cred, 'GET', '', null, { url: 'https://api.test/api/v1?p=balance/' })).status, 200);
});

test('订单：客户必填；Idempotency-Key 重试返回同一个订单；POST 没有 Key 返回 400', async () => {
  const { a, call } = await setup();
  const bad = await call(a.cred, 'POST', 'orders/', { merchant_order_no: 'A1', amount: '10' });
  assert.equal(bad.body.error.field, 'customer_id');
  const idem = randomUUID();
  const body = { customer_id: 'user_1', merchant_order_no: 'A1', amount: '100.5' };
  const r1 = await call(a.cred, 'POST', 'orders/', body, { idem });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.amount, '100.50');
  assert.match(r1.body.pay_url, /^https:\/\/pay\.test\/pay\/ORD-/);
  const r2 = await call(a.cred, 'POST', 'orders/', body, { idem });
  assert.equal(r2.body.order_no, r1.body.order_no);
  assert.equal((await call(a.cred, 'POST', 'orders/', { ...body, amount: '1' }, { idem })).body.error.code, 'idempotency_conflict');
  assert.equal((await call(a.cred, 'POST', 'orders/', { ...body }, {})).body.error.code, 'duplicate_merchant_order_no');
  assert.equal((await call(a.cred, 'POST', 'orders/', body, { idem: '' })).status, 400);
  const got = await call(a.cred, 'GET', `orders/?order_no=${r1.body.order_no}`);
  assert.equal(got.body.customer_id, 'user_1');
});

test('商户隔离：A 的 Key 读不到、改不了 B 的订单、客户和提币', async () => {
  const { a, b, call } = await setup();
  const o = (await call(b.cred, 'POST', 'orders/', { customer_id: 'bob', merchant_order_no: 'B1', amount: '5' })).body;
  assert.equal((await call(a.cred, 'GET', `orders/?order_no=${o.order_no}`)).status, 404);
  assert.equal((await call(a.cred, 'GET', 'customers/?customer_id=bob')).status, 404);
  assert.equal((await call(a.cred, 'GET', 'customers/list/')).body.items.length, 0);
  assert.equal((await call(a.cred, 'POST', 'orders/match/', { order_no: o.order_no, deposit_id: '1' })).status, 404);
});

test('提币：没有 IP 白名单拒绝；白名单外的 IP 拒绝；余额不够拒绝', async () => {
  const { db, ops, a, call, setIp } = await setup();
  const c = await ops.upsertCustomer(a.m, { customer_id: 'u1' });
  await core.recordDeposit(db, { txid: 'f'.repeat(64), logIndex: 0, block: 1, to: c.address, amount: 100 * U, time: new Date() });
  const body = { kind: 'payout', to: HOT, amount: '10', customer_id: 'u1' };
  assert.equal((await call(a.cred, 'POST', 'withdrawals/', body)).body.error.code, 'ip_not_allowed');
  await ops.setIpWhitelist(a.m, ['203.0.113.10']);
  setIp('198.51.100.1');
  assert.equal((await call(a.cred, 'POST', 'withdrawals/', body)).status, 403);
  setIp('203.0.113.10');
  const w = await call(a.cred, 'POST', 'withdrawals/', body);
  assert.equal(w.status, 200);
  assert.equal(w.body.status, 'pending');
  assert.equal(w.body.fee, '2.00');
  assert.equal((await call(a.cred, 'POST', 'withdrawals/', { ...body, amount: '100' })).body.error.code, 'insufficient_balance');
  const cancel = await call(a.cred, 'POST', 'withdrawals/cancel/', { withdrawal_no: w.body.withdrawal_no });
  assert.equal(cancel.body.status, 'cancelled');
  assert.equal((await call(a.cred, 'GET', 'balance/')).body.available, '99.00');
});

test('客户统计、到账筛选、账本、未知接口', async () => {
  const { db, ops, a, call } = await setup();
  const c = await ops.upsertCustomer(a.m, { customer_id: 'u9', name: 'Nine', email: 'nine@example.com' });
  assert.equal((await call(a.cred, 'GET', 'customers/?customer_id=u9')).body.email, 'nine@example.com');
  const [row] = await db.query('select email_enc from customers where customer_id = $1', ['u9']);
  assert.ok(!row.email_enc.includes('nine@'), '邮箱加密保存');
  await core.recordDeposit(db, { txid: 'e'.repeat(64), logIndex: 0, block: 1, to: c.address, amount: 50 * U, time: new Date() });
  const st = (await call(a.cred, 'GET', 'customers/stats/?customer_id=u9')).body;
  assert.deepEqual([st.total, st.count, st.fees, st.unmatched], ['50.00', 1, '0.50', '50.00']);
  assert.equal((await call(a.cred, 'GET', 'deposits/?matched=false')).body.items.length, 1);
  assert.equal((await call(a.cred, 'GET', 'ledger/')).body.items.length, 2);
  assert.equal((await call(a.cred, 'GET', 'nope/')).status, 404);
});

test('http-rules.json：改写到接口的目标地址以 / 结尾（trailingSlash 开启时，没有 / 会 404）', async () => {
  const { readFile } = await import('node:fs/promises');
  const v = JSON.parse(await readFile(new URL('../server/http-rules.json', import.meta.url), 'utf8'));
  assert.equal(v.trailingSlash, true);
  for (const r of v.rewrites) assert.match(r.destination.split('?')[0], /\/$/, r.destination);
  // 改写到接口时不能用 :path* 这类命名参数：生成的正则不接受结尾的 /（所有接口地址都以 / 结尾），
  // 而且会把参数另外加进查询串，影响签名。用 (.*)
  const v1 = v.rewrites.find((r) => r.source.startsWith('/api/v1/'));
  assert.deepEqual(v1, { source: '/api/v1/(.*)', destination: '/api/v1/?p=$1' });
  for (const u of ['/api/v1/balance/', '/api/v1/orders/ORD-1/']) assert.match(u, /^\/api\/v1(?:\/(.*))$/);
});

test('客户搜索：按客户标识、名称、邮箱模糊搜索（邮箱加密保存，解密后比对），按地址精确搜索', async () => {
  const { a, call } = await setup();
  const c1 = (await call(a.cred, 'POST', 'customers/', { customer_id: 'user_101', name: 'Lin Trading', email: 'Lin@Example.com' })).body;
  await call(a.cred, 'POST', 'customers/', { customer_id: 'shop-9', name: 'Harbor', email: 'ops@harbor.test' });
  const ids = async (q) => (await call(a.cred, 'GET', `customers/list/?q=${encodeURIComponent(q)}`)).body.items.map((x) => x.customer_id).sort();
  assert.deepEqual(await ids('user_1'), ['user_101']);
  assert.deepEqual(await ids('trad'), ['user_101']);
  assert.deepEqual(await ids('lin@example'), ['user_101']); // 邮箱，不区分大小写
  assert.deepEqual(await ids('harbor.test'), ['shop-9']);
  assert.deepEqual(await ids(c1.address), ['user_101']);
  assert.deepEqual(await ids(c1.address.slice(0, 10)), []); // 地址只精确匹配
  assert.deepEqual(await ids(''), ['shop-9', 'user_101']);
});

// ---------- 集中限流 ----------
test('限流：两个实例共享 Redis 计数，同一个 Key 合计每秒超过 20 次返回 429；不同 Key 互不影响', async () => {
  const redis = createMemRedis();
  const { a, b, call, api2 } = await setup({ redis });
  // 固定在同一秒内发请求：等到下一秒刚开始
  await new Promise((r) => setTimeout(r, 1000 - (Date.now() % 1000) + 5));
  const res = [];
  for (let i = 0; i < 21; i++) res.push((await call(a.cred, 'GET', 'balance/', null, { instance: i % 2 ? api2 : undefined })).status);
  assert.deepEqual(res.slice(0, 20), Array(20).fill(200));
  assert.equal(res[20], 429);
  assert.equal((await call(b.cred, 'GET', 'balance/', null)).status, 200); // 另一个商户不受影响
  assert.ok(!JSON.stringify(redis.raw()).includes(a.cred.api_key), 'Redis 里不存 API Key 原文');
});

test('限流：Redis 出错或超时时放行并记录日志；下一秒重新计数', async () => {
  const logs = [];
  const log = { error: (m) => logs.push(m) };
  const broken = createRateLimiter({ redis: { incr: async () => { throw new Error('ECONNRESET'); }, expire: async () => 1 }, log });
  for (let i = 0; i < 30; i++) assert.equal(await broken('k', 1_000_000), true);
  assert.match(logs[0], /RATE_LIMIT_UNAVAILABLE ECONNRESET/);
  const slow = createRateLimiter({ redis: { incr: () => new Promise(() => {}), expire: async () => 1 }, log, timeoutMs: 20 });
  assert.equal(await slow('k', 1_000_000), true);
  assert.match(logs.at(-1), /timeout/);
  const ok = createRateLimiter({ redis: createMemRedis() });
  for (let i = 0; i < 20; i++) assert.equal(await ok('k', 5_000_000), true);
  assert.equal(await ok('k', 5_000_999), false);
  assert.equal(await ok('k', 5_001_000), true);
});

// ---------- 按邮箱哈希检索客户 ----------
test('邮箱检索：完整邮箱按哈希精确查找，客户超过 5000 个也能找到；表里没有明文邮箱；修改邮箱后旧邮箱查不到', async () => {
  const { db, a, call } = await setup();
  // 最早的客户，后面再造 6000 个，让它不在"最近 5000 个"里
  await call(a.cred, 'POST', 'customers/', { customer_id: 'first_one', name: 'First', email: 'First.Customer@Example.com' });
  await db.query(`insert into customers (merchant_id, customer_id, name, address, hd_index, created_at)
    select 'ma', 'bulk_' || i, 'Bulk', 'TBULK' || i, 100000 + i, now() + (i || ' milliseconds')::interval from generate_series(1, 6000) i`);
  const ids = async (q) => (await call(a.cred, 'GET', `customers/list/?q=${encodeURIComponent(q)}`)).body.items.map((x) => x.customer_id);
  assert.deepEqual(await ids('first.customer@example.com'), ['first_one']); // 不区分大小写
  assert.deepEqual(await ids('  FIRST.customer@example.COM '.trim()), ['first_one']);
  assert.deepEqual(await ids('first.customer@exam'), []); // 部分邮箱只在最近 5000 个里模糊匹配
  // 表里没有明文邮箱
  const dump = JSON.stringify(await db.query(`select * from customers where customer_id = 'first_one'`));
  assert.ok(!/first\.customer@example\.com/i.test(dump), '明文邮箱泄露');
  // 修改邮箱：新邮箱能找到，旧邮箱找不到；另一个商户用同一个邮箱查不到这个客户
  await call(a.cred, 'POST', 'customers/', { customer_id: 'first_one', email: 'new@example.com' });
  assert.deepEqual(await ids('new@example.com'), ['first_one']);
  assert.deepEqual(await ids('first.customer@example.com'), []);
});

test('邮箱检索：上线时给已有客户补算哈希（只执行一次）；创建订单时新建的客户也有哈希', async () => {
  const { db, a, b, call } = await setup();
  // 模拟 的旧数据：有加密邮箱，没有哈希
  await db.query(`insert into customers (merchant_id, customer_id, name, email_enc, address, hd_index) values ('ma', 'old_1', 'Old', $1, 'TOLD1', 900001), ('ma', 'old_bad', 'Bad', 'garbage', 'TOLD2', 900002)`, [encryptJson(keys.enc, 'old@example.com')]);
  const ids = async (cred, q) => (await call(cred, 'GET', `customers/list/?q=${encodeURIComponent(q)}`)).body.items.map((x) => x.customer_id);
  const [before] = await db.query(`select email_hash from customers where customer_id = 'old_1'`);
  assert.equal(before.email_hash, '');
  const deps = { decrypt: (x) => decryptJson(keys.enc, x), hash: (e) => emailHash(keys, e) };
  assert.equal(await backfillEmailHash(db, deps), 1); // 解密失败的行跳过
  const [after] = await db.query(`select email_hash from customers where customer_id = 'old_1'`);
  assert.equal(after.email_hash, emailHash(keys, 'OLD@example.com'));
  assert.equal(await backfillEmailHash(db, deps), 0); // 已经补过，不再执行
  assert.deepEqual(await ids(a.cred, 'old@example.com'), ['old_1']);
  assert.deepEqual(await ids(b.cred, 'old@example.com'), []); // 商户隔离
  const o = await call(a.cred, 'POST', 'orders/', { customer_id: 'via_order', customer_email: 'Buyer@Shop.test', merchant_order_no: 'L6-1', amount: '10' });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  assert.deepEqual(await ids(a.cred, 'buyer@shop.test'), ['via_order']);
  assert.notEqual(emailHash(keys, 'a@b.c'), emailHash(derivePayKeys('another-app-secret-another-app-secret-0123'), 'a@b.c')); // 和密钥相关
});
