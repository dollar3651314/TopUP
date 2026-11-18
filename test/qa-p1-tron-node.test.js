// 测试先写（测试经理）：上线前清理 P1 —— TRON 节点访问（扫块失败即停、按每秒次数限流、老 TronGrid 客户端重试、追平时间测算）
// 和"节点落后时不下结论"。开发不要改这个文件，数字或接口有异议找测试经理改测试。
//
// 这里定下的约定（接口；开发按这个做）：
//   一、扫块失败即停（server/wallet/adapters/tron.js 的 transfers）：区间里第一个块读失败后，其余并发的"取下一个块"不再发新请求
//      （已经在途 / 已排队的最多 BLOCK_CONCURRENCY 个，之后一个都不再发；不能在后台把剩下的块读完）；游标不动，下一轮从同一个块重读。
//   二、按每秒次数限流（QPS），不只是同时在途个数：
//      - createTronAdapter 新参数 qps（每秒最多开始几个请求，重试也算）、now（() => 毫秒，默认 Date.now）；等待一律用注入的 sleep（测试注入虚拟时钟）
//      - 任意连续 1000 毫秒（按 now）里开始的请求数 ≤ qps；返回的适配器对象带 qps 属性（实际生效的值）
//      - 配置：环境变量 TRON_NODE_QPS → loadConfig().tronNodeQps，默认 10（TronGrid 带 Key 的每秒次数上限之下留余量）；
//        createWalletLayer 建 TRON 适配器、createPayDeps 建老 TronGrid 客户端都按它（适配器 .qps、deps.tron.qps 等于配置值）
//      - 老客户端 server/pay/trongrid.js 的 createTronGrid 同样接受 qps、now、sleep，同样限流；带 .qps 属性
//   三、老客户端（createTronGrid）也对 HTTP 429 / 503 退避重试，和适配器同一套数字：每个请求最多 4 次，间隔不缩短、每次 ≤ 10 秒、
//      没有 Retry-After 时合计 ≤ 15 秒，Retry-After 照着等但最多 10 秒；400 / 404 不重试；
//      都失败抛错：code = 'rpc_http'、httpStatus = 429 / 503；连不上：code = 'rpc_unreachable'；错误信息不含节点地址和 API Key。
//      广播（broadcasthex）重试时发的是同一笔已签名交易（请求体逐字节相同），不重新建交易。
//   四、追平测算：1,200 个区块的积压，默认 QPS 下用适配器追平（节点每 3 秒出一个新块），打印用了多少模拟秒；不超过"请求数 ÷ QPS × 1.2 + 5 秒"。
//   五、节点落后不下结论：归集确认里"发出 15 分钟后节点仍不认识这笔交易 → 标失败（not_broadcast）、地址放回"，
//      只在这次用的节点的最新区块号（adapter.head()）不低于扫块记下的最新区块号（pay_meta 的 evm_scan_<链>.head）时才下结论；
//      节点落后就这一轮不算数（批次仍是"已发送"），节点追上后照常下结论。以太坊、TRON 都是。
//   （打款"没上链"的判断、确认作废已有同类保护：以太坊 probe 比较 head、TRON 按固化区块时间 + 隔 5 分钟两轮，这里不重复。）
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fakeTronNode, randomTron, tronScheme, testOperator } from './tron-helpers.js';
import { setupDb, fakeEvm } from './wallet-helpers.js';
import { createTronAdapter } from '../server/wallet/adapters/tron.js';
import { createTronGrid } from '../server/pay/trongrid.js';
import { loadConfig } from '../server/config.js';
import { setMeta } from '../server/pay/core.js';

const KEY = 'k3y-should-not-leak';
const BASE = 'https://tron-node.example.invalid/' + KEY;

/**
 * 虚拟时钟：sleep(ms) 登记一个"到点"的计时器，run(promise) 在没有别的事可做时把时钟拨到最早的计时器并唤醒它。
 * 限流必须用注入的 now / sleep（不能用真的 setTimeout 等待），否则这里会按真实时间等。
 */
function virtualClock() {
  let t = 0, seq = 0;
  const timers = [];
  const now = () => t;
  const sleep = (ms) => new Promise((r) => { timers.push({ at: t + Math.max(0, Number(ms) || 0), seq: seq++, r }); });
  const idle = () => new Promise((r) => setImmediate(r));
  async function run(p) {
    let done = false, val, err;
    p.then((v) => { done = true; val = v; }, (e) => { done = true; err = e; });
    const started = Date.now();
    while (!done) {
      for (let i = 0; i < 4 && !done; i++) await idle();
      if (done) break;
      if (Date.now() - started > 60_000) throw new Error('virtual clock: no progress for 60 s (限流是不是用了真的计时器？)');
      if (!timers.length) continue;
      timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const x = timers.shift();
      t = Math.max(t, x.at);
      x.r();
    }
    if (err) throw err;
    return val;
  }
  return { now, sleep, run };
}

/** 任意连续 1000 毫秒里开始的请求数的最大值 */
function peakPerSecond(starts) {
  const s = [...starts].sort((a, b) => a - b);
  let peak = 0;
  for (let i = 0, j = 0; i < s.length; i++) { while (s[i] - s[j] >= 1000) j++; peak = Math.max(peak, i - j + 1); }
  return peak;
}

// ---------- 一、扫块失败即停 ----------

/** 替身节点外包一层：badBlocks 里的块读不到（mode：down = 连不上、500 = HTTP 500）；记下每个块请求 */
function failingBlocks(node, badBlocks, mode = 'down') {
  const blockReads = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    await new Promise((r) => setImmediate(r));
    if (path === '/wallet/gettransactioninfobyblocknum') {
      const n = JSON.parse(init.body).num;
      blockReads.push(n);
      if (badBlocks.has(n)) {
        if (mode === 'down') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
        return new Response('oops', { status: 500 });
      }
    }
    return node.fetchImpl(url, init);
  };
  return { fetchImpl, blockReads };
}
const settle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); await new Promise((r) => setTimeout(r, 30)); };

for (const mode of ['down', '500']) {
  test(`扫块（TRON）：区间第一个块读失败（${mode === 'down' ? '连不上' : 'HTTP 500'}）→ 整段作废、游标不动；其余并发不再继续读剩下的块（不在后台把 100 个块读完）；下一轮从同一个块重读`, async () => {
    const usdt = randomTron();
    const node = fakeTronNode({ head: 1000 });
    node.state.usdt = usdt;
    const to = randomTron();
    const cursor = 1000 - 19 - 100; // 正好一整段 100 个块
    const first = cursor + 1;
    node.transfer({ token: usdt, to, amount: 5_000_000n, block: first });
    const bad = new Set([first]);
    const f = failingBlocks(node, bad, mode);
    const a = createTronAdapter({ base: node.base, fetchImpl: f.fetchImpl, usdt, confirmations: 19, maxRange: 100, timeoutMs: 2000, sleep: async () => {} });
    await assert.rejects(a.transfers({ cursor: String(cursor), addresses: [to] }), '第一个块读不到：整段作废、抛出');
    await settle();
    const n1 = f.blockReads.length;
    await settle();
    assert.equal(f.blockReads.length, n1, `抛出之后不能再有新的块请求（后台还在读：${n1} → ${f.blockReads.length}）`);
    assert.ok(n1 <= 4, `第一个块失败后，最多只有当时已在途 / 已排队的几个（≤ 4）块请求，实际一共读了 ${n1} 个块（应该停下，不能把这一段 100 个块读完）`);
    // 下一轮：节点恢复，同一个游标从同一个块重读，到账照样找到
    bad.clear();
    const r = await a.transfers({ cursor: String(cursor), addresses: [to] });
    assert.equal(r.next, String(cursor + 100));
    assert.equal(r.deposits.length, 1, '失败的那个块里的到账，下一轮重读找到');
    assert.equal(r.deposits[0].block, first);
  });
}

test('扫块（TRON）：中间一个块一直 429（重试用完）→ 抛出 rpc_http / 429；抛出之后不再有任何新的节点请求', async () => {
  const usdt = randomTron();
  const node = fakeTronNode({ head: 1000 });
  const cursor = 1000 - 19 - 100;
  const bad = cursor + 30;
  const reads = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    await new Promise((r) => setImmediate(r));
    if (path === '/wallet/gettransactioninfobyblocknum') {
      const n = JSON.parse(init.body).num;
      reads.push(n);
      if (n === bad) return new Response('Too Many Requests', { status: 429 });
    }
    return node.fetchImpl(url, init);
  };
  const a = createTronAdapter({ base: node.base, fetchImpl, usdt, confirmations: 19, maxRange: 100, timeoutMs: 2000, sleep: async () => {} });
  await assert.rejects(a.transfers({ cursor: String(cursor), addresses: [randomTron()] }), (e) => e.code === 'rpc_http' && e.httpStatus === 429);
  await settle();
  const n1 = reads.length;
  await settle();
  assert.equal(reads.length, n1, '抛出之后没有新的块请求');
  assert.ok(n1 < 100, `坏块之后不再读完整段：一共读了 ${n1} 次块（含重试）`);
});

// ---------- 二、按每秒次数限流 ----------

test('配置：TRON_NODE_QPS → loadConfig().tronNodeQps，默认 10', () => {
  assert.equal(loadConfig({}).tronNodeQps, 10, '默认 10');
  assert.equal(loadConfig({ TRON_NODE_QPS: '4' }).tronNodeQps, 4);
});

test('TRON 适配器：带 qps 参数时任意 1 秒内开始的请求 ≤ qps（重试也算）；对象上有 qps 属性；不传时默认 10', async () => {
  const clk = virtualClock();
  const node = fakeTronNode({ head: 1000 });
  const starts = [];
  let n = 0;
  const fetchImpl = async (url, init) => { starts.push(clk.now()); if (++n % 7 === 0) return new Response('busy', { status: 503 }); return node.fetchImpl(url, init); };
  const a = createTronAdapter({ base: node.base, fetchImpl, usdt: randomTron(), timeoutMs: 2000, sleep: clk.sleep, now: clk.now, qps: 5 });
  assert.equal(a.qps, 5, '适配器带实际生效的 qps');
  await clk.run(Promise.all(Array.from({ length: 40 }, () => a.isContract(randomTron()))));
  assert.ok(starts.length >= 40, `请求都发出去了（含重试）：${starts.length}`);
  const peak = peakPerSecond(starts);
  assert.ok(peak <= 5, `任意 1 秒内开始的请求最多 5 个，实际峰值 ${peak}（只限同时在途个数不够）`);
  assert.ok(clk.now() >= ((starts.length - 5) / 5) * 1000 - 1000, `限流确实在等（用注入的 sleep / now）：模拟时间 ${clk.now()} 毫秒、${starts.length} 个请求`);
  assert.equal(createTronAdapter({ base: BASE, fetchImpl, usdt: randomTron() }).qps, 10, '不传 qps：默认 10');
});

test('老 TronGrid 客户端（createTronGrid）：同样接受 qps / now / sleep，任意 1 秒内开始的请求 ≤ qps；带 qps 属性，默认 10', async () => {
  const clk = virtualClock();
  const starts = [];
  const fetchImpl = async () => { starts.push(clk.now()); return Response.json({ result: { result: true }, constant_result: ['0'.repeat(63) + '1'] }); };
  const g = createTronGrid({ network: 'nile', apiKey: KEY, fetchImpl, sleep: clk.sleep, now: clk.now, qps: 3 });
  assert.equal(g.qps, 3);
  await clk.run(Promise.all(Array.from({ length: 20 }, () => g.usdtBalance(randomTron()))));
  assert.equal(starts.length, 20);
  const peak = peakPerSecond(starts);
  assert.ok(peak <= 3, `任意 1 秒内最多 3 个，实际 ${peak}`);
  assert.equal(createTronGrid({ network: 'nile', fetchImpl }).qps, 10, '不传 qps：默认 10');
});

test('配置接上：createWalletLayer 建的 TRON 适配器、createPayDeps 建的老 TronGrid 客户端都用 TRON_NODE_QPS', async () => {
  const { createWalletLayer } = await import('../server/wallet/index.js');
  const { scheme, usdt } = tronScheme();
  const db = await setupDb({ customers: [] });
  const config = { ...loadConfig({ APP_ENV: 'staging', TRON_NETWORK: 'nile', TRON_NODE_URL: 'http://127.0.0.1:9', TRON_NODE_QPS: '3' }) };
  const layer = createWalletLayer({ db, config, evm: {}, tron: { ...scheme, usdt } });
  assert.ok(layer.adapters.tron, `TRON 适配器建出来了：${JSON.stringify(layer.errors)}`);
  assert.equal(layer.adapters.tron.qps, 3, 'TRON 适配器按 TRON_NODE_QPS');
  await db.end?.();

  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createPayDeps } = await import('../server/pay/deps.js');
  const { createMemRedis } = await import('../server/kyb/memredis.js');
  const { deriveKeys } = await import('../server/kyb/crypto.js');
  const dir = mkdtempSync(join(tmpdir(), 'qa-p1-qps-'));
  const SECRET = 'test-app-secret-test-app-secret-0123456789';
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }; // 不连外网
  try {
    const deps = await createPayDeps({ config: loadConfig({ APP_ENV: 'local', FAKE_TRON: '0', APP_SECRET: SECRET, LOCAL_DB_DIR: join(dir, 'db'), TRON_NODE_QPS: '4' }), kyb: { redis: createMemRedis(), keys: deriveKeys(SECRET) }, send: async () => {}, getIp: () => '', origin: 'https://x.test' });
    assert.equal(deps.tron.qps, 4, '老 TronGrid 客户端按 TRON_NODE_QPS');
    await deps.db.end?.();
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(console, saved);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 三、老 TronGrid 客户端：429 / 503 重试 ----------

/** 按顺序回应：script 里每一项是 200 或 { status, retryAfter }；用完后一直 200 */
function scripted(script, okBody) {
  const calls = [];
  const queue = [...script];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), path: new URL(url).pathname, body: init.body });
    const s = queue.length ? queue.shift() : 200;
    if (s === 'down') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (s === 200) return Response.json(okBody);
    const headers = { 'content-type': 'text/plain' };
    if (s.retryAfter !== undefined) headers['retry-after'] = String(s.retryAfter);
    return new Response('Too Many Requests', { status: s.status, headers });
  };
  return { calls, fetchImpl };
}
function fakeSleep() { const waits = []; return { waits, sleep: async (ms) => { waits.push(Number(ms)); } }; }
const gridWith = (fetchImpl, sleep) => createTronGrid({ network: 'nile', base: BASE, apiKey: KEY, fetchImpl, sleep, qps: 1000 });
const BAL = { result: { result: true }, constant_result: ['0'.repeat(56) + '05f5e100'] };

test('老 TronGrid 客户端：429 两次后成功 → 正常返回（共 3 次请求、等 2 次、退避不缩短、每次 ≤ 10 秒）；503 同样重试', async () => {
  const { sleep, waits } = fakeSleep();
  const n = scripted([{ status: 429 }, { status: 429 }, 200], BAL);
  assert.equal(await gridWith(n.fetchImpl, sleep).usdtBalance(randomTron()), 100_000_000);
  assert.equal(n.calls.length, 3);
  assert.equal(waits.length, 2);
  assert.ok(waits.every((w) => w > 0 && w <= 10_000) && waits[1] >= waits[0], `退避：${waits}`);
  const f2 = fakeSleep();
  const n2 = scripted([{ status: 503 }, 200], BAL);
  assert.equal(await gridWith(n2.fetchImpl, f2.sleep).usdtBalance(randomTron()), 100_000_000);
  assert.equal(n2.calls.length, 2);
});

test('老 TronGrid 客户端：Retry-After 照着等（最多 10 秒）；一直 429 → 最多 4 次，合计 ≤ 15 秒，抛 code rpc_http + httpStatus 429，不泄露节点地址和 Key', async () => {
  const f = fakeSleep();
  const n = scripted([{ status: 429, retryAfter: 3 }, { status: 429, retryAfter: 120 }, 200], BAL);
  await gridWith(n.fetchImpl, f.sleep).usdtBalance(randomTron());
  assert.ok(f.waits[0] >= 3000 && f.waits[0] <= 10_000, `Retry-After: 3：${f.waits}`);
  assert.ok(f.waits[1] <= 10_000, `Retry-After: 120 也最多等 10 秒：${f.waits}`);
  for (const status of [429, 503]) {
    const g = fakeSleep();
    const m = scripted(Array.from({ length: 10 }, () => ({ status })), BAL);
    let err;
    try { await gridWith(m.fetchImpl, g.sleep).usdtBalance(randomTron()); } catch (e) { err = e; }
    assert.ok(err, `${status}：要抛出`);
    assert.equal(m.calls.length, 4, `${status}：最多请求 4 次，实际 ${m.calls.length}`);
    assert.equal(g.waits.length, 3);
    assert.ok(g.waits.reduce((s, w) => s + w, 0) <= 15_000, `合计 ≤ 15 秒：${g.waits}`);
    assert.equal(err.code, 'rpc_http', `${status}：code rpc_http（和 TRON 适配器一样，后台据此给 node_busy）`);
    assert.equal(err.httpStatus, status);
    assert.ok(!String(err.message).includes(KEY) && !String(err.message).includes('example.invalid'), `错误信息不含节点地址 / Key：${err.message}`);
  }
});

test('老 TronGrid 客户端：400 / 404 不重试；连不上 → code rpc_unreachable（不重试、不泄露地址）', async () => {
  for (const status of [400, 404]) {
    const f = fakeSleep();
    const n = scripted([{ status }, { status }], BAL);
    await assert.rejects(gridWith(n.fetchImpl, f.sleep).usdtBalance(randomTron()));
    assert.equal(n.calls.length, 1, `${status} 不重试`);
    assert.equal(f.waits.length, 0);
  }
  const f = fakeSleep();
  const n = scripted(['down', 200], BAL);
  let err;
  try { await gridWith(n.fetchImpl, f.sleep).usdtBalance(randomTron()); } catch (e) { err = e; }
  assert.equal(err?.code, 'rpc_unreachable', `连不上：code rpc_unreachable（现在：${err?.code} ${err?.name}）`);
  assert.ok(!String(err.message).includes(KEY));
  assert.equal(n.calls.length, 1, '连不上不重试（不知道节点收没收到）');
});

test('广播重试发的是同一笔已签名交易（请求体逐字节相同），不重新建交易：老客户端 broadcastHex、TRON 适配器 broadcastHex', async () => {
  const signed = '0a' + randomBytes(120).toString('hex');
  const f = fakeSleep();
  const n = scripted([{ status: 503 }, { status: 429 }, 200], { result: true, txid: 'ab'.repeat(32) });
  assert.equal(await gridWith(n.fetchImpl, f.sleep).broadcastHex(signed), 'ab'.repeat(32));
  assert.equal(n.calls.length, 3, '503、429 之后第 3 次成功');
  assert.ok(n.calls.every((c) => c.path.endsWith('/wallet/broadcasthex')), `只调广播，不重新建交易：${n.calls.map((c) => c.path)}`);
  assert.equal(new Set(n.calls.map((c) => c.body)).size, 1, '每次发的请求体完全相同');
  assert.equal(JSON.parse(n.calls[0].body).transaction, signed);

  const n2 = scripted([{ status: 503 }, 200], { result: true, code: 'SUCCESS', txid: 'cd'.repeat(32) });
  const a = createTronAdapter({ base: BASE, fetchImpl: n2.fetchImpl, usdt: randomTron(), timeoutMs: 2000, sleep: async () => {} });
  await a.broadcastHex(signed);
  assert.equal(n2.calls.length, 2);
  assert.equal(new Set(n2.calls.map((c) => c.body)).size, 1, '适配器重试也是同一份');
});

// ---------- 四、追平测算 ----------

test('追平测算：1,200 个区块积压、默认 QPS（10）、节点每 3 秒出一个块 → 用适配器追平，打印模拟用时；不超过"请求数 ÷ QPS × 1.2 + 5 秒"', async () => {
  const clk = virtualClock();
  const usdt = randomTron();
  const HEAD0 = 50_000, BACKLOG = 1200, CONF = 19;
  const node = fakeTronNode({ head: HEAD0 });
  const to = randomTron();
  const cursor0 = HEAD0 - CONF - BACKLOG;
  const planted = [cursor0 + 1, cursor0 + 401, cursor0 + 777, HEAD0 - CONF];
  for (const b of planted) node.transfer({ token: usdt, to, amount: 1_000_000n, block: b });
  const starts = [];
  const fetchImpl = async (url, init) => {
    node.state.head = HEAD0 + Math.floor(clk.now() / 3000); // 按模拟时间出新块
    starts.push(clk.now());
    return node.fetchImpl(url, init);
  };
  const a = createTronAdapter({ base: node.base, fetchImpl, usdt, confirmations: CONF, maxRange: 100, timeoutMs: 5000, sleep: clk.sleep, now: clk.now });
  assert.equal(a.qps, 10, '默认 QPS 10');
  const found = [];
  let cursor = String(cursor0), rounds = 0;
  await clk.run((async () => {
    for (;;) {
      const r = await a.transfers({ cursor, addresses: [to] });
      found.push(...r.deposits.map((d) => d.block));
      rounds++;
      const caughtUp = Number(r.next) >= node.state.head - CONF;
      cursor = r.next;
      if (caughtUp) break;
      if (rounds > 100) throw new Error('100 段还没追平');
    }
  })());
  const secs = clk.now() / 1000;
  const reqs = starts.length;
  const blocks = Number(cursor) - cursor0;
  console.log(`[追平测算] 积压 ${BACKLOG} 个区块，QPS ${a.qps}：${rounds} 段、${reqs} 个节点请求，模拟用时 ${secs.toFixed(1)} 秒（约 ${(secs / 60).toFixed(1)} 分钟），`
    + `期间节点又出了 ${Math.floor(clk.now() / 3000)} 个块，共扫 ${blocks} 个块，约 ${(blocks / secs).toFixed(1)} 块/秒；`
    + `不含 worker 每轮之间的间隔（每 15 秒一轮，每轮最多 5 段 = 500 块）`);
  assert.deepEqual([...new Set(found)].sort((x, y) => x - y), planted, '积压里的到账全部找到');
  assert.ok(peakPerSecond(starts) <= 10, `任意 1 秒内请求 ≤ 10：峰值 ${peakPerSecond(starts)}`);
  const bound = (reqs / 10) * 1.2 + 5;
  assert.ok(secs <= bound, `追平用时 ${secs.toFixed(1)} 秒，超过上限 ${bound.toFixed(1)} 秒（限流之外不该有额外的等待）`);
});

// ---------- 五、节点落后不下结论（归集确认 not_broadcast） ----------

const MIN = 60_000;
const T0 = Date.parse('2026-12-01T04:00:00Z');

/** 以太坊：广播时连不上 → 批次"已发送、结果不确定"；节点之后一直不认识这笔交易 */
async function evmUncertain() {
  const { createEvmAdapter } = await import('../server/wallet/adapters/evm.js');
  const { createContractProvider } = await import('../server/wallet/providers/contract.js');
  const { addressFor } = await import('../server/wallet/addresses.js');
  const { proposeSweep, approveSweep, getBatch } = await import('../server/wallet/sweep.js');
  const { readFileSync } = await import('node:fs');
  const V = JSON.parse(readFileSync(new URL('./fixtures/wallet/create2-vectors-topup.json', import.meta.url), 'utf8'));
  const SCHEME = { ver: 1, factory: V.factory, implementation: V.implementation, parent: V.parents[0], batcher: V.feeAddresses[0] };
  const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
  const db = await setupDb({ customers: [['m1', 'c1']] });
  const node = fakeEvm({ head: 1000 });
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (!Array.isArray(body) && body.method === 'eth_getTransactionByHash' && !node.state.down) return Response.json({ jsonrpc: '2.0', id: body.id, result: null });
    return node.fetchImpl(url, init);
  };
  const adapter = createEvmAdapter({ chain: 'eth', rpcUrl: node.rpcUrl, fetchImpl, usdt: USDT, decimals: 6, confirmations: 12 });
  const providers = { contract: await createContractProvider({ db, chains: { eth: { adapter, scheme: SCHEME, usdt: USDT } }, operatorKey: '0x' + randomBytes(32).toString('hex') }) };
  const { address } = await addressFor(db, { merchantId: 'm1', customerId: 'c1', chain: 'eth', providers, now: T0 });
  node.state.balances[address.toLowerCase()] = 500n * 1_000_000n;
  node.state.downFor = ['eth_sendRawTransaction'];
  const [b] = await proposeSweep(db, { chain: 'eth', providers, notify: async () => {}, now: T0 });
  const r = await approveSweep(db, { id: b.id, actor: 'admin@x', reason: 'r', providers, now: T0 + MIN });
  assert.equal(r.broadcast, 'uncertain', '前提：广播时连不上节点，结果不确定');
  node.state.downFor = [];
  return { db, providers, id: b.id, sentAt: Date.parse((await getBatch(db, b.id)).updatedAt), setHead: (h) => { node.state.head = h; }, chain: 'eth', head: 1000 };
}

/** TRON：广播时连不上 → 已发送、结果不确定；节点不认识这笔交易 */
async function tronUncertain() {
  const { createContractProvider } = await import('../server/wallet/providers/contract.js');
  const { addressFor } = await import('../server/wallet/addresses.js');
  const { proposeSweep, approveSweep, getBatch } = await import('../server/wallet/sweep.js');
  const core = await import('../server/pay/core.js');
  const { scheme, usdt } = tronScheme();
  const operator = testOperator();
  const node = fakeTronNode({ head: 1000, scheme, usdt });
  node.activate(operator.address, 5_000_000_000);
  const db = await setupDb({ customers: [['m1', 'c1']] });
  const adapter = createTronAdapter({ base: node.base, fetchImpl: node.fetchImpl, usdt, confirmations: 19, timeoutMs: 2000, sleep: async () => {} });
  const providers = { contract: createContractProvider({ db, chains: { tron: { adapter, scheme, usdt } }, tronOperatorKey: operator.key }) };
  const { address } = await addressFor(db, { merchantId: 'm1', customerId: 'c1', chain: 'tron', providers, now: T0 });
  const tx = node.transfer({ to: address, amount: 500_000_000n, block: node.state.head });
  await core.recordDeposit(db, { chain: 'tron', txid: tx.txid, logIndex: 0, block: tx.block, time: T0, from: randomTron(), to: address, amount: 500_000_000, rawAmount: '500000000' });
  node.state.downFor = ['/wallet/broadcasthex'];
  const [b] = await proposeSweep(db, { chain: 'tron', providers, notify: async () => {}, now: T0 });
  assert.ok(b, '前提：凑出了一批');
  const r = await approveSweep(db, { id: b.id, actor: 'admin@x', reason: 'r', providers, now: T0 + MIN });
  assert.equal(r.broadcast, 'uncertain', `前提：TRON 广播时连不上节点，结果不确定（现在 ${JSON.stringify(r)}）`);
  node.state.downFor = [];
  return { db, providers, id: b.id, sentAt: Date.parse((await getBatch(db, b.id)).updatedAt), setHead: (h) => { node.state.head = h; }, chain: 'tron', head: node.state.head };
}

for (const [label, mk] of [['以太坊', evmUncertain], ['TRON', tronUncertain]]) {
  test(`归集确认（${label}）：发出 15 分钟后节点不认识这笔交易，但这个节点的最新区块号低于扫块记下的 → 这一轮不算数（仍是已发送）；节点追上后才标失败 not_broadcast`, async () => {
    const { confirmSweeps, getBatch } = await import('../server/wallet/sweep.js');
    const s = await mk();
    const seen = s.head + 500; // 扫块时见过的最新区块号（另一个更新的后端）
    await setMeta(s.db, `evm_scan_${s.chain}`, { at: new Date(s.sentAt).toISOString(), cursor: String(seen - 20), head: seen });
    const mails = [];
    await confirmSweeps(s.db, { providers: s.providers, notify: async (x) => { mails.push(x); }, now: s.sentAt + 16 * MIN });
    const mid = await getBatch(s.db, s.id);
    assert.equal(mid.status, 'sent', `节点落后（head ${s.head} < 扫块见过的 ${seen}）时"查不到"不算数，批次仍是已发送（现在 ${mid.status}）`);
    assert.equal(mails.filter((x) => /归集失败/.test(x)).length, 0, '不发失败邮件');
    s.setHead(seen + 1);
    await confirmSweeps(s.db, { providers: s.providers, notify: async (x) => { mails.push(x); }, now: s.sentAt + 17 * MIN });
    const after = await getBatch(s.db, s.id);
    assert.equal(after.status, 'failed', '节点追上后仍不认识：标失败');
    assert.ok(after.items.every((i) => i.status === 'released' && i.reason === 'not_broadcast'), JSON.stringify(after.items, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    await s.db.end?.();
  });
}
