// 研发自测（上线前清理 P1-a 复核意见）：真实时钟下的每秒次数限流、生产 TRON 节点的网络核对（启动时连不上之后第一次问到再核对、
// 答的不是创世块当作不对）、老 TRON 归集广播遇到 DUP_TRANSACTION_ERROR 按已广播处理。
import test from 'node:test';
import assert from 'node:assert/strict';
import { hex } from '@scure/base';
import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { fakeTronNode, randomTron, tronScheme } from './tron-helpers.js';
import { setupDb } from './wallet-helpers.js';
import { createTronAdapter } from '../server/wallet/adapters/tron.js';
import { createTronGrid } from '../server/pay/trongrid.js';
import { TRON_GENESIS, checkTronMainnet, createTestnetCheck } from '../server/pay/test-admin.js';
import { loadConfig } from '../server/config.js';
import { createTestDb } from '../server/pay/db.js';
import { migrate } from '../server/pay/schema.js';
import * as core from '../server/pay/core.js';
import { createFakeTron } from '../server/pay/fake-trongrid.js';
import { createWalletApi, sweepProgress } from '../server/pay/wallet-api.js';
import { derivePayKeys } from '../server/pay/common.js';
import { signTxId, addressOfPrivateKey } from '../server/pay/signing.js';
import { legacyTronCustomer } from './legacy-tron.js';

/** 任意连续 1000 毫秒里开始的请求数的最大值（starts 是 performance.now() 的毫秒） */
function peakPerSecond(starts) {
  const s = [...starts].sort((a, b) => a - b);
  let peak = 0;
  for (let i = 0, j = 0; i < s.length; i++) { while (s[i] - s[j] >= 1000) j++; peak = Math.max(peak, i - j + 1); }
  return peak;
}

test('真实时钟（不注入 now / sleep，和生产一样）：适配器、老 TronGrid 客户端任意 1 秒内真正发出的请求都 ≤ qps', async () => {
  const QPS = 4, N = 10;
  const node = fakeTronNode({ head: 1000 });
  const aStarts = [];
  const a = createTronAdapter({ base: node.base, usdt: randomTron(), qps: QPS, fetchImpl: async (url, init) => { aStarts.push(performance.now()); return node.fetchImpl(url, init); } });
  const gStarts = [];
  const g = createTronGrid({ network: 'nile', qps: QPS, fetchImpl: async () => { gStarts.push(performance.now()); return Response.json({ result: { result: true }, constant_result: ['0'.repeat(63) + '1'] }); } });
  await Promise.all([
    ...Array.from({ length: N }, () => a.isContract(randomTron())),
    ...Array.from({ length: N }, () => g.usdtBalance(randomTron())),
  ]);
  assert.equal(aStarts.length, N);
  assert.equal(gStarts.length, N);
  assert.ok(peakPerSecond(aStarts) <= QPS, `适配器：峰值 ${peakPerSecond(aStarts)}`);
  assert.ok(peakPerSecond(gStarts) <= QPS, `老客户端：峰值 ${peakPerSecond(gStarts)}`);
  assert.ok(aStarts.at(-1) - aStarts[0] >= 1000, '确实按真实时间等了');
});

/** 可切换的替身：mode = down（连不上）/ 创世块哈希 / 'garbage'（答了但不是创世块） */
function switchable(initial) {
  const node = fakeTronNode({ head: 1000 });
  const st = { mode: initial, calls: [] };
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    st.calls.push(path);
    if (st.mode === 'down') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const body = JSON.parse(init.body || '{}');
    if (path === '/wallet/getblockbynum' && Number(body.num) === 0) return Response.json(st.mode === 'garbage' ? { hello: 'world' } : { blockID: st.mode });
    return node.fetchImpl(url, init);
  };
  return { st, fetchImpl, base: node.base };
}

test('适配器 expectGenesis：启动时连不上 → 之后第一次问到节点前先核对；不是主网 → 锁住（不再发请求）、只告警一次；是主网 → 只核对一次', async () => {
  const s = switchable('down');
  const mismatches = [];
  const a = createTronAdapter({ base: s.base, fetchImpl: s.fetchImpl, usdt: randomTron(), sleep: async () => {}, expectGenesis: TRON_GENESIS.mainnet, onGenesisMismatch: (g) => mismatches.push(g) });
  await assert.rejects(a.head(), (e) => e.code === 'rpc_unreachable', '连不上：这次照常失败');
  assert.equal(a.networkState(), 'unverified');
  s.st.mode = TRON_GENESIS.nile;
  s.st.calls.length = 0;
  await assert.rejects(a.head(), (e) => e.code === 'tron_node_not_mainnet');
  assert.deepEqual(s.st.calls, ['/wallet/getblockbynum'], '只问了创世块，没有发真正的请求');
  await assert.rejects(a.transfers({ cursor: '1', addresses: [randomTron()] }), (e) => e.code === 'tron_node_not_mainnet');
  assert.equal(s.st.calls.length, 1, '锁住之后一个请求都不发');
  assert.equal(a.networkState(), 'wrong');
  assert.deepEqual(mismatches, [TRON_GENESIS.nile], '只告警一次');

  const ok = switchable(TRON_GENESIS.mainnet);
  const b = createTronAdapter({ base: ok.base, fetchImpl: ok.fetchImpl, usdt: randomTron(), sleep: async () => {}, expectGenesis: TRON_GENESIS.mainnet });
  await Promise.all([b.head(), b.head(), b.head()]);
  await b.head();
  assert.equal(ok.st.calls.filter((p) => p === '/wallet/getblockbynum').length, 1, '并发也只核对一次');
  assert.equal(b.networkState(), 'ok');

  const bad = switchable('garbage');
  const c = createTronAdapter({ base: bad.base, fetchImpl: bad.fetchImpl, usdt: randomTron(), sleep: async () => {}, expectGenesis: TRON_GENESIS.mainnet });
  await assert.rejects(c.head(), (e) => e.code === 'tron_node_not_mainnet', '答了但不是创世块：当作不是主网');
});

test('生产启动核对：节点答了但答的不是创世块 → 拒绝启动（不是当作连不上）；测试网核对同样记住不认', async () => {
  const bad = switchable('garbage');
  const a = createTronAdapter({ base: bad.base, fetchImpl: bad.fetchImpl, usdt: randomTron(), sleep: async () => {} });
  await assert.rejects(a.genesisBlockId(), (e) => e.code === 'genesis_invalid');
  await assert.rejects(checkTronMainnet({ tron_node: a }), (e) => e.code === 'tron_node_not_mainnet');
  const g = createTronGrid({ network: 'mainnet', sleep: async () => {}, qps: 1000, fetchImpl: async () => new Response('<html>proxy</html>', { status: 200 }) });
  await assert.rejects(checkTronMainnet({ trongrid: g }), (e) => e.code === 'tron_node_not_mainnet', '不是 JSON（例如被代理页面拦了）也拒绝');
  const g404 = createTronGrid({ network: 'mainnet', sleep: async () => {}, qps: 1000, fetchImpl: async () => new Response('nope', { status: 404 }) });
  await assert.rejects(checkTronMainnet({ trongrid: g404 }), (e) => e.code === 'tron_node_not_mainnet', '404 也拒绝');
  const busy = createTronGrid({ network: 'mainnet', sleep: async () => {}, qps: 1000, fetchImpl: async () => new Response('busy', { status: 503 }) });
  assert.deepEqual(await checkTronMainnet({ trongrid: busy }), { trongrid: 'unreachable' }, '503 一直繁忙：当作连不上，不拒绝');
  const unauth = createTronGrid({ network: 'mainnet', sleep: async () => {}, qps: 1000, fetchImpl: async () => new Response('bad key', { status: 401 }) });
  assert.deepEqual(await checkTronMainnet({ trongrid: unauth }), { trongrid: 'unreachable' }, '401（Key 不对）：核对不了，不拒绝（适配器之后再核对）');
  let mode = 'garbage';
  const check = createTestnetCheck({ tron: { genesisBlockId: async () => { if (mode === 'garbage') throw Object.assign(new Error('x'), { code: 'genesis_invalid' }); return mode; } } });
  assert.equal(await check(), false);
  mode = TRON_GENESIS.nile;
  assert.equal(await check(), false, '答的不是创世块：记住不认');
});

test('钱包层（生产）：TRON 节点不是主网 → 停用 TRON 合约钱包（从开通列表拿掉）并发一封邮件', async () => {
  const { createWalletLayer } = await import('../server/wallet/index.js');
  const { scheme, usdt } = tronScheme();
  const db = await setupDb({ customers: [] });
  const s = switchable('down');
  const mails = [];
  const config = loadConfig({ APP_ENV: 'production', TRON_NETWORK: 'mainnet', TRON_NODE_URL: 'https://tron-node.dev.invalid' });
  const layer = createWalletLayer({ db, config, evm: {}, tron: { ...scheme, usdt }, tronFetch: s.fetchImpl, notify: async (subject) => { mails.push(subject); } });
  assert.ok(layer.enabledChains.includes('tron'), `前提：TRON 开通 ${JSON.stringify(layer.errors)}`);
  await assert.rejects(layer.adapters.tron.head());
  assert.ok(layer.enabledChains.includes('tron'), '连不上：不停用');
  s.st.mode = TRON_GENESIS.nile;
  await assert.rejects(layer.adapters.tron.head(), (e) => e.code === 'tron_node_not_mainnet');
  await assert.rejects(layer.adapters.tron.head(), (e) => e.code === 'tron_node_not_mainnet');
  assert.ok(!layer.enabledChains.includes('tron'), '不是主网：TRON 合约钱包停用');
  assert.equal(layer.errors.tron, 'tron_node_not_mainnet');
  await new Promise((r) => setImmediate(r));
  assert.equal(mails.length, 1, `只发一封：${mails}`);
  assert.match(mails[0], /TRON 节点不是主网/);
  // 测试环境不核对主网
  const staging = createWalletLayer({ db, config: loadConfig({ APP_ENV: 'staging', TRON_NETWORK: 'nile', TRON_NODE_URL: 'https://tron-node.dev.invalid' }), evm: {}, tron: { ...scheme, usdt }, tronFetch: s.fetchImpl });
  assert.equal(staging.adapters.tron.networkState(), 'ok');
  await db.end?.();
});

test('老 TRON 归集：第 1 步广播回 DUP_TRANSACTION_ERROR（重试前节点其实已经收到）→ 按已广播处理，后面照常走完、账本链上余额减掉', async () => {
  const U = 1_000_000;
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'));
  const HOT_KEY = hex.decode('11'.repeat(32));
  const HOT = addressOfPrivateKey(HOT_KEY);
  const COLD = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  const db = await createTestDb(); await migrate(db);
  await core.setMeta(db, 'xpub', root.derive("m/44'/195'/0'").publicExtendedKey);
  const tron = createFakeTron();
  await core.createMerchant(db, { id: 'm1', name: 'Acme', feeIn: { ppm: 10_000, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 2 * U, min: 0 } });
  // 第一次广播：节点收下了，但调用方收到的是 DUP（503 重试后的回应）
  const realBroadcast = tron.broadcastHex.bind(tron);
  let dupOnce = true;
  tron.broadcastHex = async (h) => { const id = await realBroadcast(h); if (dupOnce) { dupOnce = false; throw Object.assign(new Error('broadcast_failed DUP_TRANSACTION_ERROR'), { code: 'DUP_TRANSACTION_ERROR' }); } return id; };
  const api = createWalletApi({ db, tron, keys: derivePayKeys('test-app-secret-test-app-secret-0123456789'), wallets: { hot: HOT, cold: COLD }, requireAdmin: async () => {}, verifyAdminCode: async () => true });
  const call = async (a, body) => { const res = await api(new Request(`https://x/api/wallet/?a=${a}`, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'x-topup-csrf': '1' } })); return { status: res.status, body: await res.json() }; };
  const c = await legacyTronCustomer(db, 'm1', 'dup1');
  await core.recordDeposit(db, { txid: 'd1'.padEnd(64, '0'), logIndex: 0, block: 1, to: c.address, amount: 100 * U, time: new Date() });
  tron.accounts.set(c.address, { activated: true, trx: 0, trc20: { [tron.contract]: 100 * U } });
  tron.accounts.set(HOT, { activated: true, trx: 1000 * U, trc20: {} });
  const plan = (await call('sweep-plan', { addresses: [c.address], to: 'hot' })).body;
  assert.ok(plan.batch_id, JSON.stringify(plan));
  const sigs = {};
  for (const it of plan.items) for (const s of it.steps) sigs[s.txID] = signTxId(s.txID, s.kind === 'sweep_usdt' ? root.derive(`m/44'/195'/0'/0/${it.index}`).privateKey : HOT_KEY);
  await call('sign-verify', { batch_id: plan.batch_id, code: '123456' });
  const sub = await call('sign-submit', { batch_id: plan.batch_id, signatures: sigs });
  assert.equal(sub.body.status, 'stage1');
  assert.deepEqual(sub.body.items.map((i) => i.error), [null], 'DUP 不算失败');
  const confirmAll = () => { for (const d of tron.broadcasts) if (!tron.txs.get(d.txId)?.ok) tron.confirm(d.txId, true); };
  for (let i = 0; i < 4; i++) { confirmAll(); await sweepProgress(db, tron); }
  const [bt] = await db.query('select status from sign_batches');
  assert.equal(bt.status, 'done');
  const [row] = await db.query('select onchain from customers where customer_id = $1', ['dup1']);
  assert.equal(row.onchain, 0, '归集成功：账本上的链上余额减掉');
  await db.end?.();
});
