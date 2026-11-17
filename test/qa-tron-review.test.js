// 测试复核补测（第 2 批，TRON 合约钱包）：
//   一、签名前核对节点建的交易（tx_mismatch）：发起地址、合约、调用数据、带 TRX、fee_limit 任何一项被改 → 不签名、不广播、不租能量，批次退回待确认；
//       先让节点建交易并核对通过，再租能量（核对不过不花租能量的钱）；
//       原文里有重复字段（java-tron 解码时同号字段取最后一个，恶意节点可以在后面塞一个）、未知字段、字段 5 / 6（call_token_value、token_id）、
//       地址第一个字节不是 0x41 → 一律拒签（tx_mismatch）
//   二、老地址（legacy_hd / customers.address）和合约地址的未归集分开记：合约地址的到账不进 customers.onchain（老的浏览器签名归集只看它），
//       老地址照旧进；概览的未归集 = 老地址 + 合约地址，各算一次
//   三、TRON 合约钱包的 parent 等于第 0 批冷钱包时，概览冷钱包只算一次；按链拆开时 TRON 一行仍有热钱包、冷钱包
//   四、TronSave：下单超时、平台出错、限流都抛带 code 的错；下单不自动重试；没成交（等不到 100%）抛 not_filled 并带出订单号；
//       没成交改烧 TRX 后，这一单之后仍可能成交扣费 → 归集结果和告警邮件里都要有这张订单号，并写明可能仍会扣费（方便对账）
//   五、config/wallets.json 改动邮件：第一次启动发一封"开始记录"（顺便确认告警邮箱通着），只有环境名、sha256 和公开地址；之后不变不发；
//       改了只发一封（同时启动也一封）；没配收件人只记录（之后补配收件人也不补发这次）；
//       邮件里只有公开地址和前后 sha256，没有任何私钥样的 64 位十六进制
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeTronNode, tronScheme, testOperator, randomTron, word, quiet, proto, h20 } from './tron-helpers.js';
import { hex } from '@scure/base';
import { setupDb } from './wallet-helpers.js';
import * as core from '../server/pay/core.js';
import { createTronAdapter } from '../server/wallet/adapters/tron.js';
import { createContractProvider } from '../server/wallet/providers/contract.js';
import { addressFor } from '../server/wallet/addresses.js';
import { proposeSweep, approveSweep, getBatch } from '../server/wallet/sweep.js';
import { createTronSaveRenter } from '../server/wallet/energy.js';
import { checkWalletsChange } from '../server/pay/wallets-change.js';
import { createTestDb } from '../server/pay/db.js';
import { migrate } from '../server/pay/schema.js';
import { createFakeTron } from '../server/pay/fake-trongrid.js';
import { createWalletApi } from '../server/pay/wallet-api.js';
import { derivePayKeys } from '../server/pay/common.js';
import { createWalletLayer } from '../server/wallet/index.js';
import { loadConfig } from '../server/config.js';
import { walletsFor } from '../server/pay/deps.js';
import { addressOfPrivateKey } from '../server/pay/signing.js';

const U = 1_000_000;
const usd = (n) => BigInt(Math.round(n * 1e6));
const LIM = { threshold: usd(100), capPerAddress: usd(5000), capPerBatch: usd(20000), maxFeeRatioPct: 0, maxAddresses: 50 };

/** 租能量平台替身：记下调用，总是租到 */
function renterSpy() {
  const calls = [];
  return { calls, async rent(req) { calls.push(req); return { orderId: `R${calls.length}` }; }, async balance() { return 0n; } };
}

async function setupT({ customers = 2, renter } = {}) {
  const { scheme, usdt } = tronScheme();
  const operator = testOperator();
  const node = fakeTronNode({ head: 1000, scheme, usdt });
  node.activate(operator.address, 5_000_000_000);
  const db = await setupDb({ customers: Array.from({ length: customers }, (_, i) => ['m1', `c${i + 1}`]) });
  const adapter = createTronAdapter({ base: node.base, fetchImpl: node.fetchImpl, usdt, confirmations: 19, timeoutMs: 2000 });
  const p = createContractProvider({ db, chains: { tron: { adapter, scheme, usdt } }, tronOperatorKey: operator.key, tronEnergy: renter });
  const providers = { contract: p };
  const addrs = [];
  for (let i = 1; i <= customers; i++) addrs.push((await addressFor(db, { merchantId: 'm1', customerId: `c${i}`, chain: 'tron', providers })).address);
  return { db, node, p, providers, addrs, scheme, usdt, operator };
}
async function fund(t, amounts) {
  for (const [i, a] of amounts.entries()) {
    const raw = usd(a);
    const tx = t.node.transfer({ to: t.addrs[i], amount: raw, block: t.node.state.head });
    await core.recordDeposit(t.db, { chain: 'tron', txid: tx.txid, logIndex: 0, block: tx.block, time: Date.now(), from: randomTron(), to: t.addrs[i], amount: Number(raw), rawAmount: String(raw) });
  }
}

// ---------- 一、tx_mismatch ----------

test('签名前核对节点建的交易：发起地址、合约、调用数据（盐被换）、带 TRX、fee_limit 任何一项不对 → tx_mismatch，不签名、不广播、不租能量（先建交易核对，再租），批次退回待确认', async () => {
  const cases = {
    owner: () => ({ owner: randomTron() }),
    contract: () => ({ contract: randomTron() }),
    data: (b) => ({ data: b.data.slice(0, -64) + word('ab'.repeat(32)) }),
    callValue: () => ({ callValue: 1 }),
    feeLimit: (b) => ({ feeLimit: Number(b.fee_limit) * 10 }),
  };
  const origErr = console.error; console.error = quiet.error;
  try {
    for (const [name, tamper] of Object.entries(cases)) {
      const renter = renterSpy();
      const t = await setupT({ renter });
      await fund(t, [150, 250]);
      const [b] = await proposeSweep(t.db, { chain: 'tron', providers: t.providers, limits: LIM });
      t.node.state.tamperTrigger = tamper;
      await assert.rejects(approveSweep(t.db, { id: b.id, actor: 'admin', reason: 'x', providers: t.providers }), (e) => e.code === 'sweep_not_sent', name);
      const got = await getBatch(t.db, b.id);
      assert.equal(got.status, 'awaiting_approval', name);
      assert.match(got.error || '', /tx_mismatch|does not match/, name);
      assert.equal(t.node.state.broadcasts.length, 0, `${name}：不广播`);
      assert.equal(renter.calls.length, 0, `${name}：核对不过不租能量（先建交易、核对，再租）`);
      await t.db.end?.();
    }
  } finally { console.error = origErr; }
});

test('签名前按原文逐个字段核对（java-tron 同号字段取最后一个）：重复的 contract_address / call_value / 调用数据、未知字段、字段 5 / 6（call_token_value、token_id）、地址前缀不是 0x41 → tx_mismatch，不签名、不广播、不租能量', async () => {
  const cases = {
    dupContract: () => ({ extraParam: proto.len(2, [0x41, ...hex.decode(h20(randomTron()))]) }),
    dupCallValue: () => ({ extraParam: proto.int(3, 1_000_000) }),
    dupData: (b) => ({ extraParam: proto.len(4, Array.from(hex.decode(b.data.slice(0, -64) + word('cd'.repeat(32))))) }),
    unknownField: () => ({ extraParam: proto.int(9, 1) }),
    callTokenValue: () => ({ extraParam: proto.int(5, 1) }),
    tokenId: () => ({ extraParam: proto.int(6, 1_000_001) }),
    ownerPrefix: () => ({ ownerPrefix: 0xa0 }),
    contractPrefix: () => ({ contractPrefix: 0xa0 }),
  };
  const origErr = console.error; console.error = quiet.error;
  try {
    for (const [name, tamper] of Object.entries(cases)) {
      const renter = renterSpy();
      const t = await setupT({ renter });
      await fund(t, [150, 250]);
      const [b] = await proposeSweep(t.db, { chain: 'tron', providers: t.providers, limits: LIM });
      t.node.state.tamperTrigger = tamper;
      await assert.rejects(approveSweep(t.db, { id: b.id, actor: 'admin', reason: 'x', providers: t.providers }), (e) => e.code === 'sweep_not_sent', name);
      const got = await getBatch(t.db, b.id);
      assert.equal(got.status, 'awaiting_approval', name);
      assert.match(got.error || '', /tx_mismatch|does not match/, name);
      assert.equal(t.node.state.broadcasts.length, 0, `${name}：不广播`);
      assert.equal(renter.calls.length, 0, `${name}：不租能量`);
      await t.db.end?.();
    }
    // 对照：原文正常时照常租、照常发（上面的拒签不是因为别的原因）
    const renter = renterSpy();
    const ok = await setupT({ renter });
    await fund(ok, [150]);
    const [b] = await proposeSweep(ok.db, { chain: 'tron', providers: ok.providers, limits: LIM });
    assert.equal((await approveSweep(ok.db, { id: b.id, actor: 'admin', reason: 'x', providers: ok.providers })).status, 'sent');
    assert.equal(renter.calls.length, 1);
    await ok.db.end?.();
  } finally { console.error = origErr; }
});

// ---------- 二、老地址 / 合约地址的未归集分开 ----------

test('未归集分开记：合约地址的到账不进 customers.onchain（老的浏览器签名归集只看它）；老地址（legacy_hd 行，或只在 customers.address）照旧进；同一客户两种地址各进各的', async () => {
  const t = await setupT({ customers: 1 });
  const legacy = randomTron(), older = randomTron();
  await t.db.query(`update customers set address = $1 where customer_id = 'c1'`, [legacy]);
  await t.db.query(`insert into customer_addresses (merchant_id, customer_id, chain, provider, scheme_ver, salt, address, status) values ('m1', 'c1', 'tron', 'legacy_hd', 0, '', $1, 'retired')`, [legacy]);
  await t.db.query(`insert into customers (merchant_id, customer_id, address, hd_index) values ('m1', 'c9', $1, 99)`, [older]); // 只有 customers.address 的老客户
  const onchain = async (c) => Number((await t.db.query(`select onchain from customers where customer_id = $1`, [c]))[0].onchain);
  const dep = (to, amount, n) => core.recordDeposit(t.db, { chain: 'tron', txid: String(n).repeat(64).slice(0, 64), logIndex: 0, block: n, time: Date.now(), from: randomTron(), to, amount, rawAmount: String(amount) });
  assert.equal((await dep(t.addrs[0], 60 * U, 1)).status, 'credited');
  assert.equal(await onchain('c1'), 0, '合约地址的钱不算进老地址的未归集');
  assert.equal((await dep(legacy, 100 * U, 2)).status, 'credited');
  assert.equal(await onchain('c1'), 100 * U, '老地址照旧');
  assert.equal((await core.recordDeposit(t.db, { txid: '3'.repeat(64), logIndex: 0, block: 3, time: Date.now(), from: 'TX', to: older, amount: 7 * U })).status, 'credited');
  assert.equal(await onchain('c9'), 7 * U, '只在 customers.address 的老地址照旧');
  // 合约地址的未归集按账本（到账 − 已归集）单独算
  const { evmUnswept } = await import('../server/wallet/addresses.js');
  const u = await evmUnswept(t.db, { chains: ['tron'] });
  assert.equal(u.tron.total, 60n * BigInt(U), '合约地址未归集只有 60（不含老地址的 100）');
  await t.db.end?.();
});

// ---------- 三、概览：parent = 第 0 批冷钱包只算一次 ----------

const keys = derivePayKeys('test-app-secret-test-app-secret-0123456789');
const HOT = addressOfPrivateKey(Buffer.alloc(32, 0x11));
const COLD = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

async function overview({ parentIsCold }) {
  const db = await createTestDb(); await migrate(db);
  const tron = createFakeTron();
  const { scheme, usdt } = tronScheme();
  if (parentIsCold) scheme.parent = COLD;
  const layer = createWalletLayer({ db, config: loadConfig({ APP_ENV: 'local' }), evm: walletsFor('local').evm || {}, tron: { ...scheme, usdt } });
  assert.deepEqual([...layer.enabledChains].sort(), ['bsc', 'eth', 'tron'], '前提：本地三条链都开通');
  await core.createMerchant(db, { id: 'm1', name: 'Acme', feeIn: { ppm: 0, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 0, min: 0 } });
  const api = createWalletApi({ db, tron, keys, wallets: { hot: HOT, cold: COLD }, requireAdmin: async () => {}, verifyAdminCode: async () => true, layer });
  const call = async (a) => { const res = await api(new Request(`https://x/api/wallet/?a=${a}`, { headers: { 'x-topup-csrf': '1' } })); const body = await res.json(); assert.equal(res.status, 200, JSON.stringify(body)); return body; };
  // 第 0 批：热 50、冷 20；以太坊冷 30、BSC 冷 7
  tron.accounts.set(HOT, { activated: true, trx: 300 * U, trc20: { [tron.contract]: 50 * U } });
  tron.accounts.set(COLD, { activated: true, trx: 0, trc20: { [tron.contract]: 20 * U } });
  layer.adapters.eth.pay({ to: layer.providers.contract.scheme('eth').parent, amount: 30 * U });
  layer.adapters.bsc.pay({ to: layer.providers.contract.scheme('bsc').parent, amount: 7 * U });
  return { db, tron, layer, call, scheme };
}

test('概览：TRON 合约钱包的 parent 就是第 0 批冷钱包 → 冷钱包只算一次；按链拆开 TRON 一行仍有热钱包 50、冷钱包 20', async () => {
  const { db, layer, call } = await overview({ parentIsCold: true });
  layer.adapters.tron.pay({ to: COLD, amount: 20 * U }); // 同一个地址、同一笔钱，合约钱包这边也看得到
  const f = (await call('overview-chain')).funds;
  assert.equal(f.cold_usdt, '57.00', '冷钱包 = TRON 20（只算一次）+ 以太坊 30 + BSC 7');
  assert.equal(f.hot_usdt, '50.00');
  assert.equal(f.by_chain.tron?.hot_usdt, '50.00', 'TRON 一行的热钱包不能被合约钱包那一行盖掉');
  assert.equal(f.by_chain.tron?.cold_usdt, '20.00');
  assert.deepEqual([f.by_chain.eth.cold_usdt, f.by_chain.bsc.cold_usdt], ['30.00', '7.00']);
  await db.end?.();
});

test('概览：parent 和第 0 批冷钱包不是同一个地址 → 两个都算；TRON 一行冷钱包 = 第 0 批冷钱包 + 合约 parent，热钱包照常', async () => {
  const { db, layer, call, scheme } = await overview({ parentIsCold: false });
  layer.adapters.tron.pay({ to: scheme.parent, amount: 15 * U });
  const f = (await call('overview-chain')).funds;
  assert.equal(f.cold_usdt, '72.00', '冷钱包 = 20 + 15 + 30 + 7');
  assert.equal(f.by_chain.tron?.hot_usdt, '50.00');
  assert.equal(f.by_chain.tron?.cold_usdt, '35.00');
  await db.end?.();
});

test('概览：未归集 = 老 TRON 地址（customers.onchain）+ TRON 合约地址（到账 − 已归集），同一笔钱不算两次', async () => {
  const { db, layer, call } = await overview({ parentIsCold: true });
  const legacy = randomTron();
  await db.query(`insert into customers (merchant_id, customer_id, address, hd_index) values ('m1', 'old', $1, 1)`, [legacy]);
  await db.query(`insert into customer_addresses (merchant_id, customer_id, chain, provider, scheme_ver, salt, address, status) values ('m1', 'old', 'tron', 'legacy_hd', 0, '', $1, 'active')`, [legacy]);
  await core.recordDeposit(db, { chain: 'tron', txid: 'a'.repeat(64), logIndex: 0, block: 1, time: Date.now(), from: randomTron(), to: legacy, amount: 100 * U });
  await db.query(`insert into customers (merchant_id, customer_id) values ('m1', 'new')`);
  const { address } = await addressFor(db, { merchantId: 'm1', customerId: 'new', chain: 'tron', providers: layer.providers });
  const p = layer.adapters.tron.pay({ to: address, amount: 60 * U });
  assert.equal((await core.recordDeposit(db, { chain: 'tron', txid: p.txid, logIndex: 0, block: p.block, time: Date.now(), from: randomTron(), to: address, amount: 60 * U, rawAmount: String(60 * U) })).status, 'credited');
  const o = await call('overview');
  assert.equal(o.funds.unswept_total, '160.00', '100 + 60');
  assert.equal(o.sweep.by_chain.tron.unswept_total, '160.00');
  const ch = await call('overview-chain');
  assert.equal(ch.funds.assets_total, String((160 + 50 + 57).toFixed(2)), '平台资产 = 未归集 160 + 热 50 + 冷 57');
  await db.end?.();
});

// ---------- 四、TronSave ----------

/** TronSave 替身：按路径回话；buy 返回订单号；order 返回成交百分比 */
function fakeTronSave({ buy = () => ({ status: 200, body: { data: { orderId: 'O-123' } } }), order = () => ({ status: 200, body: { data: { fulfilledPercent: 100 } } }), info = () => ({ status: 200, body: { data: { balance: '500000000' } } }) } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const r = u.pathname === '/v2/buy-resource' ? buy(init) : u.pathname.startsWith('/v2/order/') ? order(init) : u.pathname === '/v2/user-info' ? info(init) : { status: 404, body: {} };
    if (r === 'hang') return new Promise((_, rej) => { const k = setTimeout(() => rej(new Error('not aborted in 5 s')), 5000); init.signal?.addEventListener('abort', () => { clearTimeout(k); rej(Object.assign(new Error('timeout'), { name: 'TimeoutError' })); }); });
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}
const API_KEY = 'tronsave-test-api-key-not-real';

test('TronSave：成交了返回订单号；下单带 apikey、给发起账户、只在能全部成交时下单', async () => {
  const f = fakeTronSave();
  const r = createTronSaveRenter({ apiKey: API_KEY, base: 'http://ts.test', fetchImpl: f.fetchImpl, sleep: async () => {} });
  const op = randomTron();
  assert.deepEqual(await r.rent({ receiver: op, energy: '300000' }), { orderId: 'O-123' });
  const buy = f.calls.find((c) => c.path === '/v2/buy-resource');
  assert.equal(buy.headers.apikey, API_KEY);
  assert.equal(buy.body.receiver, op);
  assert.equal(Number(buy.body.resourceAmount), 300000);
  assert.equal(buy.body.options?.onlyCreateWhenFulfilled, true);
});

test('TronSave：下单超时 → code timeout；平台 5xx → tronsave_unavailable；429 → rate_limited；都不自动重新下单（避免重复下单扣两次钱）', async () => {
  for (const [buy, code] of [[() => 'hang', 'timeout'], [() => ({ status: 503, body: {} }), 'tronsave_unavailable'], [() => ({ status: 429, body: {} }), 'rate_limited']]) {
    const f = fakeTronSave({ buy });
    const r = createTronSaveRenter({ apiKey: API_KEY, base: 'http://ts.test', fetchImpl: f.fetchImpl, timeoutMs: 150, sleep: async () => {} });
    await assert.rejects(r.rent({ receiver: randomTron(), energy: '100000' }), (e) => e.code === code, code);
    assert.equal(f.calls.filter((c) => c.path === '/v2/buy-resource').length, 1, `${code}：只下一次单`);
  }
});

test('TronSave：下了单但等不到全部成交 → not_filled，错误里带出订单号（这一单之后仍可能成交扣费，要能对账）', async () => {
  const f = fakeTronSave({ order: () => ({ status: 200, body: { data: { fulfilledPercent: 40 } } }) });
  const r = createTronSaveRenter({ apiKey: API_KEY, base: 'http://ts.test', fetchImpl: f.fetchImpl, fillWaitMs: 0, sleep: async () => {} });
  await assert.rejects(r.rent({ receiver: randomTron(), energy: '100000' }), (e) => e.code === 'not_filled' && e.orderId === 'O-123');
  assert.equal(f.calls.filter((c) => c.path === '/v2/buy-resource').length, 1);
});

test('没成交改烧 TRX：归集照常发；结果里记下没成交的订单号；告警邮件写明订单号、可能仍会扣费，不含 API Key', async () => {
  const f = fakeTronSave({ order: () => ({ status: 200, body: { data: { fulfilledPercent: 0 } } }) });
  const renter = createTronSaveRenter({ apiKey: API_KEY, base: 'http://ts.test', fetchImpl: f.fetchImpl, fillWaitMs: 0, sleep: async () => {} });
  const t = await setupT({ customers: 1, renter });
  await fund(t, [150]);
  const items = (await t.db.query(`select address, salt from customer_addresses where chain = 'tron'`)).map((r) => ({ ...r, amount: usd(150), deploy: true }));
  const origErr = console.error; console.error = quiet.error;
  try {
    const r = await t.p.executeSweep({ chain: 'tron', items });
    assert.equal(r.energy?.mode, 'burn');
    assert.equal(r.energy?.reason, 'not_filled');
    assert.equal(r.energy?.orderId, 'O-123', '没成交的订单号要留着对账');
    // 走一遍确认：告警邮件
    const t2 = await setupT({ customers: 1, renter });
    await fund(t2, [150]);
    const [b] = await proposeSweep(t2.db, { chain: 'tron', providers: t2.providers, limits: LIM });
    const mails = [];
    await approveSweep(t2.db, { id: b.id, actor: 'admin', reason: '例行归集', providers: t2.providers, notify: async (s, x) => mails.push(s + '\n' + x) });
    const m = mails.find((x) => /能量/.test(x));
    assert.ok(m, '发了告警');
    assert.match(m, /O-123/, '邮件写明订单号');
    assert.match(m, /扣费|扣钱|计费|仍可能成交/, '写明这一单之后仍可能成交扣费');
    assert.ok(!m.includes(API_KEY), '邮件里没有 API Key');
    await t2.db.end?.();
  } finally { console.error = origErr; }
  await t.db.end?.();
});

// ---------- 五、wallets.json 改动邮件 ----------

const RAW_A = JSON.stringify({ staging: { cold: 'TA', tron: { parent: 'TP1' } } });
const RAW_B = JSON.stringify({ staging: { cold: 'TB', tron: { parent: 'TP2' } } });

test('wallets.json：第一次启动发一封"开始记录"（只有环境名、sha256、公开地址）；之后不变不发；改了只发一封（web、worker 同时启动也一封）', async () => {
  const db = await setupDb();
  const mails = [];
  const notify = async (s, t) => mails.push([s, t]);
  const section = { cold: 'TA', tron: { parent: 'TP1' } };
  const r0 = await checkWalletsChange(db, { raw: RAW_A, appEnv: 'staging', section, notify });
  assert.equal(r0.first, true);
  assert.equal(mails.length, 1, '第一次发一封');
  const [s0, t0] = mails[0];
  assert.match(s0, /开始记录/);
  assert.match(s0 + t0, /staging/, '写明环境');
  assert.ok(t0.includes(r0.sha), '写明 sha256');
  assert.match(t0, /TA/);
  assert.match(t0, /TP1/, '写明公开地址');
  const hex64 = (s0 + t0).match(/(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g) || [];
  assert.deepEqual([...new Set(hex64)], [r0.sha], '64 位十六进制只有这份文件的 sha256');
  for (let i = 0; i < 3; i++) await checkWalletsChange(db, { raw: RAW_A, appEnv: 'staging', section, notify });
  assert.equal(mails.length, 1, '不变不发');
  const rs = await Promise.all([1, 2, 3].map(() => checkWalletsChange(db, { raw: RAW_B, appEnv: 'staging', section: { cold: 'TB' }, notify })));
  assert.equal(rs.filter((r) => r.changed).length, 1);
  assert.equal(mails.length, 2, '改了只发一封');
  await db.end?.();
});

test('wallets.json：没配收件人（MAIL_TO）时只记录；之后配上收件人、文件没再改，不补发这一次', async () => {
  const db = await setupDb();
  const mails = [];
  const notify = async (s, t) => mails.push([s, t]);
  await checkWalletsChange(db, { raw: RAW_A, appEnv: 'staging', section: {}, notify: null });
  const r = await checkWalletsChange(db, { raw: RAW_B, appEnv: 'staging', section: {}, notify: null });
  assert.equal(r.changed, true, '记下了');
  await checkWalletsChange(db, { raw: RAW_B, appEnv: 'staging', section: {}, notify });
  assert.equal(mails.length, 0);
  await db.end?.();
});

test('wallets.json 改动邮件：只有环境、前后 sha256 和公开地址；没有任何私钥样的 64 位十六进制', async () => {
  const db = await setupDb();
  const mails = [];
  const notify = async (s, t) => mails.push(s + '\n' + t);
  const section = walletsFor('staging');
  const a = await checkWalletsChange(db, { raw: RAW_A, appEnv: 'staging', section, notify });
  const b = await checkWalletsChange(db, { raw: RAW_B, appEnv: 'staging', section, notify });
  // 只看"改了"的那一封（第一次发不发由上一条用例管）；所有邮件都不能有私钥样的串
  const changed = mails.filter((m) => /更改/.test(m));
  assert.equal(changed.length, 1);
  for (const m of mails) {
    const all = m.match(/(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g) || [];
    for (const h of all) assert.ok([a.sha, b.sha].includes(h), '邮件里的 64 位十六进制只能是 sha256');
  }
  mails.splice(0, mails.length, ...changed);
  const hex64 = mails[0].match(/(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g) || [];
  assert.deepEqual([...new Set(hex64)].sort(), [a.sha, b.sha].sort(), '64 位十六进制只能是前后两个 sha256');
  assert.match(mails[0], /staging/);
  assert.doesNotMatch(mails[0], /private|私钥：|SWEEP_OPERATOR_KEY|APP_SECRET/i);
  await db.end?.();
});
