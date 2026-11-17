// 测试先写（测试经理）：上线前清理 P1 —— TRON 测试网 / 主网按节点核对，不只看 TRON_NETWORK（K-4）。开发不要改这个文件。
//
// 依据（实际执行，2026-11-17）：向 api.trongrid.io、nile.trongrid.io 发 POST /wallet/getblockbynum {"num":0}，两个创世块的 blockID 是：
//   主网  00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc
//   Nile  0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc
// 这里定下的约定（接口；开发按这个做）：
//   一、server/pay/test-admin.js 导出 TRON_GENESIS = { mainnet, nile }（上面两个值，小写十六进制）。
//   二、TRON 适配器（createTronAdapter）和老 TronGrid 客户端（createTronGrid）都有 genesisBlockId()：POST /wallet/getblockbynum {num: 0}，返回 blockID（小写）；连不上抛出。
//   三、createTestnetCheck(adapters)：adapters 里有 genesisBlockId 的当作 TRON 节点，blockID 必须等于 TRON_GENESIS.nile（不是就记住、一直 false）；
//       有 chainId 的照旧按以太坊 / BSC 测试网白名单；查不到这次 false、下次再查。
//       createPayDeps 把老 TronGrid 客户端和钱包层的 TRON 适配器（有就带上）都交给它：测试管理员、测试商户免 IP 白名单只在"TRON 节点真的是 Nile"时生效。
//   四、生产（APP_ENV=production）：createPayDeps 启动时核对 TRON 节点（老 TronGrid 客户端 + 钱包层的 TRON 适配器，有就核对）——
//       回的创世块不是主网 → 拒绝（createPayDeps 抛错，err.code = 'tron_node_not_mainnet'，说明里不带节点地址和 Key）；
//       连不上 → 不拒绝（照常启动，节点恢复后照常用；不能因为 TronGrid 一时不通就让生产起不来）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeTronNode, randomTron } from './tron-helpers.js';
import { createTronAdapter } from '../server/wallet/adapters/tron.js';
import { createTronGrid } from '../server/pay/trongrid.js';
import { loadConfig } from '../server/config.js';
import { createMemRedis } from '../server/kyb/memredis.js';
import { deriveKeys } from '../server/kyb/crypto.js';

const MAINNET = '00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc';
const NILE = '0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc';
const SHASTA_LIKE = '0000000000000000de1aa88295e1fcf982742f773e0419c5a9c134c994a9059e'; // 别的网（只要不是 Nile / 主网）
const SECRET = 'test-app-secret-test-app-secret-0123456789';
const KEY = 'k3y-should-not-leak';

test('TRON_GENESIS：主网、Nile 的创世块哈希（实测值）', async () => {
  const { TRON_GENESIS } = await import('../server/pay/test-admin.js');
  assert.deepEqual(TRON_GENESIS, { mainnet: MAINNET, nile: NILE });
});

test('genesisBlockId()：TRON 适配器、老 TronGrid 客户端都问 /wallet/getblockbynum {num:0}，返回 blockID（小写）', async () => {
  const node = fakeTronNode({ genesis: NILE });
  const a = createTronAdapter({ base: node.base, fetchImpl: node.fetchImpl, usdt: randomTron(), timeoutMs: 2000, sleep: async () => {} });
  assert.equal(await a.genesisBlockId(), NILE);
  const last = node.calls.at(-1);
  assert.equal(last.path, '/wallet/getblockbynum');
  assert.equal(Number(last.body.num), 0);
  const calls = [];
  const g = createTronGrid({ network: 'mainnet', apiKey: KEY, sleep: async () => {}, fetchImpl: async (url, init) => { calls.push({ path: new URL(url).pathname, body: JSON.parse(init.body || '{}') }); return Response.json({ blockID: MAINNET.toUpperCase() }); } });
  assert.equal(await g.genesisBlockId(), MAINNET, '大写也换成小写');
  assert.deepEqual(calls.map((c) => [c.path, Number(c.body.num)]), [['/wallet/getblockbynum', 0]]);
});

test('createTestnetCheck：TRON 节点（有 genesisBlockId）必须是 Nile；主网 / 别的网 false 并记住；查不到这次 false、下次再查', async () => {
  const { createTestnetCheck } = await import('../server/pay/test-admin.js');
  const tronOf = (v) => ({ genesisBlockId: async () => { if (v === 'down') throw new Error('down'); return v; } });
  assert.equal(await createTestnetCheck({ tron: tronOf(NILE) })(), true);
  assert.equal(await createTestnetCheck({ tron: tronOf(MAINNET) })(), false, 'TRON 节点是主网：不认');
  assert.equal(await createTestnetCheck({ tron: tronOf(SHASTA_LIKE) })(), false, '别的网也不认（白名单，只认 Nile）');
  assert.equal(await createTestnetCheck({ grid: tronOf(NILE), tron: tronOf(MAINNET) })(), false, '任何一个 TRON 节点不是 Nile 就不认');
  assert.equal(await createTestnetCheck({ eth: { chainId: async () => 11155111 }, tron: tronOf(NILE) })(), true, '以太坊 Sepolia + TRON Nile');
  let v = 'down';
  const c = createTestnetCheck({ tron: { genesisBlockId: async () => { if (v === 'down') throw new Error('down'); return v; } } });
  assert.equal(await c(), false, '查不到：这次不认');
  v = NILE;
  assert.equal(await c(), true, '下次再查，是 Nile 就认');
  let w = MAINNET;
  const c2 = createTestnetCheck({ tron: { genesisBlockId: async () => w } });
  assert.equal(await c2(), false);
  w = NILE;
  assert.equal(await c2(), false, '见过一次不是 Nile：记住，一直不认（要重启）');
});

/**
 * 把全局 fetch 换成按主机回应的替身（createPayDeps 里 TronGrid 客户端、TRON 适配器默认用全局 fetch）：
 * hosts：{ 主机名: 创世块哈希 | 'down' }；getblockbynum {num:0} 回 blockID，其余回 {}。没列的主机一律连不上（不连外网）
 */
async function withFakeNet(hosts, fn) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(typeof url === 'string' ? url : url.url);
    seen.push(u.host);
    const g = hosts[u.host];
    if (!g || g === 'down') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    let body = {}; try { body = JSON.parse(init.body || '{}'); } catch {}
    if (u.pathname.endsWith('/wallet/getblockbynum') && Number(body.num) === 0) return Response.json({ blockID: g, block_header: { raw_data: { number: 0 } } });
    return Response.json({});
  };
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await fn(seen); } finally { globalThis.fetch = real; Object.assign(console, saved); }
}

async function deps(env) {
  const { createPayDeps } = await import('../server/pay/deps.js');
  const dir = mkdtempSync(join(tmpdir(), 'qa-p1-net-'));
  const config = loadConfig({ APP_SECRET: SECRET, LOCAL_DB_DIR: join(dir, 'db'), TRONGRID_API_KEY: KEY, ...env });
  try {
    const d = await createPayDeps({ config, kyb: { redis: createMemRedis(), keys: deriveKeys(SECRET) }, send: async () => {}, getIp: () => '', origin: 'https://x.test' });
    return { d, done: async () => { await d.db.end?.(); rmSync(dir, { recursive: true, force: true }); } };
  } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
}

const TOKEN = randomBytes(32).toString('hex');
const HASH = createHash('sha256').update(TOKEN).digest('hex');
const NODE_HOST = 'tron-node.qa.invalid';
const asTestAdmin = async (d) => {
  const res = await d.wallet(new Request('https://x.test/api/wallet/?a=payout-limits', { headers: { 'x-topup-test-admin': TOKEN, 'x-topup-csrf': '1' } }));
  return res.status;
};

test('测试环境（staging + nile + 测试管理员哈希）：TronGrid 和 TRON 节点都回 Nile 创世块 → 测试管理员能用；任何一个是主网 → 401（只看 TRON_NETWORK 不够）', async () => {
  const env = { APP_ENV: 'staging', TRON_NETWORK: 'nile', TEST_ADMIN_TOKEN_SHA256: HASH, TRON_NODE_URL: `https://${NODE_HOST}` };
  for (const [label, hosts, want] of [
    ['都是 Nile', { 'nile.trongrid.io': NILE, [NODE_HOST]: NILE }, 200],
    ['TronGrid 其实是主网', { 'nile.trongrid.io': MAINNET, [NODE_HOST]: NILE }, 401],
    ['TRON 合约钱包节点（TRON_NODE_URL）是主网', { 'nile.trongrid.io': NILE, [NODE_HOST]: MAINNET }, 401],
    ['TRON 节点都连不上（这次不认）', {}, 401],
  ]) {
    await withFakeNet(hosts, async (seen) => {
      const s = await deps(env);
      try {
        assert.equal(await asTestAdmin(s.d), want, `${label}：要 ${want}`);
        if (want === 401 && Object.keys(hosts).length) assert.ok(seen.includes('nile.trongrid.io') || seen.includes(NODE_HOST), `${label}：确实问过 TRON 节点`);
      } finally { await s.done(); }
    });
  }
});

test('生产：TronGrid 回的创世块不是主网 → createPayDeps 拒绝（code tron_node_not_mainnet，说明里不带 Key 和节点地址）；是主网 → 照常；连不上 → 不拒绝', async () => {
  const env = { APP_ENV: 'production', TRON_NETWORK: 'mainnet' };
  await withFakeNet({ 'api.trongrid.io': NILE }, async () => {
    let err;
    try { const s = await deps(env); await s.done(); } catch (e) { err = e; }
    assert.ok(err, '生产连到了 Nile 的节点：要拒绝');
    assert.equal(err.code, 'tron_node_not_mainnet', `err.code：${err.code} ${err.message}`);
    assert.ok(!String(err.message).includes(KEY) && !String(err.message).includes('trongrid.io'), `说明里不带 Key 和节点地址：${err.message}`);
  });
  await withFakeNet({ 'api.trongrid.io': MAINNET }, async (seen) => {
    const s = await deps(env);
    await s.done();
    assert.ok(seen.includes('api.trongrid.io'), '启动时确实问过节点的创世块');
  });
  await withFakeNet({}, async () => {
    const s = await deps(env); // 连不上：不拒绝
    await s.done();
  });
});
