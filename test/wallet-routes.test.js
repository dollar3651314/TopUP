// 多链数据结构（chain、customer_addresses、wallet_routes）和"按链整体切换"的规则：
//   - 路由查找：这个商户这条链 → 这条链 → 全局默认 contract；第一版只开放按链切换
//   - 地址在创建时记下提供方；切换只影响新分配的地址；"更换地址"时旧地址停用，**一直**扫链、照常入账（不设期限），付款页和 API 只返回新地址
//   - 第 1 批不分配新的 TRON 地址（第 2 批 TRON 合约上线再开）；已有的 TRON 地址照常入账
//   - 切换要动态码、原因必填、记审计
//   - 旧地址里的钱继续由原提供方归集
//   - 到账按（链、地址）找客户：ETH 和 BSC 上同一个地址分别入账，deposits 记链
// 要实现的模块：server/wallet/router.js、server/wallet/addresses.js；改 server/pay/schema.js、server/pay/core.js 的 recordDeposit
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDb } from './wallet-helpers.js';

const routerMod = () => import('../server/wallet/router.js');
const addrMod = () => import('../server/wallet/addresses.js');
const DAY = 86_400_000;
const T0 = Date.parse('2026-12-01T00:00:00Z');
/** 动态码：测试里 123456 算对 */
const CODE = { code: '123456', verifyCode: async (c) => c === '123456' };

/** 假提供方：每次分配给一个新地址，记下调用 */
function fakeProvider(id, { prefix = id === 'contract' ? '0x' + 'c'.repeat(30) : '0x' + 'f'.repeat(30), schemeVer = 1 } = {}) {
  let n = 0;
  const calls = [];
  return {
    id, enabled: true, calls,
    async allocateAddress(req) { calls.push(req); n++; return { address: prefix + String(n).padStart(10, '0'), providerRef: `${id}-${n}`, schemeVer }; },
  };
}

async function columns(db, table) {
  const rows = await db.query(`select column_name c, is_nullable n from information_schema.columns where table_schema = current_schema() and table_name = $1`, [table]);
  return Object.fromEntries(rows.map((r) => [r.c, r.n]));
}

// ---------- 表结构 ----------

test('表结构：customer_addresses 记下链、提供方、方案版本、盐、地址、状态、停用时间；wallet_routes 的商户列可空；deposits 记链', async () => {
  const db = await setupDb();
  const ca = await columns(db, 'customer_addresses');
  for (const c of ['merchant_id', 'customer_id', 'chain', 'provider', 'scheme_ver', 'salt', 'address', 'status', 'retired_at']) assert.ok(c in ca, `customer_addresses.${c}`);
  const wr = await columns(db, 'wallet_routes');
  for (const c of ['merchant_id', 'chain', 'provider', 'effective_from']) assert.ok(c in wr, `wallet_routes.${c}`);
  assert.equal(wr.merchant_id, 'YES', 'merchant_id 先留空不用，以后按商户切换不用改表');
  const dp = await columns(db, 'deposits');
  assert.ok('chain' in dp, 'deposits.chain');
  await db.end?.();
});

test('表结构：链只能是 eth、bsc、tron；同一个地址在 ETH 和 BSC 上各一行可以共存，同一条链上不能重复', async () => {
  const db = await setupDb({ customers: [['m1', 'c1'], ['m1', 'c2']] });
  const ins = (c, chain, addr) => db.query(`insert into customer_addresses (merchant_id, customer_id, chain, provider, scheme_ver, salt, address, status)
    values ('m1', $1, $2, 'contract', 1, '0x01', $3, 'active')`, [c, chain, addr]);
  const A = '0x' + 'ab'.repeat(20);
  await ins('c1', 'eth', A);
  await ins('c1', 'bsc', A); // ETH、BSC 同一个地址
  await assert.rejects(ins('c2', 'eth', A)); // 同一条链上地址唯一
  await assert.rejects(ins('c2', 'sol', '0x' + 'cd'.repeat(20))); // 不支持的链
  await db.end?.();
});

test('旧数据：升级前已有的 TRON 客户，升级后在 customer_addresses 里有一行 tron、地址不变、状态 active；再执行一次建表不重复', async () => {
  const { migrate } = await import('../server/pay/schema.js');
  const db = await setupDb({ customers: [['m1', 'old1'], ['m1', 'old2']] });
  // setupDb 是在建表之后插入的客户 = 模拟"升级前已有的数据"，再执行一次建表 / 迁移
  await migrate(db);
  await migrate(db);
  const rows = await db.query(`select customer_id, chain, address, status from customer_addresses where merchant_id = 'm1' order by customer_id`);
  const old = await db.query(`select customer_id, address from customers where merchant_id = 'm1' order by customer_id`);
  assert.deepEqual(rows.map((r) => [r.customer_id, r.chain, r.address, r.status]), old.map((c) => [c.customer_id, 'tron', c.address, 'active']));
  await db.end?.();
});

// ---------- 路由 ----------

test('路由：没有设置时全局默认 contract；按链设置后只影响这条链；查找顺序 商户+链 → 链 → 全局', async () => {
  const { resolveProvider } = await routerMod();
  const db = await setupDb();
  assert.equal(await resolveProvider(db, { chain: 'eth', merchantId: 'm1', now: T0 }), 'contract');
  await db.query(`insert into wallet_routes (merchant_id, chain, provider, effective_from) values (null, 'bsc', 'cobo', $1)`, [new Date(T0 - DAY)]);
  assert.equal(await resolveProvider(db, { chain: 'bsc', merchantId: 'm1', now: T0 }), 'cobo');
  assert.equal(await resolveProvider(db, { chain: 'eth', merchantId: 'm1', now: T0 }), 'contract');
  // 商户 + 链的一行优先（第一版不开放设置，但查找顺序先留好）
  await db.query(`insert into wallet_routes (merchant_id, chain, provider, effective_from) values ('m1', 'bsc', 'fireblocks', $1)`, [new Date(T0 - DAY)]);
  assert.equal(await resolveProvider(db, { chain: 'bsc', merchantId: 'm1', now: T0 }), 'fireblocks');
  assert.equal(await resolveProvider(db, { chain: 'bsc', merchantId: 'm2', now: T0 }), 'cobo');
  await db.end?.();
});

test('路由：生效时间没到的不算；同一条链多次切换，取已生效的最新一条', async () => {
  const { resolveProvider } = await routerMod();
  const db = await setupDb();
  await db.query(`insert into wallet_routes (merchant_id, chain, provider, effective_from) values (null, 'eth', 'cobo', $1), (null, 'eth', 'contract', $2), (null, 'eth', 'fireblocks', $3)`,
    [new Date(T0 - 3 * DAY), new Date(T0 - DAY), new Date(T0 + DAY)]);
  assert.equal(await resolveProvider(db, { chain: 'eth', now: T0 }), 'contract');
  assert.equal(await resolveProvider(db, { chain: 'eth', now: T0 + 2 * DAY }), 'fireblocks');
  await db.end?.();
});

test('切换：只能按链整体切换（带商户的拒绝）；动态码、原因必填；只能切到已开通的提供方；记审计', async () => {
  const { setChainProvider, resolveProvider } = await routerMod();
  const db = await setupDb();
  const providers = { contract: fakeProvider('contract'), cobo: { id: 'cobo', enabled: false }, fireblocks: fakeProvider('fireblocks') };
  const base = { chain: 'eth', provider: 'fireblocks', actor: 'admin@x', reason: '演练切换', providers, now: T0, ...CODE };
  await assert.rejects(setChainProvider(db, { ...base, merchantId: 'm1' }), (e) => e.code === 'merchant_route_not_supported');
  await assert.rejects(setChainProvider(db, { ...base, reason: '  ' }), (e) => e.code === 'reason_required');
  await assert.rejects(setChainProvider(db, { ...base, code: '000000' }), (e) => e.code === 'bad_code');
  await assert.rejects(setChainProvider(db, { ...base, code: undefined }), (e) => e.code === 'bad_code');
  await assert.rejects(setChainProvider(db, { ...base, provider: 'cobo' }), (e) => e.code === 'provider_not_enabled');
  await assert.rejects(setChainProvider(db, { ...base, provider: 'bitgo' }), (e) => e.code === 'provider_not_enabled' || e.code === 'invalid_provider');
  await assert.rejects(setChainProvider(db, { ...base, chain: 'sol' }));
  assert.equal(await resolveProvider(db, { chain: 'eth', now: T0 + 1 }), 'contract', '被拒绝的切换没有生效');
  const before = (await db.query('select count(*)::int n from pay_audit'))[0].n;
  await setChainProvider(db, base);
  assert.equal(await resolveProvider(db, { chain: 'eth', now: T0 + 1 }), 'fireblocks');
  const audit = await db.query('select actor, detail from pay_audit order by id desc limit 1');
  assert.equal((await db.query('select count(*)::int n from pay_audit'))[0].n, before + 1);
  assert.equal(audit[0].actor, 'admin@x');
  const detail = JSON.stringify(audit[0].detail);
  for (const s of ['eth', 'contract', 'fireblocks', '演练切换']) assert.ok(detail.includes(s), `审计里有 ${s}（切换前后的提供方和原因）`);
  await db.end?.();
});

// ---------- 地址：创建时绑定提供方、切换规则 ----------

test('地址：第一次要地址时按路由从提供方拿，并记下提供方；以后再要返回同一个，不再调用提供方', async () => {
  const { addressFor } = await addrMod();
  const db = await setupDb();
  const providers = { contract: fakeProvider('contract'), fireblocks: fakeProvider('fireblocks') };
  const a = await addressFor(db, { merchantId: 'm1', customerId: 'c1', chain: 'eth', providers, now: T0 });
  const b = await addressFor(db, { merchantId: 'm1', customerId: 'c1', chain: 'eth', providers, now: T0 + 1000 });
  assert.equal(b.address, a.address);
  assert.equal(a.provider, 'contract');
  assert.equal(providers.contract.calls.length, 1);
  assert.deepEqual(providers.contract.calls[0], { merchantId: 'm1', customerId: 'c1', chain: 'eth' });
  const [row] = await db.query(`select provider, scheme_ver, salt, status from customer_addresses where merchant_id = 'm1' and customer_id = 'c1' and chain = 'eth'`);
  assert.deepEqual([row.provider, row.scheme_ver, row.salt, row.status], ['contract', 1, 'contract-1', 'active']);
  await db.end?.();
});

test('按链切换后：老客户的地址不变（仍是原提供方）；新客户从新提供方拿；"更换地址"的老客户拿新提供方的地址，旧地址停用', async () => {
  const { setChainProvider } = await routerMod();
  const { addressFor } = await addrMod();
  const db = await setupDb({ customers: [['m1', 'old'], ['m1', 'new']] });
  const providers = { contract: fakeProvider('contract'), fireblocks: fakeProvider('fireblocks') };
  const old1 = await addressFor(db, { merchantId: 'm1', customerId: 'old', chain: 'bsc', providers, now: T0 });
  await setChainProvider(db, { chain: 'bsc', provider: 'fireblocks', actor: 'admin@x', reason: '换托管', providers, now: T0 + 1000, ...CODE });
  const t = T0 + 2000;
  const old2 = await addressFor(db, { merchantId: 'm1', customerId: 'old', chain: 'bsc', providers, now: t });
  assert.equal(old2.address, old1.address, '切换不动老客户已有的地址');
  assert.equal(old2.provider, 'contract');
  const fresh = await addressFor(db, { merchantId: 'm1', customerId: 'new', chain: 'bsc', providers, now: t });
  assert.equal(fresh.provider, 'fireblocks');
  // ETH 没切换，新客户在 ETH 上仍是 contract
  assert.equal((await addressFor(db, { merchantId: 'm1', customerId: 'new', chain: 'eth', providers, now: t })).provider, 'contract');
  // 更换地址
  const renewed = await addressFor(db, { merchantId: 'm1', customerId: 'old', chain: 'bsc', providers, renew: true, now: t + 1000 });
  assert.equal(renewed.provider, 'fireblocks');
  assert.notEqual(renewed.address, old1.address);
  const rows = await db.query(`select address, provider, status, retired_at from customer_addresses where merchant_id = 'm1' and customer_id = 'old' and chain = 'bsc' order by address`);
  const oldRow = rows.find((r) => r.address === old1.address);
  assert.equal(oldRow.status, 'retired');
  assert.equal(oldRow.provider, 'contract', '旧地址的提供方不改');
  assert.equal(new Date(oldRow.retired_at).getTime(), t + 1000);
  // 付款页和 API 只返回新地址
  const again = await addressFor(db, { merchantId: 'm1', customerId: 'old', chain: 'bsc', providers, now: t + 2000 });
  assert.equal(again.address, renewed.address);
  await db.end?.();
});

test('停用的旧地址：一直扫链（不设 30 天期限）；归集仍按原提供方列出（不论停用多久）', async () => {
  const { addressFor, watchedAddresses, sweepCandidates } = await addrMod();
  const { setChainProvider } = await routerMod();
  const db = await setupDb({ customers: [['m1', 'c1'], ['m1', 'c2']] });
  const providers = { contract: fakeProvider('contract'), fireblocks: fakeProvider('fireblocks') };
  const a = await addressFor(db, { merchantId: 'm1', customerId: 'c1', chain: 'eth', providers, now: T0 });
  const keep = await addressFor(db, { merchantId: 'm1', customerId: 'c2', chain: 'eth', providers, now: T0 });
  await setChainProvider(db, { chain: 'eth', provider: 'fireblocks', actor: 'admin@x', reason: '换托管', providers, now: T0 + 1, ...CODE });
  const b = await addressFor(db, { merchantId: 'm1', customerId: 'c1', chain: 'eth', providers, renew: true, now: T0 + 2 });
  const w = (now) => watchedAddresses(db, { chain: 'eth', provider: 'contract', now });
  assert.deepEqual((await w(T0 + 29 * DAY)).sort(), [a.address, keep.address].sort(), '停用 29 天：还在扫');
  assert.deepEqual((await w(T0 + 31 * DAY)).sort(), [a.address, keep.address].sort(), '停用 31 天：还在扫');
  assert.deepEqual((await w(T0 + 3 * 365 * DAY)).sort(), [a.address, keep.address].sort(), '停用 3 年：还在扫');
  assert.deepEqual(await watchedAddresses(db, { chain: 'eth', provider: 'fireblocks', now: T0 + 3 }), [b.address]);
  assert.deepEqual(await watchedAddresses(db, { chain: 'bsc', provider: 'contract', now: T0 + 3 }), []);
  const cands = await sweepCandidates(db, { chain: 'eth', provider: 'contract' });
  assert.deepEqual(cands.map((c) => c.address).sort(), [a.address, keep.address].sort(), '原提供方继续归集停用的旧地址');
  for (const c of cands) { assert.equal(typeof c.salt, 'string'); assert.equal(c.schemeVer, 1); }
  assert.deepEqual((await sweepCandidates(db, { chain: 'eth', provider: 'fireblocks' })).map((c) => c.address), [b.address]);
  await db.end?.();
});

// ---------- 入账：按（链、地址）找客户 ----------

test('入账：ETH、BSC 的到账按（链、地址）找客户，deposits 记链；ETH 和 BSC 同一个地址分别入账、互不影响；停用很久的旧地址也照常入账', async () => {
  const { recordDeposit } = await import('../server/pay/core.js');
  const db = await setupDb({ customers: [['m1', 'c1']] });
  const A = '0x' + 'Ab'.repeat(20);
  for (const chain of ['eth', 'bsc']) {
    await db.query(`insert into customer_addresses (merchant_id, customer_id, chain, provider, scheme_ver, salt, address, status, retired_at)
      values ('m1', 'c1', $1, 'contract', 1, '0x01', $2, $3, $4)`, [chain, A, chain === 'bsc' ? 'retired' : 'active', chain === 'bsc' ? new Date(Date.now() - 400 * DAY) : null]);
  }
  const dep = (chain, txid, amount) => ({ chain, txid, logIndex: 0, block: 10, time: Date.now(), from: '0x' + '11'.repeat(20), to: A, amount, rawAmount: String(amount) });
  const r1 = await recordDeposit(db, dep('eth', '0x' + 'e1'.repeat(32), 150_000_000));
  const r2 = await recordDeposit(db, dep('bsc', '0x' + 'b1'.repeat(32), 12_000_000));
  assert.equal(r1.status, 'credited');
  assert.equal(r2.status, 'credited');
  const rows = await db.query(`select chain, amount, merchant_id, customer_id from deposits order by chain`);
  assert.deepEqual(rows.map((r) => [r.chain, Number(r.amount), r.merchant_id, r.customer_id]), [['bsc', 12_000_000, 'm1', 'c1'], ['eth', 150_000_000, 'm1', 'c1']]);
  const [bal] = await db.query(`select available from balances where merchant_id = 'm1'`);
  assert.equal(Number(bal.available), 162_000_000);
  // 不是我们地址的到账：忽略
  assert.equal((await recordDeposit(db, { ...dep('eth', '0x' + 'e2'.repeat(32), 1_000_000), to: '0x' + '22'.repeat(20) })).status, 'ignored');
  await db.end?.();
});

test('入账：TRON 照旧（不带 chain 的到账按 TRON 处理，deposits.chain = tron）', async () => {
  const { recordDeposit } = await import('../server/pay/core.js');
  const db = await setupDb({ customers: [['m1', 'c1']] });
  const [c] = await db.query(`select address from customers where customer_id = 'c1'`);
  const r = await recordDeposit(db, { txid: 'f'.repeat(64), logIndex: 0, block: 1, time: Date.now(), from: 'TX', to: c.address, amount: 5_000_000 });
  assert.equal(r.status, 'credited');
  const [d] = await db.query('select chain from deposits');
  assert.equal(d.chain, 'tron');
  await db.end?.();
});

// ---------- 第 1 批：TRON 不分配新地址 ----------

test('第 1 批：不分配新的 TRON 地址（chain_not_enabled，不调用任何提供方）；已有 TRON 地址的客户照常返回原地址', async () => {
  const { migrate } = await import('../server/pay/schema.js');
  const { addressFor } = await addrMod();
  const db = await setupDb({ customers: [['m1', 'old']] });
  await migrate(db); // 把升级前的 TRON 客户补进 customer_addresses
  await db.query(`insert into customers (merchant_id, customer_id, address, hd_index) values ('m1', 'fresh', 'T' || repeat('y', 33), 99)`);
  await db.query(`delete from customer_addresses where customer_id = 'fresh'`); // 第 1 批新建的客户没有 TRON 地址
  const providers = { contract: fakeProvider('contract') };
  const [old] = await db.query(`select address from customers where customer_id = 'old'`);
  const got = await addressFor(db, { merchantId: 'm1', customerId: 'old', chain: 'tron', providers, now: T0 });
  assert.equal(got.address, old.address);
  await assert.rejects(addressFor(db, { merchantId: 'm1', customerId: 'fresh', chain: 'tron', providers, now: T0 }), (e) => e.code === 'chain_not_enabled');
  await assert.rejects(addressFor(db, { merchantId: 'm1', customerId: 'old', chain: 'tron', providers, renew: true, now: T0 }), (e) => e.code === 'chain_not_enabled');
  assert.equal(providers.contract.calls.length, 0);
  // ETH、BSC 照常分配
  assert.equal((await addressFor(db, { merchantId: 'm1', customerId: 'fresh', chain: 'eth', providers, now: T0 })).provider, 'contract');
  await db.end?.();
});
