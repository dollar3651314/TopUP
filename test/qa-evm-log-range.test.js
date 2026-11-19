// 测试先写：ETH、BSC 扫块时 eth_getLogs 的区块范围（研发实现时不改这个文件）。
// 背景：不少节点套餐限制 eth_getLogs 一次能查的区块数（例如某常见托管节点的免费套餐一次最多 10 个区块，超过直接回 HTTP 400），
// 原来一次最多读 1,000 个区块：worker 停过一阵（超过约 10 个块）之后，每一轮都请求同一个过大的范围、每一轮都 400，
// 扫块"读失败就停在这里、下一轮重读"，于是这条链永远卡住（系统状态里 scan_stalled），节点本身 eth_blockNumber 一切正常。
//
// 要求（按下面的用例）：
//   一、默认一次 eth_getLogs 覆盖的区块数 ≤ 10（fromBlock..toBlock 含两端，toBlock − fromBlock ≤ 9）。
//       可以用环境变量 EVM_LOGS_MAX_BLOCKS 改（ETH、BSC 共用一个）：loadConfig().evmLogsMaxBlocks，默认 10；
//       空、不是数字、0、负数一律按 10；正整数照用（付费节点可以调大）。createWalletLayer 建的 ETH、BSC 适配器按它；
//       createEvmAdapter 的 maxRange 参数含义不变（一次最多读几个区块，含两端），默认值改成 10。
//       .env.example 和《项目索引》的环境变量表写上 EVM_LOGS_MAX_BLOCKS。
//   二、节点拒绝这个范围时（HTTP 400；或 JSON-RPC 错误说范围太大 / 结果太多，例如 "Log response size exceeded"、
//       "query returned more than 10000 results"、"... up to a 10 block range"），同一次调用里把范围减半重试，最少到 1 个区块；
//       1 个区块也被拒绝才算这一轮失败（抛出、不推进游标，下一轮从同一个块重读）。
//       不跳块：从游标到"最新区块 − 确认数"的每个区块都恰好读成功一次，游标只推进到已经读成功的区块。
//   三、积压 5,000 个区块：分多轮追平，任何一次请求都不超过上限，积压中间的一笔到账照样入账、只入一次；
//       每一轮（scanEvm 一次）发给节点的请求 ≤ 20 个（免费套餐每秒约 15 个请求，一轮里不能猛发），且每轮至少前进 40 个区块（不能退化成一轮几个块）。
//   四、原有行为不变：确认数（不读超过"最新区块 − 确认数"的块）、第一次没有游标时从当前已确认区块开始；
//       真正的节点故障（HTTP 429 / 500 / 503、连不上、和范围无关的 JSON-RPC 错误）不当作范围问题：只请求 1 次就抛出，
//       错误码和原来一样（rpc_http 带 httpStatus、rpc_unreachable），不减半重试。TRON 适配器不改。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fakeEvm, setupDb, transferLog } from './wallet-helpers.js';
import { createEvmAdapter } from '../server/wallet/adapters/evm.js';
import { createContractProvider } from '../server/wallet/providers/contract.js';
import { addressFor } from '../server/wallet/addresses.js';
import { scanEvm } from '../server/wallet/scan.js';
import { setMeta, getMeta } from '../server/pay/core.js';
import { loadConfig } from '../server/config.js';

const V = JSON.parse(readFileSync(new URL('./fixtures/wallet/create2-vectors-topup.json', import.meta.url), 'utf8'));
const SCHEME = { ver: 1, factory: V.factory, implementation: V.implementation, parent: V.parents[0], batcher: V.feeAddresses[0] };
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const CONF = 12;
const randomAddr = () => '0x' + randomBytes(20).toString('hex');
const txid = () => '0x' + randomBytes(32).toString('hex');
const num = (h) => Number(BigInt(h));

// 托管节点免费套餐超过范围时的真实回法（HTTP 400 + JSON-RPC 错误体）
const http400Body = (id, from) => ({ jsonrpc: '2.0', id, error: { code: -32600, message: `Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. Based on your parameters, this block range should work: [0x${from.toString(16)}, 0x${(from + 9).toString(16)}]. Upgrade to PAYG for expanded block range.` } });
const RANGE_RPC_ERRORS = {
  size: { code: -32602, message: 'Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range and no limit on the response size, or you can request any block range with a cap of 10K logs in the response.' },
  results: { code: -32005, message: 'query returned more than 10000 results' },
};

/**
 * 包一层替身节点：eth_getLogs 的范围（含两端）超过 limit 时拒绝。
 * mode：'http400'（HTTP 400 + 错误体）/ 'size' / 'results'（HTTP 200 + JSON-RPC 错误）。
 * fail：(body) => Response | undefined，给 eth_getLogs 模拟别的故障（优先于范围检查）。
 * 记录每次 eth_getLogs 的 { from, to, ok } 和发给节点的 HTTP 请求总数。
 */
function rangeNode({ head, limit = 10, mode = 'http400', logs = [], fail } = {}) {
  const node = fakeEvm({ head, logs });
  const getLogs = [];
  const stats = { requests: 0 };
  const fetchImpl = async (url, init) => {
    stats.requests++;
    const body = JSON.parse(init.body);
    const items = [].concat(body).filter((x) => x.method === 'eth_getLogs');
    if (items.length && fail) {
      const recs = items.map((x) => ({ from: num(x.params[0].fromBlock), to: num(x.params[0].toBlock), ok: false }));
      getLogs.push(...recs); // 先记下（fail 可能直接抛出，模拟连不上）
      const r = await fail(body);
      if (r) return r;
      getLogs.splice(getLogs.length - recs.length, recs.length);
    }
    let rejected = null;
    for (const x of items) {
      const from = num(x.params[0].fromBlock), to = num(x.params[0].toBlock);
      const ok = to - from + 1 <= limit;
      getLogs.push({ from, to, ok });
      if (!ok && !rejected) rejected = { id: x.id, from };
    }
    if (rejected) {
      if (mode === 'http400') return new Response(JSON.stringify(http400Body(rejected.id, rejected.from)), { status: 400, headers: { 'content-type': 'application/json' } });
      const err = (x) => ({ jsonrpc: '2.0', id: x.id, error: RANGE_RPC_ERRORS[mode] });
      return Response.json(Array.isArray(body) ? body.map(err) : err(body));
    }
    return node.fetchImpl(url, init);
  };
  return { ...node, fetchImpl, getLogs, stats };
}

const adapterOf = (node, extra = {}) => createEvmAdapter({ chain: 'eth', rpcUrl: node.rpcUrl, fetchImpl: node.fetchImpl, usdt: USDT, decimals: 6, confirmations: CONF, ...extra });

/** 成功读过的范围：从 first 到 last 首尾相接、不重叠、不缺块 */
function assertExactCoverage(getLogs, first, last) {
  const ok = getLogs.filter((g) => g.ok).sort((a, b) => a.from - b.from);
  assert.ok(ok.length > 0, '至少成功读过一次');
  assert.equal(ok[0].from, first, `从游标的下一个块 ${first} 开始读，实际 ${ok[0].from}`);
  for (let i = 1; i < ok.length; i++) {
    assert.equal(ok[i].from, ok[i - 1].to + 1, `区块 ${ok[i - 1].to + 1} 起：成功读过的范围要首尾相接（不跳块、不重读），实际 [${ok[i - 1].from},${ok[i - 1].to}] 之后是 [${ok[i].from},${ok[i].to}]`);
  }
  assert.equal(ok.at(-1).to, last, `读到"最新区块 − 确认数"${last} 为止，实际 ${ok.at(-1).to}`);
}

const maxSpan = (getLogs) => Math.max(...getLogs.map((g) => g.to - g.from + 1));

// ---------- 一、默认范围和配置 ----------

test('默认：一次 eth_getLogs 最多 10 个区块（含两端）——积压很多时第一次请求就不超过 10，返回的游标也只推进 ≤ 10 个块', async () => {
  const node = rangeNode({ head: 100_000, limit: Infinity });
  const a = adapterOf(node);
  const start = 50_000;
  const { next } = await a.transfers({ cursor: String(start), addresses: [randomAddr()] });
  assert.ok(node.getLogs.length > 0, '发了 eth_getLogs');
  for (const g of node.getLogs) assert.ok(g.to - g.from + 1 <= 10, `一次请求覆盖 ${g.to - g.from + 1} 个区块（[${g.from}, ${g.to}]），默认上限 10`);
  assert.equal(node.getLogs[0].from, start + 1);
  assert.ok(Number(next) > start && Number(next) <= start + 10, `游标从 ${start} 推进到 ${next}：前进 1～10 个块`);
});

test('默认上限下节点（只收 ≤ 10 个块）一次就接受：不出现被拒的请求', async () => {
  const node = rangeNode({ head: 100_000, limit: 10 });
  const a = adapterOf(node);
  let cursor = '60000';
  for (let i = 0; i < 5; i++) ({ next: cursor } = await a.transfers({ cursor, addresses: [randomAddr()] }));
  assert.equal(node.getLogs.filter((g) => !g.ok).length, 0, `没有被拒的请求：${JSON.stringify(node.getLogs.filter((g) => !g.ok))}`);
  assert.equal(Number(cursor), 60_050, '5 次调用、每次 10 个块，正好推进 50 个块（默认就用满 10 个块，不是更小）');
});

test('createEvmAdapter 传 maxRange：一次最多读 maxRange 个区块（含两端）', async () => {
  const node = rangeNode({ head: 100_000, limit: Infinity });
  const a = adapterOf(node, { maxRange: 4 });
  const { next } = await a.transfers({ cursor: '70000', addresses: [randomAddr()] });
  assert.ok(maxSpan(node.getLogs) <= 4, `最大跨度 ${maxSpan(node.getLogs)}，应 ≤ 4`);
  assert.equal(Number(next), 70_004);
});

test('配置：EVM_LOGS_MAX_BLOCKS → loadConfig().evmLogsMaxBlocks，默认 10；空、不是数字、0、负数按 10；正整数照用', () => {
  assert.equal(loadConfig({}).evmLogsMaxBlocks, 10, '默认 10');
  assert.equal(loadConfig({ EVM_LOGS_MAX_BLOCKS: '4' }).evmLogsMaxBlocks, 4);
  assert.equal(loadConfig({ EVM_LOGS_MAX_BLOCKS: '2000' }).evmLogsMaxBlocks, 2000, '付费节点可以调大');
  for (const bad of ['', 'abc', '0', '-5']) assert.equal(loadConfig({ EVM_LOGS_MAX_BLOCKS: bad }).evmLogsMaxBlocks, 10, `"${bad}" 按默认 10`);
});

test('配置接上：createWalletLayer 建的 ETH 适配器按 EVM_LOGS_MAX_BLOCKS 限定范围；不填时按 10', async () => {
  const { createWalletLayer } = await import('../server/wallet/index.js');
  const db = await setupDb({ customers: [] });
  const realFetch = globalThis.fetch;
  try {
    for (const [env, limit] of [[{}, 10], [{ EVM_LOGS_MAX_BLOCKS: '3' }, 3]]) {
      const node = rangeNode({ head: 100_000, limit: Infinity });
      globalThis.fetch = node.fetchImpl; // 适配器默认用全局 fetch；这里换成替身节点，不连外网
      const config = loadConfig({ APP_ENV: 'staging', ETH_RPC_URL: 'http://evm-node.test/', ...env });
      const layer = createWalletLayer({ db, config, evm: { eth: { ...SCHEME, usdt: USDT } } });
      assert.ok(layer.adapters.eth, `ETH 适配器建出来了：${JSON.stringify(layer.errors)}`);
      const { next } = await layer.adapters.eth.transfers({ cursor: '80000', addresses: [randomAddr()] });
      assert.ok(node.getLogs.length > 0, '发了 eth_getLogs');
      assert.ok(maxSpan(node.getLogs) <= limit, `${JSON.stringify(env)}：最大跨度 ${maxSpan(node.getLogs)}，应 ≤ ${limit}`);
      assert.equal(Number(next), 80_000 + limit, `${JSON.stringify(env)}：一次推进 ${limit} 个块`);
    }
  } finally {
    globalThis.fetch = realFetch;
    await db.end?.();
  }
});

test('文档：.env.example 和《项目索引》写了 EVM_LOGS_MAX_BLOCKS', () => {
  const env = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(env, /^EVM_LOGS_MAX_BLOCKS=/m, '.env.example 有 EVM_LOGS_MAX_BLOCKS= 这一行');
  const idx = readFileSync(new URL('../项目索引.md', import.meta.url), 'utf8');
  assert.match(idx, /^\| `EVM_LOGS_MAX_BLOCKS`/m, '《项目索引》环境变量表有 EVM_LOGS_MAX_BLOCKS');
});

// ---------- 二、节点拒绝范围时减半重试 ----------

for (const mode of ['http400', 'size', 'results']) {
  test(`节点只收 ≤ 3 个块（拒绝方式：${mode}）：同一次调用里减半重试直到被接受，不抛错、游标前进、只推进到读成功的块`, async () => {
    const to = randomAddr();
    const start = 90_000;
    // 第 2 个块和第 3 个块各一笔到账：减半后读到的块里的要返回，没读到的不能返回（下次再读）
    const logs = [
      transferLog({ token: USDT, from: randomAddr(), to, raw: 5_000_000n, block: start + 2, txid: txid() }),
      transferLog({ token: USDT, from: randomAddr(), to, raw: 7_000_000n, block: start + 8, txid: txid() }),
    ];
    const node = rangeNode({ head: 100_000, limit: 3, mode, logs });
    const a = adapterOf(node);
    const r = await a.transfers({ cursor: String(start), addresses: [to] });
    const next = Number(r.next);
    assert.ok(next > start, `同一次调用里就前进了（不是整轮失败）：next=${r.next}`);
    assert.ok(next <= start + 10, `next ≤ ${start + 10}`);
    assert.ok(node.getLogs.some((g) => !g.ok), '先请求过一次被拒的范围');
    for (const g of node.getLogs.filter((x) => !x.ok)) assert.equal(g.from, start + 1, `被拒后重试仍从第一个没读的块 ${start + 1} 开始，实际 ${g.from}`);
    const ok = node.getLogs.filter((g) => g.ok);
    assert.equal(Math.max(...ok.map((g) => g.to)), next, '游标正好推进到读成功的最后一个块');
    assert.ok(node.getLogs.length <= 16, `一次调用请求次数有限：${node.getLogs.length}`);
    const want = logs.filter((l) => num(l.blockNumber) <= next).map((l) => l.transactionHash).sort();
    assert.deepEqual(r.deposits.map((d) => d.txid).sort(), want, '只返回已读块里的到账');
  });
}

test('节点只收 1 个块：从 10 减到 1 之后能前进；多次调用后每个块恰好读成功一次', async () => {
  const node = rangeNode({ head: 100_000, limit: 1 });
  const a = adapterOf(node);
  const start = 95_000;
  let cursor = String(start);
  for (let i = 0; i < 12; i++) ({ next: cursor } = await a.transfers({ cursor, addresses: [randomAddr()] }));
  assert.ok(Number(cursor) >= start + 12, `12 次调用至少前进 12 个块，实际到 ${cursor}`);
  assertExactCoverage(node.getLogs, start + 1, Number(cursor));
});

test('1 个块也被拒绝：这次调用抛出（这一轮失败），不推进游标；减半序列以 1 个块结束、次数有限、都从同一个块开始', async () => {
  const node = rangeNode({ head: 100_000, limit: 0 });
  const a = adapterOf(node);
  const start = 96_000;
  await assert.rejects(a.transfers({ cursor: String(start), addresses: [randomAddr()] }));
  const spans = node.getLogs.map((g) => g.to - g.from + 1);
  assert.ok(spans.length >= 2 && spans.length <= 6, `减半重试：10 → … → 1，最多 6 次请求，实际 ${JSON.stringify(spans)}`);
  assert.equal(spans[0], 10, '先按上限 10 个块请求');
  assert.equal(spans.at(-1), 1, '最后一次是 1 个块');
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i] < spans[i - 1], `每次比上一次小：${JSON.stringify(spans)}`);
  for (const g of node.getLogs) assert.equal(g.from, start + 1, '都从第一个没读的块开始');
});

// ---------- 三、积压追平 ----------

test('适配器：积压 5,000 个块，节点只收 ≤ 10 个块——反复调用追平到"最新区块 − 确认数"，不超范围、不跳块、中间那笔到账只出现一次', async () => {
  const head = 205_000 + CONF;
  const start = 200_000;
  const to = randomAddr();
  const mid = transferLog({ token: USDT, from: randomAddr(), to, raw: 12_340_000n, block: 202_503, txid: txid() });
  const node = rangeNode({ head, limit: 10, logs: [mid] });
  const a = adapterOf(node);
  let cursor = String(start);
  const seen = [];
  for (let i = 0; i < 1000 && Number(cursor) < head - CONF; i++) {
    const r = await a.transfers({ cursor, addresses: [to] });
    seen.push(...r.deposits);
    cursor = r.next;
  }
  assert.equal(Number(cursor), head - CONF, '追平到最新区块 − 确认数');
  assert.ok(maxSpan(node.getLogs) <= 10, `任何一次请求都不超过 10 个块，实际最大 ${maxSpan(node.getLogs)}`);
  assert.ok(node.getLogs.every((g) => g.to <= head - CONF), '不读超过"最新区块 − 确认数"的块（确认数不变）');
  assertExactCoverage(node.getLogs, start + 1, head - CONF);
  assert.deepEqual(seen.map((d) => [d.txid, d.amount, d.block]), [[mid.transactionHash, 12_340_000, 202_503]], '中间那笔到账出现且只出现一次');
});

test('worker 一轮一轮扫（scanEvm）：积压 5,000 个块分多轮追平；每轮请求 ≤ 20 个、至少前进 40 个块；中间那笔到账入账一次', async () => {
  const db = await setupDb({ customers: [['m1', 'c1']] });
  const head = 305_000 + CONF;
  const start = 300_000;
  const node = rangeNode({ head, limit: 10 });
  const adapter = adapterOf(node);
  const provider = createContractProvider({ db, chains: { eth: { adapter, scheme: SCHEME, usdt: USDT } }, operatorKey: '0x' + randomBytes(32).toString('hex') });
  const { address } = await addressFor(db, { merchantId: 'm1', customerId: 'c1', chain: 'eth', providers: { contract: provider }, now: Date.parse('2026-12-01T04:00:00Z') });
  const mid = transferLog({ token: USDT, from: randomAddr(), to: address, raw: 25_000_000n, block: 302_517, txid: txid() });
  node.state.logs.push(mid);
  await setMeta(db, 'evm_cursor_eth', String(start));
  const layer = { providers: { contract: provider }, enabledChains: ['eth'], adapters: { eth: adapter } };
  let credited = 0, seen = 0, ticks = 0;
  const perTick = [];
  try {
    for (; ticks < 200; ticks++) {
      const before = Number(await getMeta(db, 'evm_cursor_eth', null));
      if (before >= head - CONF) break;
      const r0 = node.stats.requests;
      const out = await scanEvm(db, { layer, notify: async () => {} });
      assert.equal(out.eth.error, undefined, `第 ${ticks + 1} 轮不出错：${out.eth.error}`);
      credited += out.eth.credited;
      seen += out.eth.seen;
      const after = Number(await getMeta(db, 'evm_cursor_eth', null));
      perTick.push({ requests: node.stats.requests - r0, advanced: after - before, left: head - CONF - before });
    }
    assert.equal(Number(await getMeta(db, 'evm_cursor_eth', null)), head - CONF, `${ticks} 轮内追平`);
    for (const [i, t] of perTick.entries()) {
      assert.ok(t.requests <= 20, `第 ${i + 1} 轮发给节点 ${t.requests} 个请求，应 ≤ 20`);
      if (t.left >= 50) assert.ok(t.advanced >= 40, `第 ${i + 1} 轮只前进 ${t.advanced} 个块（剩 ${t.left}），应 ≥ 40`);
    }
    assert.ok(maxSpan(node.getLogs) <= 10, `任何一次请求都不超过 10 个块，实际最大 ${maxSpan(node.getLogs)}`);
    assertExactCoverage(node.getLogs, start + 1, head - CONF);
    assert.equal(seen, 1, '中间那笔到账只被看到一次');
    assert.equal(credited, 1, '中间那笔到账入账一次');
  } finally {
    await db.end?.();
  }
});

// ---------- 四、原有行为不变 ----------

test('第一次没有游标：从当前已确认区块开始，不回扫历史、不发 eth_getLogs', async () => {
  const node = rangeNode({ head: 100_000, limit: 10 });
  const a = adapterOf(node);
  const r = await a.transfers({ cursor: null, addresses: [randomAddr()] });
  assert.equal(r.next, String(100_000 - CONF));
  assert.deepEqual(r.deposits, []);
  assert.equal(node.getLogs.length, 0);
});

const jsonErr = (body, error) => Response.json({ jsonrpc: '2.0', id: body.id, error });
const NODE_FAULTS = [
  ['HTTP 503', () => new Response('busy', { status: 503 }), (e) => e.code === 'rpc_http' && e.httpStatus === 503],
  ['HTTP 429', () => new Response('too many requests', { status: 429 }), (e) => e.code === 'rpc_http' && e.httpStatus === 429],
  ['HTTP 500', () => new Response('oops', { status: 500 }), (e) => e.code === 'rpc_http' && e.httpStatus === 500],
  ['连不上', () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }, (e) => e.code === 'rpc_unreachable'],
  ['和范围无关的 JSON-RPC 错误', (body) => jsonErr(body, { code: -32000, message: 'header not found' }), (e) => /header not found/.test(e.message)],
];
for (const [name, respond, check] of NODE_FAULTS) {
  test(`真正的节点故障（${name}）不当作范围问题：eth_getLogs 只请求 1 次就抛出，错误码不变，不推进游标`, async () => {
    const node = rangeNode({ head: 100_000, limit: 10, fail: respond });
    const a = adapterOf(node);
    await assert.rejects(a.transfers({ cursor: '97000', addresses: [randomAddr()] }), (e) => { assert.ok(check(e), `错误：${e.code} ${e.httpStatus ?? ''} ${e.message}`); return true; });
    assert.equal(node.getLogs.length, 1, `只请求 1 次，不减半重试：${JSON.stringify(node.getLogs)}`);
  });
}
