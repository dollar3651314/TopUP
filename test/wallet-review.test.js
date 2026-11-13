// 测试复核补的检查（钱包第 1 批）：
//   一、研发自加的安全措施有测试守着：第一次运行只记凑批时间点；确认后停在"发送中"超过 15 分钟标失败、地址放回；节点连不上时退回待确认
//   二、"连不上节点不等于失败"：广播时连不上，不能把批次当失败、把地址放回（交易可能已经发出），按交易号继续查
//   三、对外接口只加字段：开放 API 和回调里第 0 批就有的字段一个不少、类型不变（基准：test/fixtures/api-v1-fields-batch0.json，
//       用第 0 批代码跑同一组调用生成）；按 K1 新客户和不指定链的订单不带地址，老客户仍是 TRON；新错误码 chain_not_enabled 是 409；健康检查的 wallet 项不进整体 ok
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { fakeEvm, setupDb } from './wallet-helpers.js';
import { proposeDue, proposeSweep, approveSweep, confirmSweeps, getBatch } from '../server/wallet/sweep.js';
import { createEvmAdapter } from '../server/wallet/adapters/evm.js';
import { createContractProvider } from '../server/wallet/providers/contract.js';
import { addressFor } from '../server/wallet/addresses.js';
import { legacyTronCustomer } from './legacy-tron.js';

const V = JSON.parse(readFileSync(new URL('./fixtures/wallet/create2-vectors-topup.json', import.meta.url), 'utf8'));
const BASE = JSON.parse(readFileSync(new URL('./fixtures/api-v1-fields-batch0.json', import.meta.url), 'utf8')).endpoints;
const SCHEME = { ver: 1, factory: V.factory, implementation: V.implementation, parent: V.parents[0], batcher: V.feeAddresses[0] };
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const U = (usdt) => BigInt(Math.round(usdt * 1e6));
const MIN = 60_000;
const T0 = Date.parse('2026-12-01T04:00:00Z'); // 东八区 12:00

/** 真的 contract 提供方 + 替身节点；c1 的地址里有 usdt 个 USDT */
async function realContract(usdt = 500, nodeState = {}) {
  const db = await setupDb({ customers: [['m1', 'c1']] });
  const node = fakeEvm({ head: 1000, ...nodeState });
  const adapter = createEvmAdapter({ chain: 'eth', rpcUrl: node.rpcUrl, fetchImpl: node.fetchImpl, usdt: USDT, decimals: 6, confirmations: 12 });
  const provider = await createContractProvider({ db, chains: { eth: { adapter, scheme: SCHEME, usdt: USDT } }, operatorKey: '0x' + randomBytes(32).toString('hex') });
  const providers = { contract: provider };
  const { address } = await addressFor(db, { merchantId: 'm1', customerId: 'c1', chain: 'eth', providers, now: T0 });
  node.state.balances[address.toLowerCase()] = U(usdt);
  return { db, node, providers, address };
}

/** 假提供方：executeSweep 由调用方决定 */
function fakeProvider(address, executeSweep) {
  return {
    id: 'contract', enabled: true, executed: [],
    capabilities: () => ({ batchSweep: true, batchPayout: false, selfScan: true, webhook: false }),
    async balance() { return U(500); },
    async planSweep(chain, candidates, limits) { const { planSweep } = await import('../server/wallet/sweep-plan.js'); return { chain, ...planSweep(candidates, limits) }; },
    executeSweep, async txStatus() { return 'pending'; }, async sweepOutcome() { return { status: 'pending', swept: [], failed: [] }; },
    async estimateFee() { return { native: 0n, detail: '' }; },
  };
}
async function seeded() {
  const db = await setupDb({ customers: [['m1', 'c1']] });
  const address = '0x' + '12'.repeat(20);
  await db.query(`insert into customer_addresses (merchant_id, customer_id, chain, provider, scheme_ver, salt, address, status) values ('m1', 'c1', 'eth', 'contract', 1, $1, $2, 'active')`, ['0x' + '01'.padStart(64, '0'), address]);
  return { db, address };
}

// ---------- 一、研发自加的安全措施 ----------

test('凑批时间：刚部署第一次运行只记下最近的时间点、不凑批不发邮件；到下一个时间点才凑', async () => {
  const { db, address } = await seeded();
  const p = fakeProvider(address, async () => ({ txRefs: ['0x' + 'aa'.repeat(32)] }));
  const mails = [];
  const notify = async (s) => { mails.push(s); };
  const r1 = await proposeDue(db, { chains: ['eth'], providers: { contract: p }, notify, now: T0 });
  assert.equal(r1.first, true);
  assert.deepEqual(await proposeSweep(db, { chain: 'eth', providers: { contract: p }, notify: async () => {}, now: T0, limits: { thresholds: { eth: U(1_000_000) }, capPerAddress: 0n, capPerBatch: 0n, maxFeeRatioPct: 3 } }), [], '第一次运行没有建任何批次');
  assert.equal(mails.length, 0);
  assert.equal((await proposeDue(db, { chains: ['eth'], providers: { contract: p }, notify, now: T0 + 60 * MIN })).slot, null, '同一个时间点不再凑');
  const r3 = await proposeDue(db, { chains: ['eth'], providers: { contract: p }, notify, now: Date.parse('2026-12-01T12:00:10Z') }); // 东八区 20:00
  assert.equal(r3.chains.eth, 1);
  assert.equal(mails.length, 1);
  await db.end?.();
});

test('确认后停在"发送中"：15 分钟内不动；超过 15 分钟标失败、地址放回待归集（下一次凑批重新列出）、发邮件', async () => {
  const { db, address } = await seeded();
  let release;
  const hang = new Promise((ok) => { release = ok; });
  const p = fakeProvider(address, () => hang); // 模拟确认后进程卡住、没有拿到交易号
  const providers = { contract: p };
  const mails = [];
  const notify = async (s) => { mails.push(s); };
  const [b] = await proposeSweep(db, { chain: 'eth', providers, notify: async () => {}, now: Date.now() });
  const pending = approveSweep(db, { id: b.id, actor: 'admin@x', reason: 'r', providers, now: Date.now() }).catch(() => {});
  for (let i = 0; i < 50 && (await getBatch(db, b.id)).status !== 'sending'; i++) await new Promise((ok) => setTimeout(ok, 10));
  assert.equal((await getBatch(db, b.id)).status, 'sending');
  await confirmSweeps(db, { providers, notify, now: Date.now() + 14 * MIN });
  assert.equal((await getBatch(db, b.id)).status, 'sending', '15 分钟内不动');
  assert.deepEqual(await proposeSweep(db, { chain: 'eth', providers, notify: async () => {}, now: Date.now() }), [], '发送中的地址不会被别的批次重复列入');
  await confirmSweeps(db, { providers, notify, now: Date.now() + 16 * MIN });
  const after = await getBatch(db, b.id);
  assert.equal(after.status, 'failed');
  assert.ok(mails.some((s) => /归集/.test(s)), '发了邮件');
  const again = await proposeSweep(db, { chain: 'eth', providers, notify: async () => {}, now: Date.now() + 17 * MIN });
  assert.deepEqual(again.flatMap((x) => x.items.map((i) => i.address)), [address], '地址放回待归集');
  release({ txRefs: [] });
  await pending;
  await db.end?.();
});

test('节点连不上（交易还没签出去）：确认失败但批次退回"待确认"、地址不放回，可以稍后再点；没有广播任何交易', async () => {
  const { db, node, providers, address } = await realContract(500);
  const [b] = await proposeSweep(db, { chain: 'eth', providers, notify: async () => {}, now: T0 });
  assert.deepEqual(b.items.map((i) => i.address), [address]);
  node.state.down = true;
  await assert.rejects(approveSweep(db, { id: b.id, actor: 'admin@x', reason: 'r', providers, now: T0 + MIN }), (e) => e.code === 'sweep_not_sent');
  assert.equal((await getBatch(db, b.id)).status, 'awaiting_approval');
  assert.equal(node.state.sent.length, 0);
  // 节点恢复后再点一次就能发出
  node.state.down = false;
  const r = await approveSweep(db, { id: b.id, actor: 'admin@x', reason: '再试', providers, now: T0 + 2 * MIN });
  assert.equal(r.status, 'sent');
  assert.equal(node.state.sent.length, 1);
  await db.end?.();
});

// ---------- 二、连不上节点不等于失败 ----------

test('广播时连不上节点（交易已签名、可能已经发出）：不当失败、不把地址放回；记下本地算出的交易号，按交易号继续查', async () => {
  const { db, providers } = await realContract(500, { downFor: ['eth_sendRawTransaction'] });
  const [b] = await proposeSweep(db, { chain: 'eth', providers, notify: async () => {}, now: T0 });
  await approveSweep(db, { id: b.id, actor: 'admin@x', reason: 'r', providers, now: T0 + MIN }).catch(() => {});
  const after = await getBatch(db, b.id);
  assert.notEqual(after.status, 'failed', '连不上节点不等于失败');
  assert.equal(after.txRefs.length, 1, '记下了交易号（签名后本地就能算出）');
  assert.match(after.txRefs[0], /^0x[0-9a-f]{64}$/);
  // 地址仍在这一批里，不会被下一批重复列入
  assert.deepEqual(await proposeSweep(db, { chain: 'eth', providers, notify: async () => {}, now: T0 + 2 * MIN }), []);
  await db.end?.();
});

// ---------- 三、对外接口只加字段 ----------

const keysMod = () => import('../server/pay/common.js');
async function apiSetup() {
  const { createTestDb } = await import('../server/pay/db.js');
  const { migrate } = await import('../server/pay/schema.js');
  const core = await import('../server/pay/core.js');
  const { createOps } = await import('../server/pay/ops.js');
  const { createApiV1, signRequest, canonicalPath } = await import('../server/pay/api-v1.js');
  const { createMemRedis } = await import('../server/kyb/memredis.js');
  const { createWalletLayer } = await import('../server/wallet/index.js');
  const { loadConfig } = await import('../server/config.js');
  const { walletsFor } = await import('../server/pay/deps.js');
  const { mnemonicToSeedSync } = await import('@scure/bip39');
  const { HDKey } = await import('@scure/bip32');
  const { derivePayKeys } = await keysMod();
  const keys = derivePayKeys('test-app-secret-test-app-secret-0123456789');
  const db = await createTestDb(); await migrate(db);
  await core.setMeta(db, 'xpub', HDKey.fromMasterSeed(mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')).derive("m/44'/195'/0'").publicExtendedKey);
  // 和本地运行同一套钱包层（ETH、BSC 内存替身）：第 1 批真实的样子
  const wallet = createWalletLayer({ db, config: loadConfig({ APP_ENV: 'local' }), evm: walletsFor('local').evm || {} });
  assert.deepEqual([...wallet.enabledChains].sort(), ['bsc', 'eth'], '本地钱包层开通了 ETH、BSC');
  const ops = createOps({ db, keys, payBase: 'https://pay.test', wallet });
  await core.createMerchant(db, { id: 'ma', name: 'ma', feeIn: { ppm: 10000, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 0, min: 0 } });
  await db.query(`update merchants set order_mode = jsonb_set(order_mode, '{enabled}', 'true') where id = 'ma'`);
  const [m] = await db.query(`select * from merchants where id = 'ma'`);
  const cred = await ops.regenerateSecret(m);
  const api = createApiV1({ db, keys, ops, getIp: () => '203.0.113.1', redis: createMemRedis() });
  const call = async (method, path, body) => {
    const raw = body ? JSON.stringify(body) : '';
    const full = `https://api.test/api/v1/${path}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await api(new Request(full, { method, body: raw || undefined, headers: { 'content-type': 'application/json', 'x-topup-key': cred.api_key, 'x-topup-timestamp': ts, 'x-topup-signature': signRequest(cred.api_secret, ts, method, canonicalPath(full), raw), ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}) } }));
    return { status: res.status, body: await res.json() };
  };
  return { db, core, call };
}
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
/**
 * 第 0 批的字段一个不少、类型不变。except：按 K1 决定（客户充值时才生成地址）允许为 null 的字段，调用处另外断言它的值。
 */
function keepsOld(name, obj, { except = [] } = {}) {
  const old = BASE[name];
  assert.ok(old, `基准里有 ${name}`);
  for (const [k, t] of Object.entries(old)) {
    assert.ok(k in obj, `${name}：第 0 批的字段 ${k} 还在`);
    if (except.includes(k) && obj[k] === null) continue;
    // 第 0 批是 null 的字段（例如还没付款的时间）现在可以是 null 或原来那一类，不能变成别的类型
    if (t !== 'null') assert.equal(typeOf(obj[k]), t, `${name}.${k} 的类型没变`);
  }
}

// K1（11/13 决定）：所有地址都是客户发起充值时才生成，客户要用哪条链就给哪条链。所以：
//   新客户 address 为 null、addresses 为空；不指定链的订单创建时不带地址；指定链的订单创建时只生成这条链的地址。
//   这是按决定改口径，不是放宽：其余字段一个不少、类型不变的检查照旧；已有 TRON 地址的老客户照旧是 TRON 字符串。
test('开放 API（K1）：新客户 address 为 null、addresses 为空；不指定链的订单不带地址；指定链的订单只生成这条链；其余第 0 批字段一个不少、类型不变', async () => {
  const { db, core, call } = await apiSetup();
  const c = await call('POST', 'customers/', { customer_id: 'u1', name: 'N', email: 'a@b.co' });
  assert.equal(c.status, 200);
  keepsOld('POST customers', c.body, { except: ['address'] });
  assert.equal(c.body.address, null, '新客户不生成地址');
  assert.deepEqual(c.body.addresses, []);
  keepsOld('GET customers', (await call('GET', 'customers/?customer_id=u1')).body, { except: ['address'] });
  keepsOld('GET customers/list', (await call('GET', 'customers/list/')).body.items[0], { except: ['address'] });

  // 不指定链的订单：创建时不带地址（付款人在付款页选了链才生成）
  const o = await call('POST', 'orders/', { customer_id: 'u1', merchant_order_no: 'A1', amount: '10' });
  assert.equal(o.status, 200);
  keepsOld('POST orders', o.body, { except: ['address', 'network'] });
  assert.equal(o.body.address, null);
  assert.equal(o.body.network, null);
  assert.equal(o.body.chain, null);
  assert.deepEqual(o.body.addresses, []);
  keepsOld('GET orders', (await call('GET', `orders/?order_no=${o.body.order_no}`)).body, { except: ['address', 'network'] });
  keepsOld('GET orders/list', (await call('GET', 'orders/list/')).body.items[0]);
  assert.deepEqual((await call('GET', 'customers/?customer_id=u1')).body.addresses, [], '不指定链的订单不生成地址');
  // 指定链：创建订单时生成这条链的地址（只这一条链）
  const oe = await call('POST', 'orders/', { customer_id: 'u1', merchant_order_no: 'A2', amount: '10', chain: 'eth' });
  assert.equal(oe.status, 200);
  keepsOld('POST orders', oe.body);
  assert.match(oe.body.address, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(oe.body.network, 'ETH');
  assert.deepEqual(oe.body.addresses.map((a) => a.chain), ['eth']);
  const cu = (await call('GET', 'customers/?customer_id=u1')).body;
  assert.deepEqual(cu.addresses, [{ chain: 'eth', address: oe.body.address }]);
  assert.equal(cu.address, null, '旧字段 address 只给 TRON，新客户没有 TRON 地址');
  const ot = await call('POST', 'orders/', { customer_id: 'u1', merchant_order_no: 'A3', amount: '10', chain: 'tron' });
  assert.equal(ot.status, 409);
  assert.equal(ot.body.error.code, 'chain_not_enabled');
  assert.equal((await call('POST', 'orders/', { customer_id: 'u1', merchant_order_no: 'A4', amount: '10', chain: 'sol' })).status, 422);

  // 已有 TRON 地址的老客户：客户和不指定链的订单照第 0 批（TRON 字符串），TRON 到账和回调的老字段不变，新加 chain
  const old = await legacyTronCustomer(db, 'ma', 'u_old');
  const oc = (await call('GET', 'customers/?customer_id=u_old')).body;
  keepsOld('GET customers', oc);
  assert.equal(oc.address, old.address);
  assert.deepEqual(oc.addresses, [{ chain: 'tron', address: old.address }]);
  const oo = await call('POST', 'orders/', { customer_id: 'u_old', merchant_order_no: 'B1', amount: '10' });
  assert.equal(oo.status, 200);
  await core.recordDeposit(db, { txid: 'f'.repeat(64), logIndex: 0, block: 1, time: Date.now(), from: 'TX', to: old.address, amount: 10_000_000 });
  const d = (await call('GET', 'deposits/')).body.items[0];
  keepsOld('GET deposits', d);
  assert.equal(d.chain, 'tron');
  keepsOld('GET balance', (await call('GET', 'balance/')).body);
  const [cb] = await db.query(`select payload from callbacks where event = 'deposit' order by created_at`);
  keepsOld('callback deposit', cb.payload);
  keepsOld('callback deposit data', cb.payload.data);
  assert.equal(cb.payload.data.chain, 'tron');
  const [mcb] = await db.query(`select payload from callbacks where event = 'order.matched' order by created_at`);
  keepsOld('callback order.matched', mcb.payload);
  keepsOld('callback order.matched data', mcb.payload.data);
  await db.end?.();
});

const PG = process.env.TEST_DATABASE_URL || '';
test('健康检查：第 0 批的字段不变；新加的 wallet 项单独显示，钱包没配齐也不让整体 ok 变 false（需要 TEST_DATABASE_URL）', { skip: PG ? false : '没有设置 TEST_DATABASE_URL' }, async () => {
  const { loadConfig } = await import('../server/config.js');
  const { createWeb } = await import('../server/web.js');
  const dir = mkdtempSync(join(tmpdir(), 'topup-health-'));
  const err = console.error; console.error = () => {};
  try {
    const web = createWeb(loadConfig({ APP_ENV: 'staging', REDIS_URL: process.env.TEST_REDIS_URL || 'redis://127.0.0.1:1', DATABASE_URL: PG, MAIL_FROM: 'a@x', MAIL_TO: 'b@x', SMTP_HOST: 'smtp.x', APP_SECRET: 'x'.repeat(40), BLOB_DIR: dir, PUBLIC_URL: 'https://x.test', TRONGRID_API_KEY: 'k' }), { site: dir });
    const res = await web.handle(new Request('http://x.test/api/health/'));
    const b = await res.json();
    for (const k of ['ok', 'env', 'commit', 'storage', 'db', 'mail', 'mailMode', 'secret', 'blob', 'pay', 'worker']) assert.ok(k in b, `第 0 批的 ${k} 还在`);
    assert.ok(b.wallet && Array.isArray(b.wallet.chains), '新加 wallet 项');
    assert.equal(b.ok, true, '其他都配好时整体 ok，不受钱包配没配齐影响');
    assert.equal(res.status, 200);
    const s = JSON.stringify(b.wallet);
    assert.doesNotMatch(s, /0x[0-9a-fA-F]{40}/, 'wallet 项不返回地址的值');
    await (await web.app).close();
  } finally { console.error = err; rmSync(dir, { recursive: true, force: true }); }
});
