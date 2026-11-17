// 测试先写（第 2 批）：TRON 链上合约参数核对（和第 1 批 ETH / BSC 同一个规则，K2）。
//   - 启动时和看系统状态时，用只读调用（/wallet/triggerconstantcontract）核对：批量合约.parent() = parent、批量合约.factory() = factory、
//     工厂.implementationAddress() = implementation（config/wallets.json 的 tron 一节）
//   - 只有拿到结果、且结果是空的或地址对不上，才判不一致（mismatch）；节点报"不是合约"（CONTRACT_VALIDATE_ERROR）等同空结果，也判不一致→ 停用 TRON（不分配地址、不凑批、不扫块），发告警邮件一次；
//     节点连不上、超时、限流（429）、5xx、其他节点报错（result.result = false 且不是 CONTRACT_VALIDATE_ERROR）都只算"还没核对上"（unverified），下一轮再核对，不停用
//   - 配置：环境变量 SWEEP_OPERATOR_KEY_TRON（TRON 归集发起账户，只在服务器 .env）、TRON_NODE_URL（可选，默认按 TRON_NETWORK 用 TronGrid）、
//     TRON_CONFIRMATIONS（默认 19）；config/wallets.json 的 production、staging 各有 tron 一节（空着的不开通，填写走 PR，由管理员合并）
// 要实现的模块：server/wallet/verify-onchain.js（verifyChain 认得 TRON 适配器）、server/wallet/index.js、server/config.js、config/wallets.json、.env.example
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeTronNode, tronScheme, randomTron } from './tron-helpers.js';
import { setupDb } from './wallet-helpers.js';

async function adapterFor(nodeState = {}) {
  const { createTronAdapter } = await import('../server/wallet/adapters/tron.js');
  const { scheme, usdt } = tronScheme();
  const node = fakeTronNode({ scheme, usdt, ...nodeState });
  return { node, scheme, usdt, adapter: createTronAdapter({ base: node.base, fetchImpl: node.fetchImpl, usdt, confirmations: 19, timeoutMs: 1000 }) };
}

test('TRON 链上核对：一致 ok；parent / factory / implementation 哪一项对不上就列出哪一项（mismatch）；结果为空也算不一致', async () => {
  const { verifyChain } = await import('../server/wallet/verify-onchain.js');
  const ok = await adapterFor();
  assert.deepEqual(await verifyChain(ok.adapter, ok.scheme), { result: 'ok' });
  for (const field of ['parent', 'factory', 'implementation']) {
    const t = await adapterFor();
    t.node.state.onchain = { parent: t.scheme.parent, factory: t.scheme.factory, implementation: t.scheme.implementation, [field]: randomTron() };
    const r = await verifyChain(t.adapter, t.scheme);
    assert.equal(r.result, 'mismatch', field);
    assert.deepEqual(r.fields, [field]);
  }
  const empty = await adapterFor();
  empty.node.state.onchain = { parent: '', factory: empty.scheme.factory, implementation: empty.scheme.implementation };
  const r = await verifyChain(empty.adapter, empty.scheme);
  assert.equal(r.result, 'mismatch');
  assert.deepEqual(r.fields, ['parent']);
});

test('TRON 链上核对：节点连不上、429 限流、500、其他节点报错（result.result = false，不是 CONTRACT_VALIDATE_ERROR）→ unverified，不判不一致', async () => {
  const { verifyChain } = await import('../server/wallet/verify-onchain.js');
  for (const bad of [{ down: true }, { httpStatus: 429 }, { httpStatus: 500 }, { constantError: 'SERVER_BUSY' }, { constantError: 'OTHER_ERROR' }]) {
    const t = await adapterFor(bad);
    assert.equal((await verifyChain(t.adapter, t.scheme)).result, 'unverified', JSON.stringify(bad));
  }
});

test('TRON 链上核对：节点报"不是合约"（CONTRACT_VALIDATE_ERROR）等同空结果 → 不一致（mismatch）：批量合约不是合约 → parent、factory；工厂不是合约 → implementation', async () => {
  const { verifyChain } = await import('../server/wallet/verify-onchain.js');
  const b = await adapterFor();
  b.node.state.notContract = [b.scheme.batcher];
  const rb = await verifyChain(b.adapter, b.scheme);
  assert.equal(rb.result, 'mismatch');
  assert.deepEqual([...rb.fields].sort(), ['factory', 'parent']);
  const f = await adapterFor();
  f.node.state.notContract = [f.scheme.factory];
  const rf = await verifyChain(f.adapter, f.scheme);
  assert.equal(rf.result, 'mismatch');
  assert.deepEqual(rf.fields, ['implementation']);
});

/** 真的钱包层（和服务器启动时同一条路径），TRON 节点是本机起的替身 HTTP 服务 */
async function realLayer({ onchain, down = false } = {}) {
  const { createWalletLayer } = await import('../server/wallet/index.js');
  const { scheme, usdt } = tronScheme();
  const node = fakeTronNode({ scheme, usdt, down });
  if (onchain) node.state.onchain = onchain(scheme);
  const srv = await node.listen();
  const db = await setupDb({ customers: [['m1', 'c1']] });
  const config = { appEnv: 'staging', fakeEvm: false, fakeTron: false, ethRpcUrl: '', bscRpcUrl: '', tronNetwork: 'nile', tronApiKey: '', tronNodeUrl: srv.url, tronConfirmations: 1, sweepOperatorKey: '', sweepOperatorKeyTron: '' };
  const layer = createWalletLayer({ db, config, evm: {}, tron: { ...scheme, usdt } });
  return { layer, node, srv, db, scheme };
}

test('钱包层：TRON 链上参数不一致 → 停用 TRON（enabledChains 去掉、提供方不再给 TRON 地址），告警邮件一次，写明对不上的字段和要核对 config/wallets.json 的 tron', async () => {
  const t = await realLayer({ onchain: (s) => ({ parent: randomTron(), factory: s.factory, implementation: s.implementation }) });
  try {
    assert.ok(t.layer.enabledChains.includes('tron'), `配置齐全时先开通：${JSON.stringify(t.layer.errors)}`);
    const mails = [];
    const notify = async (s, x) => mails.push([s, x]);
    await t.layer.verifyOnchain({ db: t.db, notify });
    assert.equal(t.layer.onchain.tron?.result, 'mismatch');
    assert.ok(!t.layer.enabledChains.includes('tron'));
    await assert.rejects(t.layer.providers.contract.allocateAddress({ merchantId: 'm1', customerId: 'c1', chain: 'tron' }), (e) => e.code === 'chain_not_enabled');
    await t.layer.verifyOnchain({ db: t.db, notify });
    assert.equal(mails.length, 1, '只发一次');
    assert.match(mails[0][0], /TRON/);
    assert.match(mails[0][1], /parent/);
    assert.match(mails[0][1], /config\/wallets\.json/);
    assert.match(mails[0][1], /tron/);
  } finally { await t.srv.close(); await t.db.end?.(); }
});

test('钱包层：TRON 节点连不上 → unverified，不停用、不发"不一致"邮件；节点恢复后下一轮核对 ok', async () => {
  const t = await realLayer({ down: true });
  try {
    const mails = [];
    const notify = async (s, x) => mails.push([s, x]);
    await t.layer.verifyOnchain({ db: t.db, notify, timeoutMs: 2000 });
    assert.equal(t.layer.onchain.tron?.result, 'unverified');
    assert.ok(t.layer.enabledChains.includes('tron'));
    assert.equal(mails.filter(([s]) => /不一致/.test(s)).length, 0);
    t.node.state.down = false;
    await t.layer.verifyOnchain({ db: t.db, notify, timeoutMs: 2000 });
    assert.equal(t.layer.onchain.tron?.result, 'ok');
    assert.ok(t.layer.enabledChains.includes('tron'));
  } finally { await t.srv.close(); await t.db.end?.(); }
});

test('配置：SWEEP_OPERATOR_KEY_TRON、TRON_NODE_URL、TRON_CONFIRMATIONS（默认 19）；.env.example 只列变量名；config/wallets.json 的 production、staging 各有 tron 一节', async () => {
  const { loadConfig } = await import('../server/config.js');
  const c = loadConfig({ APP_ENV: 'local', SWEEP_OPERATOR_KEY_TRON: 'ab'.repeat(32), TRON_NODE_URL: 'http://127.0.0.1:9090', TRON_CONFIRMATIONS: '3' });
  assert.equal(c.sweepOperatorKeyTron, 'ab'.repeat(32));
  assert.equal(c.tronNodeUrl, 'http://127.0.0.1:9090');
  assert.equal(c.tronConfirmations, 3);
  assert.equal(loadConfig({ APP_ENV: 'local' }).tronConfirmations, 19);
  const env = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(env, /^SWEEP_OPERATOR_KEY_TRON=$/m, '.env.example 只有变量名，没有值');
  const w = JSON.parse(readFileSync(new URL('../config/wallets.json', import.meta.url), 'utf8'));
  for (const envName of ['production', 'staging']) {
    const tr = w[envName].tron;
    assert.ok(tr, `${envName}.tron`);
    for (const k of ['usdt', 'factory', 'implementation', 'parent', 'batcher', 'ver']) assert.ok(k in tr, `${envName}.tron.${k}`);
  }
});
