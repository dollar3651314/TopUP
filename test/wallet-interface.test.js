// 钱包接口层：WalletProvider（钱由谁管）和 ChainAdapter（链怎么读写，只给 contract 用）两层的契约。
// 要实现的模块：server/wallet/provider.js、server/wallet/adapters/evm.js、server/wallet/providers/contract.js
// 节点用替身（test/wallet-helpers.js 的 fakeEvm），不连真实网络；真实链上的流程在 test/anvil/ 里。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeEvm, transferLog, setupDb, TRANSFER_TOPIC, topicOf } from './wallet-helpers.js';

const V = JSON.parse(readFileSync(new URL('./fixtures/wallet/create2-vectors-topup.json', import.meta.url), 'utf8'));
const SCHEME = { ver: 1, factory: V.factory, implementation: V.implementation, parent: V.parents[0], batcher: V.feeAddresses[0] };
const USDT_ETH = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955';
const OUTSIDER = '0x000000000000000000000000000000000000dEaD';

const providerMod = () => import('../server/wallet/provider.js');
const evmMod = () => import('../server/wallet/adapters/evm.js');
const contractMod = () => import('../server/wallet/providers/contract.js');

async function adapter(chain, node, extra = {}) {
  const { createEvmAdapter } = await evmMod();
  return createEvmAdapter({ chain, rpcUrl: node.rpcUrl, fetchImpl: node.fetchImpl, usdt: chain === 'bsc' ? USDT_BSC : USDT_ETH, decimals: chain === 'bsc' ? 18 : 6, confirmations: 12, ...extra });
}

async function contractProvider(db, nodes = {}, extra = {}) {
  const { createContractProvider } = await contractMod();
  const eth = nodes.eth || fakeEvm();
  const bsc = nodes.bsc || fakeEvm();
  return createContractProvider({
    db,
    chains: {
      eth: { adapter: await adapter('eth', eth), scheme: SCHEME, usdt: USDT_ETH },
      bsc: { adapter: await adapter('bsc', bsc), scheme: SCHEME, usdt: USDT_BSC },
    },
    ...extra,
  });
}

// ---------- 统一接口 ----------

test('统一接口：链只有 eth、bsc、tron；提供方只有 contract、cobo、fireblocks', async () => {
  const { CHAINS, PROVIDER_IDS } = await providerMod();
  assert.deepEqual([...CHAINS], ['eth', 'bsc', 'tron']);
  assert.deepEqual([...PROVIDER_IDS], ['contract', 'cobo', 'fireblocks']);
});

test('统一接口：assertProvider 检查方法齐全；自己扫链（scan）和收 Webhook（handleWebhook）二选一，不能都有也不能都没有', async () => {
  const { assertProvider } = await providerMod();
  const fn = async () => {};
  const base = {
    id: 'contract', capabilities: () => ({ batchSweep: true, batchPayout: false, selfScan: true, webhook: false }),
    allocateAddress: fn, planSweep: fn, executeSweep: fn, planPayout: fn, submitPayout: fn, balance: fn, estimateFee: fn, txStatus: fn,
  };
  assert.doesNotThrow(() => assertProvider({ ...base, scan: fn }));
  assert.doesNotThrow(() => assertProvider({ ...base, id: 'cobo', capabilities: () => ({ batchSweep: false, batchPayout: false, selfScan: false, webhook: true }), handleWebhook: fn }));
  assert.throws(() => assertProvider(base), /scan|handleWebhook/); // 两个都没有
  assert.throws(() => assertProvider({ ...base, scan: fn, handleWebhook: fn }), /scan|handleWebhook/); // 两个都有
  for (const m of ['allocateAddress', 'planSweep', 'executeSweep', 'balance', 'txStatus', 'estimateFee']) {
    const p = { ...base, scan: fn }; delete p[m];
    assert.throws(() => assertProvider(p), new RegExp(m), `缺 ${m}`);
  }
  assert.throws(() => assertProvider({ ...base, scan: fn, id: 'bitgo' }), /bitgo|id/);
});

test('未开通的提供方（cobo、fireblocks 第一版的空实现）：能力全是 false；任何操作都明确拒绝（provider_not_enabled）；健康状态"未开通"、不告警', async () => {
  const { createUnavailableProvider, assertProvider } = await providerMod();
  for (const id of ['cobo', 'fireblocks']) {
    const p = createUnavailableProvider(id);
    assert.equal(p.id, id);
    assert.equal(p.enabled, false);
    assert.doesNotThrow(() => assertProvider(p));
    for (const chain of ['eth', 'bsc', 'tron']) assert.deepEqual(p.capabilities(chain), { batchSweep: false, batchPayout: false, selfScan: false, webhook: false });
    await assert.rejects(p.allocateAddress({ merchantId: 'm1', customerId: 'c1', chain: 'eth' }), (e) => e.code === 'provider_not_enabled');
    await assert.rejects(p.executeSweep({ chain: 'eth', items: [] }), (e) => e.code === 'provider_not_enabled');
    await assert.rejects(p.balance('eth', { vault: 'hot' }), (e) => e.code === 'provider_not_enabled');
    assert.deepEqual(p.health(), { enabled: false, status: 'not_enabled', alert: false });
  }
});

// ---------- ChainAdapter：evm ----------

test('evm 扫链：只读到"最新区块 − 确认数"为止，从游标的下一块开始；按 USDT 合约、Transfer 事件和 to 主题过滤', async () => {
  const to = V.addresses[0];
  const node = fakeEvm({ head: 100 });
  node.state.logs.push(
    transferLog({ token: USDT_ETH, from: OUTSIDER, to, raw: 150_000_000n, block: 85, txid: '0x' + 'a1'.repeat(32), logIndex: 3 }),
    transferLog({ token: USDT_ETH, from: OUTSIDER, to, raw: 7_000_000n, block: 89, txid: '0x' + 'a2'.repeat(32) }), // 还没够 12 个确认（100 − 12 = 88）
    transferLog({ token: USDT_ETH, from: OUTSIDER, to: OUTSIDER, raw: 1n, block: 86, txid: '0x' + 'a3'.repeat(32) }), // 不是我们的地址
    transferLog({ token: USDT_BSC, from: OUTSIDER, to, raw: 1n, block: 86, txid: '0x' + 'a4'.repeat(32) }), // 别的代币
  );
  const a = await adapter('eth', node);
  const r = await a.transfers({ cursor: '80', addresses: [to] });
  assert.equal(r.next, '88');
  const q = node.calls.filter((c) => c.method === 'eth_getLogs');
  assert.ok(q.length >= 1);
  for (const c of q) {
    const f = c.params[0];
    assert.equal(Number(BigInt(f.fromBlock)) >= 81, true);
    assert.equal(Number(BigInt(f.toBlock)) <= 88, true);
    assert.deepEqual([].concat(f.address).map((x) => x.toLowerCase()), [USDT_ETH.toLowerCase()]);
    assert.equal(f.topics[0], TRANSFER_TOPIC);
    assert.ok([].concat(f.topics[2]).map((x) => x.toLowerCase()).includes(topicOf(to)), 'to 主题里有我们的地址');
  }
  assert.equal(r.deposits.length, 1);
  const d = r.deposits[0];
  // Deposit 的字段：和 TRON 的 transfers() 一致，加 chain、rawAmount
  assert.deepEqual(Object.keys(d).sort(), ['amount', 'block', 'chain', 'from', 'logIndex', 'rawAmount', 'time', 'to', 'txid']);
  assert.equal(d.chain, 'eth');
  assert.equal(d.txid, '0x' + 'a1'.repeat(32));
  assert.equal(d.logIndex, 3);
  assert.equal(d.block, 85);
  assert.equal(d.time, (1_700_000_000 + 85 * 12) * 1000); // 毫秒，和 TRON 一致
  assert.equal(d.to, to); // EIP-55 格式，和分配出去的地址写法一致
  assert.equal(d.from, OUTSIDER);
  assert.equal(BigInt(d.amount), 150_000_000n);
  assert.equal(d.rawAmount, '150000000');
});

test('evm 扫链：游标已经追上已确认区块时不查日志、游标不动；一次最多读 maxRange 个区块', async () => {
  const node = fakeEvm({ head: 100 });
  const a = await adapter('eth', node, { maxRange: 50 });
  const r1 = await a.transfers({ cursor: '88', addresses: [V.addresses[0]] });
  assert.deepEqual(r1, { deposits: [], next: '88' });
  assert.equal(node.calls.filter((c) => c.method === 'eth_getLogs').length, 0);
  const r2 = await a.transfers({ cursor: '0', addresses: [V.addresses[0]] });
  assert.equal(r2.next, '50');
  for (const c of node.calls.filter((x) => x.method === 'eth_getLogs')) assert.ok(Number(BigInt(c.params[0].toBlock)) <= 50);
});

test('evm 扫链（BSC）：18 位小数的转账入账截断到 6 位，rawAmount 保留链上原始数', async () => {
  const to = V.addresses[1];
  const node = fakeEvm({ head: 200 });
  node.state.logs.push(transferLog({ token: USDT_BSC, from: OUTSIDER, to, raw: 1_234_567_890_123_456_789n, block: 150, txid: '0x' + 'b1'.repeat(32) }));
  const a = await adapter('bsc', node);
  const r = await a.transfers({ cursor: '149', addresses: [to] });
  assert.equal(r.deposits.length, 1);
  assert.equal(r.deposits[0].chain, 'bsc');
  assert.equal(BigInt(r.deposits[0].amount), 1_234_567n);
  assert.equal(r.deposits[0].rawAmount, '1234567890123456789');
});

test('evm 扫链：节点连不上或返回错误时报错（不返回空结果、不推进游标）', async () => {
  const node = fakeEvm({ head: 100, down: true });
  const a = await adapter('eth', node);
  await assert.rejects(a.transfers({ cursor: '80', addresses: [V.addresses[0]] }));
  const bad = fakeEvm({ head: 100 });
  const orig = bad.fetchImpl;
  const b = await adapter('eth', { ...bad, fetchImpl: async (u, init) => {
    const body = JSON.parse(init.body);
    const hasLogs = [].concat(body).some((x) => x.method === 'eth_getLogs');
    if (hasLogs) return new Response(JSON.stringify([].concat(body).map((x) => ({ jsonrpc: '2.0', id: x.id, error: { code: -32005, message: 'limit exceeded' } }))), { status: 200 });
    return orig(u, init);
  } });
  await assert.rejects(b.transfers({ cursor: '80', addresses: [V.addresses[0]] }));
});

test('evm 交易状态："连不上节点"不等于失败：连不上 / 节点出错 → unknown；没回执 → pending；成功但确认数不够 → pending；够了 → confirmed；回滚 → failed', async () => {
  const node = fakeEvm({ head: 100 });
  node.state.receipts['0x01'] = { status: '0x1', blockNumber: 80 };
  node.state.receipts['0x02'] = { status: '0x1', blockNumber: 95 };
  node.state.receipts['0x03'] = { status: '0x0', blockNumber: 80 };
  const a = await adapter('eth', node);
  assert.equal(await a.txStatus('0x01'), 'confirmed');
  assert.equal(await a.txStatus('0x02'), 'pending');
  assert.equal(await a.txStatus('0x03'), 'failed');
  assert.equal(await a.txStatus('0x04'), 'pending');
  node.state.down = true;
  assert.equal(await a.txStatus('0x01'), 'unknown');
  const err = fakeEvm({ head: 100 });
  const b = await adapter('eth', { ...err, fetchImpl: async () => new Response('bad gateway', { status: 502 }) });
  assert.equal(await b.txStatus('0x01'), 'unknown');
});

// ---------- WalletProvider：contract（默认实现） ----------

test('contract 提供方：符合统一接口；ETH、BSC 支持批量归集、自己扫链、没有 Webhook', async () => {
  const { assertProvider } = await providerMod();
  const db = await setupDb();
  const p = await contractProvider(db);
  assert.equal(p.id, 'contract');
  assert.doesNotThrow(() => assertProvider(p));
  assert.equal(typeof p.scan, 'function');
  assert.equal(p.handleWebhook, undefined);
  for (const chain of ['eth', 'bsc']) {
    const c = p.capabilities(chain);
    assert.equal(c.batchSweep, true); assert.equal(c.selfScan, true); assert.equal(c.webhook, false);
  }
  await db.end?.();
});

test('contract 分配地址：纯计算不上链（节点连不上也能分配）；地址 = CREATE2（工厂、实现、parent、批量合约、盐）；同一客户 ETH 和 BSC 地址相同，不同客户不同', async () => {
  const { forwarderAddress } = await import('../server/wallet/create2.js');
  const db = await setupDb({ customers: [['m1', 'c1'], ['m1', 'c2']] });
  const down = { eth: fakeEvm({ down: true }), bsc: fakeEvm({ down: true }) };
  const p = await contractProvider(db, down);
  const a1 = await p.allocateAddress({ merchantId: 'm1', customerId: 'c1', chain: 'eth' });
  const b1 = await p.allocateAddress({ merchantId: 'm1', customerId: 'c1', chain: 'bsc' });
  const a2 = await p.allocateAddress({ merchantId: 'm1', customerId: 'c2', chain: 'eth' });
  assert.match(a1.providerRef, /^0x[0-9a-f]{64}$/); // 盐
  assert.equal(a1.schemeVer, 1);
  assert.equal(a1.address, forwarderAddress({ factory: SCHEME.factory, implementation: SCHEME.implementation, parent: SCHEME.parent, feeAddress: SCHEME.batcher, salt: a1.providerRef }));
  assert.equal(b1.address, a1.address);
  assert.equal(b1.providerRef, a1.providerRef);
  assert.notEqual(a2.address, a1.address);
  assert.equal(down.eth.calls.length + down.bsc.calls.length, 0, '分配地址不访问节点');
  // 第 1 批没有 TRON 合约：contract 提供方不给 TRON 地址
  await assert.rejects(p.allocateAddress({ merchantId: 'm1', customerId: 'c1', chain: 'tron' }), (e) => e.code === 'chain_not_enabled');
  await db.end?.();
});

test('contract 配置检查：钱只能进写死的 parent——parent、批量合约、工厂、实现必须是合法地址，parent 不能等于 USDT 合约或批量合约', async () => {
  const { createContractProvider } = await contractMod();
  const db = await setupDb();
  const mk = async (scheme, usdt = USDT_ETH) => createContractProvider({ db, chains: { eth: { adapter: await adapter('eth', fakeEvm()), scheme, usdt } } });
  await assert.rejects(async () => mk({ ...SCHEME, parent: 'TXYZ' }), /parent/i);
  await assert.rejects(async () => mk({ ...SCHEME, parent: SCHEME.batcher }), /parent/i);
  await assert.rejects(async () => mk({ ...SCHEME, parent: USDT_ETH }), /parent/i);
  await assert.rejects(async () => mk({ ...SCHEME, factory: '' }), /factory/i);
  await assert.rejects(async () => mk({ ...SCHEME, ver: 0 }), /ver/i);
  await db.end?.();
});

test('CI：每个 PR 都跑 anvil 本地链端到端（test/anvil/），不只是合约的 forge test', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /anvil/);
  assert.match(ci, /test\/anvil\//);
});
