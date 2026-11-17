// 测试先写（测试经理）：上线前清理 P1 —— 运营后台碰链上节点的动作出错时给 503 和中文提示（不是 500）、商户编号、页面过期提示。
// 开发不要改这个文件，有异议找测试经理改测试。
//
// 这里定下的约定（接口；开发按这个做）：
//   一、节点出错的统一口径（K-13）：/api/wallet/ 里每个会问链上节点的动作，节点出错时：
//      - 限流 / 繁忙（HTTP 429、503，重试后仍失败；TRON 适配器、老 TronGrid 客户端、以太坊 / BSC 的 RPC 都一样）→ 503 { error.code: 'node_busy' }
//      - 连不上、超时、其他 HTTP 错误、返回的不是 JSON → 503 { error.code: 'rpc_unreachable' }
//      - TRON 节点回了 JSON 但带 Error（TronNodeError code 'rpc_error'）→ 502 { error.code: 'node_error' }（节点明确报错，不是"服务器出错了"）
//      - 归集确认（wallet-sweep-approve）保留现有的 sweep_not_sent 502（钱没动）；只读页面（系统状态、归集页、钱包设置、打款审核的凑批卡片）
//        节点出错时照常 200、那一格写"查不到"
//      - 返回里不出现节点地址、API Key、接口路径
//      - nodeFailure（server/wallet/admin-actions.js）：TronNodeError code rpc_error → PayError('node_error', 502)
//      - 老 TRON 打款"核对并签名"（withdraw-plan）建交易途中节点出错：不留下没签名的批次，单仍是"已审核、没凑批"
//      - 页面：admin-pay-real.ts 的 ERR、admin-wallet.ts 的 ERR 里 node_busy、rpc_unreachable、node_error 都有中文说明（admin-payout.ts 走 admin-pay-real.ts 的 errText）
//      动作清单（会问节点的）：
//        老 TRON（server/pay/wallet-api.js，TronGrid）：withdraw-plan、sweep-plan、recon-run（每日任务）、status、wallet、sweep-list、withdrawals、overview-chain
//        合约钱包（server/wallet/admin-actions.js）：wallet-sweep-propose（已有测试）、wallet-sweep-approve、wallet-chains、wallet-sweep、wallet-sweep-batch
//        批量打款（server/pay/payout-admin.js，以太坊 / BSC）：payout-plan、payout-resume、allowance-plan、payout-void-confirmed、payout-overview、payout-plans、payout-wallets
//   二、商户编号（K-1）：打款审核里"已审核待凑批"的单（payout-overview 的 approved[]）、签名批次明细（payout-tx-batch 的 withdrawals[]）也带 merchant_id
//      （商户列表 merchants[].id、待审核 singles / groups 的 merchant_id 已经有）。页面显示见 e2e/tests/qa-p1.spec.ts。
//   三、页面过期（K-3）：
//      - 页面构建时记下提交号：admin 页的 #admin-root 带 data-build="<构建时的 GIT_COMMIT>"（Dockerfile 的页面构建阶段要拿到 GIT_COMMIT）
//      - 页面每次调 /api/wallet/ 都带请求头 X-TopUP-Build: <data-build>（空的不带）
//      - 服务器（server/web.js 的 /api/wallet/）：请求头有值、服务器的 GIT_COMMIT 有值、两者不同 → 409 { error.code: 'stale_page' }，
//        在登录检查之前判断（登录过期的旧页面也先提示刷新）；GET、POST 都一样；请求头没有或服务器没有 GIT_COMMIT → 照旧
//      - 页面 ERR 里 stale_page 的说明含"请刷新页面"
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { createTestDb } from '../server/pay/db.js';
import { migrate } from '../server/pay/schema.js';
import * as core from '../server/pay/core.js';
import { createWalletApi } from '../server/pay/wallet-api.js';
import { derivePayKeys } from '../server/pay/common.js';
import { createTronGrid } from '../server/pay/trongrid.js';
import { createTronAdapter, TronNodeError } from '../server/wallet/adapters/tron.js';
import { createEvmAdapter } from '../server/wallet/adapters/evm.js';
import { toChecksumAddress } from '../server/wallet/create2.js';
import { setupDb, fakeEvm } from './wallet-helpers.js';
import { fakeTronNode, tronScheme, testOperator, randomTron } from './tron-helpers.js';
import { loadConfig } from '../server/config.js';

const U = 1_000_000;
const KEY = 'k3y-should-not-leak';
const SECRET = 'test-app-secret-test-app-secret-0123456789';
const HOT = 'TCLBgkbfVkJroVBJVqBEsxtPNQEQMTQCLQ';
const COLD = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const PAYEE = 'TJ1c1YU6Jq3orqQ8mPGkpXt1TTNC3EBK7Q';
const quietly = async (fn) => { const s = { log: console.log, warn: console.warn, error: console.error }; console.log = console.warn = console.error = () => {}; try { return await fn(); } finally { Object.assign(console, s); } };
const NO_LEAK = (body) => { const t = JSON.stringify(body); assert.ok(!t.includes(KEY) && !/example\.invalid|trongrid\.io|\/wallet\/|\/v1\//.test(t), `返回里不能有节点地址、Key、接口路径：${t}`); };

/** 老 TronGrid 节点替身：mode = ok / 429 / down / notjson；okPaths 里的路径照常回应（其余按 mode） */
function legacyNode() {
  const st = { mode: 'ok', okPaths: [] };
  const ok = (path, body) => {
    if (path.startsWith('/v1/accounts/')) return { data: [{ balance: 50 * U, trc20: [] }] };
    if (path === '/wallet/triggerconstantcontract') return { result: { result: true }, constant_result: ['0'.repeat(56) + '3b9aca00'] }; // 1,000 USDT
    if (path === '/walletsolidity/getnowblock') return { block_header: { raw_data: { number: 100, timestamp: Date.now() } } };
    if (path === '/wallet/getaccountresource') return { EnergyLimit: 0, EnergyUsed: 0, TotalEnergyLimit: 1, TotalEnergyWeight: 1 };
    if (path === '/wallet/getcandelegatedmaxsize') return { max_size: 0 };
    if (path === '/wallet/getchainparameters') return { chainParameter: [{ key: 'getEnergyFee', value: 210 }] };
    return {};
  };
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname.replace(/^\/k3y-should-not-leak/, '');
    const mode = st.okPaths.some((p) => path.startsWith(p)) ? 'ok' : st.mode;
    if (mode === 'down') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (mode === '429') return new Response('Too Many Requests', { status: 429 });
    if (mode === 'notjson') return new Response('<html>bad gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    return Response.json(ok(path, init.body ? JSON.parse(init.body) : {}));
  };
  return { st, fetchImpl };
}

async function legacySetup() {
  const db = await createTestDb(); await migrate(db);
  const node = legacyNode();
  const tron = createTronGrid({ network: 'nile', base: 'https://grid.example.invalid/' + KEY, apiKey: KEY, fetchImpl: node.fetchImpl, sleep: async () => {}, qps: 1000 });
  await core.createMerchant(db, { id: 'm1', name: 'Acme', feeIn: { ppm: 0, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 1 * U, min: 0 } });
  await db.query('update balances set available = available + $1', [1000 * U]);
  const { runDaily } = await import('../server/pay/daily.js');
  const api = createWalletApi({ db, tron, keys: derivePayKeys(SECRET), wallets: { hot: HOT, cold: COLD }, requireAdmin: async () => ({ testAdmin: false }), verifyAdminCode: async () => true,
    runDaily: () => runDaily({ db, tron, wallets: { hot: HOT, cold: COLD }, layer: null, notify: null, diskPath: '/' }) });
  const call = async (a, body, qs = '') => {
    const res = await quietly(() => api(new Request(`https://x/api/wallet/?a=${a}${qs}`, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'x-topup-csrf': '1' } })));
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { db, node, call };
}

const expectCode = (r, status, code, label) => {
  assert.equal(r.status, status, `${label}：要 ${status} ${code}（不是 500"服务器出错了"），现在 ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body?.error?.code, code, label);
  NO_LEAK(r.body);
};

// ---------- 一、老 TRON（TronGrid）动作 ----------

test('老 TRON 动作：withdraw-plan、sweep-plan 节点一直 429 → 503 node_busy；连不上 → 503 rpc_unreachable；返回不是 JSON → 503 rpc_unreachable', async () => {
  const s = await legacySetup();
  const w = await core.requestWithdrawal(s.db, await core.getMerchant(s.db, 'm1'), { kind: 'payout', chain: 'tron', to: PAYEE, amount: 10 * U, source: 'web' });
  assert.equal((await s.call('payout-approve', { ids: [w.withdrawal_no] })).status, 200, '前提：审核通过');
  const addr = randomTron();
  await s.db.query(`insert into customers (merchant_id, customer_id, address, hd_index, onchain) values ('m1', 'c1', $1, 0, $2)`, [addr, 50 * U]);
  for (const [mode, code] of [['429', 'node_busy'], ['down', 'rpc_unreachable'], ['notjson', 'rpc_unreachable']]) {
    s.node.st.mode = mode;
    expectCode(await s.call('withdraw-plan', { ids: [w.withdrawal_no] }), 503, code, `withdraw-plan（${mode}）`);
    expectCode(await s.call('sweep-plan', { addresses: [addr], to: 'hot' }), 503, code, `sweep-plan（${mode}）`);
  }
  await s.db.end?.();
});

test('老 TRON 打款"核对并签名"（withdraw-plan）：查完余额、建交易时节点 429 → 503 node_busy；不留下没签名的批次，单仍是已审核、没凑批', async () => {
  const s = await legacySetup();
  const w = await core.requestWithdrawal(s.db, await core.getMerchant(s.db, 'm1'), { kind: 'payout', chain: 'tron', to: PAYEE, amount: 10 * U, source: 'web' });
  await s.call('payout-approve', { ids: [w.withdrawal_no] });
  s.node.st.mode = '429';
  s.node.st.okPaths = ['/v1/accounts/', '/wallet/triggerconstantcontract']; // 余额查得到，建交易（triggersmartcontract）一直 429
  expectCode(await s.call('withdraw-plan', { ids: [w.withdrawal_no] }), 503, 'node_busy', 'withdraw-plan 建交易时 429');
  const [row] = await s.db.query('select status, batch_id from withdrawals where id = $1', [w.withdrawal_no]);
  assert.deepEqual([row.status, row.batch_id], ['approved', null], `单回到已审核、没凑批（现在 ${row.status} / ${row.batch_id}）`);
  const planned = await s.db.query(`select id from payout_tx_batches where status = 'planned'`);
  assert.equal(planned.length, 0, '不留下没签名的批次');
  await s.db.end?.();
});

test('老 TRON 只读动作：status、wallet、sweep-list、withdrawals、overview-chain 节点 429 / 连不上照常 200；recon-run 不是 500（节点出错时 503 node_busy / rpc_unreachable 或照常完成）', async () => {
  const s = await legacySetup();
  for (const mode of ['429', 'down']) {
    s.node.st.mode = mode;
    for (const a of ['status', 'wallet', 'sweep-list', 'withdrawals', 'overview-chain']) {
      const r = await s.call(a);
      assert.equal(r.status, 200, `${a}（${mode}）：只读页面照常打开，现在 ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    }
    const r = await s.call('recon-run', {});
    assert.ok(r.status === 200 || (r.status === 503 && ['node_busy', 'rpc_unreachable'].includes(r.body?.error?.code)), `recon-run（${mode}）：${r.status} ${JSON.stringify(r.body)}`);
    NO_LEAK(r.body);
  }
  await s.db.end?.();
});

// ---------- 二、合约钱包（TRON 适配器）动作 ----------

async function tronLayer() {
  const { createContractProvider } = await import('../server/wallet/providers/contract.js');
  const { addressFor } = await import('../server/wallet/addresses.js');
  const { walletAdminActions } = await import('../server/wallet/admin-actions.js');
  const { proposeSweep } = await import('../server/wallet/sweep.js');
  const { scheme, usdt } = tronScheme();
  const operator = testOperator();
  const node = fakeTronNode({ head: 1000, scheme, usdt });
  node.activate(operator.address, 5_000_000_000);
  const st = { mode: 'ok' };
  const fetchImpl = async (url, init) => {
    if (st.mode === 'down') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (st.mode === '429') return new Response('Too Many Requests', { status: 429 });
    if (st.mode === 'error') return Response.json({ Error: 'class org.tron.core.exception.SomethingException : fake' });
    return node.fetchImpl(url, init);
  };
  const db = await setupDb({ customers: [['m1', 'c1'], ['m1', 'c2']] });
  const adapter = createTronAdapter({ base: node.base, fetchImpl, usdt, confirmations: 19, timeoutMs: 2000, sleep: async () => {} });
  const providers = { contract: createContractProvider({ db, chains: { tron: { adapter, scheme, usdt } }, tronOperatorKey: operator.key }) };
  for (const c of ['c1', 'c2']) {
    const { address } = await addressFor(db, { merchantId: 'm1', customerId: c, chain: 'tron', providers });
    const tx = node.transfer({ to: address, amount: 300_000_000n, block: node.state.head });
    await core.recordDeposit(db, { chain: 'tron', txid: tx.txid, logIndex: 0, block: tx.block, time: Date.now(), from: randomTron(), to: address, amount: 300_000_000, rawAmount: '300000000' });
  }
  const [batch] = await proposeSweep(db, { chain: 'tron', providers, notify: async () => {} });
  const layer = { enabledChains: ['tron'], providers, adapters: { tron: adapter }, config: { tron: { rpcUrl: node.base, usdt, scheme, confirmations: 19 } }, onchain: {}, errors: {} };
  const api = createWalletApi({ db, tron: createTronGrid({ network: 'nile', fetchImpl: legacyNode().fetchImpl, sleep: async () => {} }), keys: derivePayKeys(SECRET), wallets: { hot: '', cold: '' },
    requireAdmin: async () => ({ testAdmin: false }), verifyAdminCode: async () => true, layer, notify: async () => {}, origin: 'https://admin.example' });
  const call = async (a, body, qs = '') => {
    const res = await quietly(() => api(new Request(`https://x/api/wallet/?a=${a}${qs}`, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'x-topup-csrf': '1' } })));
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { db, st, call, batch, walletAdminActions };
}

test('合约钱包动作（TRON）：节点 429 / 连不上 / 回 Error 时 wallet-chains、wallet-sweep、wallet-sweep-batch 照常 200；wallet-sweep-approve 不是 500（sweep_not_sent 502 或 node_busy / rpc_unreachable 503，批次仍待确认）', async () => {
  const t = await tronLayer();
  assert.ok(t.batch, '前提：凑出了一批');
  for (const mode of ['429', 'down', 'error']) {
    t.st.mode = mode;
    for (const [a, qs] of [['wallet-chains', ''], ['wallet-sweep', ''], ['wallet-sweep-batch', `&id=${t.batch.id}`]]) {
      const r = await t.call(a, undefined, qs);
      assert.equal(r.status, 200, `${a}（${mode}）：现在 ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    }
    const r = await t.call('wallet-sweep-approve', { id: t.batch.id, reason: '例行归集' });
    assert.ok([502, 503].includes(r.status) && ['sweep_not_sent', 'node_busy', 'rpc_unreachable', 'node_error'].includes(r.body?.error?.code), `wallet-sweep-approve（${mode}）：${r.status} ${JSON.stringify(r.body)}`);
    NO_LEAK(r.body);
    const [b] = await t.db.query('select status from wallet_sweep_batches where id = $1', [t.batch.id]);
    assert.equal(b.status, 'awaiting_approval', `${mode}：批次仍是待确认`);
  }
  await t.db.end?.();
});

test('现在就凑一批（TRON）：节点回 JSON Error（TronNodeError rpc_error）→ 502 node_error（不是 500）；nodeFailure 的口径：rpc_error → node_error 502、429 → node_busy、不是 JSON → rpc_unreachable', async () => {
  const { nodeFailure } = await import('../server/wallet/admin-actions.js');
  const { PayError } = core;
  const m = (e) => { const x = nodeFailure(e); return x instanceof PayError ? [x.code, x.status] : ['not PayError', x?.code]; };
  assert.deepEqual(m(new TronNodeError('tron: x: class org.tron.core.exception', { code: 'rpc_error' })), ['node_error', 502], '节点明确报错：node_error 502');
  assert.deepEqual(m(new TronNodeError('tron: HTTP 429', { code: 'rpc_http', httpStatus: 429 })), ['node_busy', 503]);
  assert.deepEqual(m(new TronNodeError('tron: invalid JSON', { code: 'rpc_http' })), ['rpc_unreachable', 503], '不是 JSON：rpc_unreachable');
  assert.deepEqual(m(Object.assign(new Error('evm: HTTP 429'), { code: 'rpc_http', httpStatus: 429 })), ['node_busy', 503], '以太坊 / BSC 的 429 同样');
  const t = await tronLayer();
  await t.db.query(`update wallet_sweep_batches set status = 'cancelled'`); // 让"现在就凑一批"真的去问节点
  t.st.mode = 'error';
  const r = await t.call('wallet-sweep-propose', { chain: 'tron' });
  expectCode(r, 502, 'node_error', 'wallet-sweep-propose（节点回 Error）');
  await t.db.end?.();
});

// ---------- 三、批量打款（以太坊 / BSC） ----------

const hex = (b) => Buffer.from(b).toString('hex');
const rnd = () => toChecksumAddress('0x' + hex(randomBytes(20)));
const keyAddr = (k) => toChecksumAddress('0x' + hex(keccak_256(secp256k1.getPublicKey(k, false).slice(1))).slice(24));
const evmSign = (rawHex, key) => {
  const s = secp256k1.sign(keccak_256(Buffer.from(rawHex.slice(2), 'hex')), key, { lowS: true });
  return '0x' + s.r.toString(16).padStart(64, '0') + s.s.toString(16).padStart(64, '0') + s.recovery.toString(16).padStart(2, '0');
};

async function evmSetup() {
  const f = fakeEvm();
  const ALLOWANCE = 'dd62ed3e';
  const st = { mode: 'ok' };
  const fetchImpl = async (url, init) => {
    if (st.mode === 'down') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (st.mode === '429') return new Response('Too Many Requests', { status: 429 });
    const body = JSON.parse(init.body);
    const one = (x) => (x.method === 'eth_call' && String(x.params?.[0]?.data || '').startsWith('0x' + ALLOWANCE) ? { jsonrpc: '2.0', id: x.id, result: '0x' + (10_000n * BigInt(U)).toString(16).padStart(64, '0') } : null);
    const all = [].concat(body);
    if (all.every(one)) { const out = all.map(one); return new Response(JSON.stringify(Array.isArray(body) ? out : out[0])); }
    return f.fetchImpl(url, init);
  };
  const hotKey = randomBytes(32), hot = keyAddr(hotKey);
  f.state.balances[hot.toLowerCase()] = 10_000n * BigInt(U);
  const token = rnd(), contract = rnd();
  const adapter = createEvmAdapter({ chain: 'eth', rpcUrl: f.rpcUrl, fetchImpl, usdt: token, decimals: 6, confirmations: 0 });
  const db = await setupDb({ customers: [] });
  await db.query('update balances set available = available + $1', [100_000 * U]);
  await db.query(`insert into ledger (merchant_id, type, amount, available_after, frozen_after, ref) values ('m1', 'deposit', $1, $1, 0, 'seed')`, [100_000 * U]);
  const { createPayoutService } = await import('../server/wallet/payout.js');
  const payoutSvc = createPayoutService({ db, chains: { eth: { adapter, chainId: 31337, token, contract, hot, decimals: 6 } }, verifyCode: async () => true });
  const { approvePayouts } = await import('../server/pay/payout.js');
  const m1 = await core.getMerchant(db, 'm1');
  const ids = [];
  for (const a of [10, 20]) ids.push((await core.requestWithdrawal(db, m1, { kind: 'payout', chain: 'eth', to: rnd(), amount: a * U, source: 'web' })).withdrawal_no);
  await approvePayouts(db, { ids, actor: 'admin' });
  const api = createWalletApi({ db, tron: createTronGrid({ network: 'nile', fetchImpl: legacyNode().fetchImpl, sleep: async () => {} }), keys: derivePayKeys(SECRET), wallets: { hot: '', cold: '' },
    requireAdmin: async () => ({ testAdmin: false }), verifyAdminCode: async () => true, payoutSvc, notify: async () => {} });
  const call = async (a, body, qs = '') => {
    const res = await quietly(() => api(new Request(`https://x/api/wallet/?a=${a}${qs}`, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'x-topup-csrf': '1' } })));
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { db, st, call, hotKey, payoutSvc };
}

test('批量打款（以太坊）：payout-plan、allowance-plan 节点 429 → 503 node_busy；连不上 → 503 rpc_unreachable；只读的 payout-overview、payout-plans、payout-wallets 照常 200', async () => {
  const s = await evmSetup();
  for (const [mode, code] of [['429', 'node_busy'], ['down', 'rpc_unreachable']]) {
    s.st.mode = mode;
    expectCode(await s.call('payout-plan', { chain: 'eth' }), 503, code, `payout-plan（${mode}）`);
    expectCode(await s.call('allowance-plan', { chain: 'eth', amount: '5000', reason: '调额度', code: '123456' }), 503, code, `allowance-plan（${mode}）`);
    for (const a of ['payout-overview', 'payout-plans', 'payout-wallets']) {
      const r = await s.call(a);
      assert.equal(r.status, 200, `${a}（${mode}）：${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    }
    const [x] = await s.db.query(`select count(*)::int n from withdrawals where status = 'approved' and batch_id is null`);
    assert.equal(x.n, 2, `${mode}：单仍是已审核、没凑批`);
  }
  await s.db.end?.();
});

test('批量打款（以太坊）：广播后节点 429 → payout-void-confirmed 503 node_busy（不是 rpc_unreachable 一概而论）', async () => {
  const s = await evmSetup();
  const plan = await s.call('payout-plan', { chain: 'eth' });
  assert.equal(plan.status, 200, `前提：凑批成功 ${JSON.stringify(plan.body).slice(0, 200)}`);
  const b = plan.body.batches[0];
  const sub = await s.call('payout-submit', { id: b.id, signature: evmSign(b.rawHex, s.hotKey), code: '123456' });
  assert.equal(sub.status, 200, `前提：交了签名、广播 ${JSON.stringify(sub.body)}`);
  s.st.mode = '429';
  expectCode(await s.call('payout-void-confirmed', { id: b.id, code: '123456' }), 503, 'node_busy', 'payout-void-confirmed（429）');
  s.st.mode = 'down';
  expectCode(await s.call('payout-void-confirmed', { id: b.id, code: '123456' }), 503, 'rpc_unreachable', 'payout-void-confirmed（连不上）');
  await s.db.end?.();
});

// ---------- 页面的中文说明 ----------

test('页面：admin-pay-real.ts、admin-wallet.ts 的 ERR 里 node_busy、rpc_unreachable、node_error 都有中文说明；admin-pay-real.ts 的 stale_page 写"请刷新页面"', () => {
  const read = (f) => readFileSync(new URL(`../site/src/scripts/${f}`, import.meta.url), 'utf8');
  const textOf = (src, code) => (src.match(new RegExp(`\\b${code}\\s*:\\s*'([^']*)'`)) || [])[1];
  for (const f of ['admin-pay-real.ts', 'admin-wallet.ts']) {
    const src = read(f);
    for (const code of ['node_busy', 'rpc_unreachable', 'node_error']) {
      const t = textOf(src, code);
      assert.ok(t, `${f} 的 ERR 里要有 ${code}`);
      assert.match(t, /节点/, `${f} ${code}：说清楚是链上节点的问题：${t}`);
      assert.ok(!/[A-Za-z]{4,}/.test(t.replace(/TRON|TronGrid|USDT/g, '')), `${f} ${code}：给管理员看的是中文：${t}`);
    }
  }
  const stale = textOf(read('admin-pay-real.ts'), 'stale_page');
  assert.ok(stale, 'admin-pay-real.ts 的 ERR 里要有 stale_page');
  assert.match(stale, /请刷新页面/);
});

// ---------- 二、商户编号（K-1）服务器一侧 ----------

test('商户编号：payout-overview 的 approved[]（已审核待凑批）、payout-tx-batch 的 withdrawals[] 带 merchant_id；merchants[].id、待审核 singles 的 merchant_id 照旧', async () => {
  const s = await legacySetup();
  const m1 = await core.getMerchant(s.db, 'm1');
  const w1 = await core.requestWithdrawal(s.db, m1, { kind: 'payout', chain: 'tron', to: PAYEE, amount: 10 * U, source: 'web' });
  const w2 = await core.requestWithdrawal(s.db, m1, { kind: 'payout', chain: 'tron', to: PAYEE, amount: 11 * U, source: 'web' });
  await s.call('payout-approve', { ids: [w1.withdrawal_no] });
  const ov = await s.call('payout-overview');
  assert.equal(ov.status, 200);
  assert.equal(ov.body.singles.find((x) => x.id === w2.withdrawal_no)?.merchant_id, 'm1', '待审核：已有 merchant_id');
  const ap = ov.body.approved.find((x) => x.id === w1.withdrawal_no);
  assert.ok(ap, '已审核待凑批里有这一笔');
  assert.equal(ap.merchant_id, 'm1', `已审核待凑批的单要带 merchant_id：${JSON.stringify(ap)}`);
  const ms = await s.call('merchants');
  assert.equal(ms.body.merchants[0].id, 'm1');
  // 签名批次明细
  const { createPayoutTxBatch } = await import('../server/pay/payout.js');
  const ptId = await createPayoutTxBatch(s.db, { chain: 'tron', ids: [w1.withdrawal_no], actor: 'admin' });
  const d = await s.call('payout-tx-batch', undefined, `&id=${ptId}`);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body.withdrawals[0].merchant_id, 'm1', `签名批次明细的每一笔要带 merchant_id：${JSON.stringify(d.body.withdrawals[0])}`);
  await s.db.end?.();
});

// ---------- 三、页面过期（K-3）服务器一侧 ----------

async function localWeb(commit) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-p1-stale-'));
  const saved = process.env.GIT_COMMIT;
  if (commit === null) delete process.env.GIT_COMMIT; else process.env.GIT_COMMIT = commit;
  const { createWeb } = await import('../server/web.js');
  const web = await quietly(async () => { const w = createWeb(loadConfig({ APP_ENV: 'local', DATA_DIR: dir, APP_SECRET: SECRET }), { site: dir }); await (await w.app).pay; return w; });
  const req = async (method, build, a = 'payout-limits') => {
    const headers = { 'x-topup-csrf': '1', 'content-type': 'application/json', ...(build === undefined ? {} : { 'x-topup-build': build }) };
    const res = await quietly(() => web.handle(new Request(`http://127.0.0.1/api/wallet/?a=${a}`, { method, headers, body: method === 'POST' ? '{}' : undefined })));
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { req, done: async () => { if (saved === undefined) delete process.env.GIT_COMMIT; else process.env.GIT_COMMIT = saved; try { await (await (await web.app).pay).db.end?.(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

test('页面过期：页面带的 X-TopUP-Build 和服务器的 GIT_COMMIT 不同 → 409 stale_page（在登录检查之前；GET、POST 都是）；相同、没带 → 照旧 401 要登录', async () => {
  const A = 'a'.repeat(40), B = 'b'.repeat(40);
  const w = await localWeb(A);
  try {
    for (const method of ['GET', 'POST']) {
      const r = await w.req(method, B, method === 'GET' ? 'payout-limits' : 'payout-approve');
      assert.equal(r.status, 409, `${method}：旧页面（${B.slice(0, 7)}）调新服务器（${A.slice(0, 7)}）要 409，现在 ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body?.error?.code, 'stale_page');
    }
    assert.equal((await w.req('GET', A)).status, 401, '同一个版本：照旧要登录');
    assert.equal((await w.req('GET', undefined)).status, 401, '没带（旧页面、脚本）：照旧');
    assert.equal((await w.req('GET', '')).status, 401, '空的：照旧');
  } finally { await w.done(); }
});

test('页面过期：服务器没有 GIT_COMMIT（本地开发）时不判断', async () => {
  const w = await localWeb(null);
  try { assert.equal((await w.req('GET', 'b'.repeat(40))).status, 401); } finally { await w.done(); }
});

test('页面过期：页面构建时拿得到提交号——Dockerfile 的页面构建阶段有 ARG GIT_COMMIT 并传给 npm run build；admin 页有 data-build', () => {
  const df = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  const siteStage = df.split(/^FROM /m).find((x) => / AS site/.test(x)) || '';
  assert.match(siteStage, /ARG GIT_COMMIT/, '页面构建阶段要有 ARG GIT_COMMIT');
  assert.match(siteStage.split('\n').find((l) => /npm run build/.test(l)) || '', /GIT_COMMIT/, '构建页面时把 GIT_COMMIT 传进去');
  const page = readFileSync(new URL('../site/src/pages/admin/index.astro', import.meta.url), 'utf8');
  assert.match(page, /id="admin-root"[^>]*data-build=/, '#admin-root 带 data-build');
  const js = readFileSync(new URL('../site/src/scripts/admin-pay-real.ts', import.meta.url), 'utf8');
  assert.match(js, /x-topup-build/i, '页面调接口时带 X-TopUP-Build');
});
