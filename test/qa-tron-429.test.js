// 测试先写（测试经理）：TRON 节点限流（HTTP 429 / 503）时"现在就凑一批"不能 500。开发不要改这个文件。
// 现象（测试环境实际执行）：20 个已到账的 TRON 合约地址点"TRON：现在就凑一批"返回 500"服务器出错了"；日志里是 TronGrid 的
//   HTTP 429（/wallet/getcontract、/wallet/triggerconstantcontract），来自凑批时并发查余额 / 是否已部署（balanceConcurrency 8）。
//   正式环境每批最多 50 个地址、候选更多，问题只会更明显。
// 这里定下的约定（开发按这个做；数字有异议找测试经理改测试，不要自己改）：
//   1. TRON 适配器（server/wallet/adapters/tron.js 的 createTronAdapter）：
//      - 新参数 sleep：async (ms) => void，等待重试时用它（默认用真的计时器）；测试注入假的 sleep，不真等
//      - 节点返回 HTTP 429 或 503：自动重试，每个请求最多 4 次（第 1 次 + 重试 3 次）；后面哪次成功就正常返回
//      - 重试间隔：退避（每次间隔 > 0，且不比上一次短），没有 Retry-After 时每次 ≤ 10 秒、3 次合计 ≤ 15 秒；
//        有 Retry-After（秒数）时那一次至少等这么久，但最多 10 秒（Retry-After: 120 也只等 ≤ 10 秒，不卡住后台请求）
//      - 其他 HTTP 错误（例如 400、404）不重试，只请求 1 次
//      - 4 次都失败：抛 TronNodeError，code 仍是 'rpc_http'（现有 isConnectionError 照旧把它算连接类错误，广播时不会误判为失败），
//        另带 httpStatus（429 / 503）作为"限流 / 节点繁忙"的识别依据；错误信息不含节点地址和 API Key
//   2. proposeSweep（server/wallet/sweep.js）凑 TRON 批次：对 TRON 节点同时在途的请求 ≤ 3 个（建议 2～3；TronGrid 带 Key 也有每秒次数限制），
//      不论调用方传不传 balanceConcurrency；部分请求 429 时靠重试凑出批次，不报错
//   3. 管理员"现在就凑一批"（wallet-sweep-propose）：节点一直 429 → PayError('node_busy', 503)，不是 500；不建批次、不发邮件；
//      运营后台（site/src/scripts/admin-wallet.ts 的 ERR）给 node_busy 一句中文："节点繁忙……稍后再试"
//   附带（同一个 500 的另一种来源）：节点连不上 → PayError('rpc_unreachable', 503)，后台 ERR 里 rpc_unreachable 也要有中文说明
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeTronNode, tronScheme, testOperator, randomTron } from './tron-helpers.js';
import { setupDb } from './wallet-helpers.js';

const usd = (n) => BigInt(Math.round(n * 1e6));
const MAX_ATTEMPTS = 4;
const MAX_INFLIGHT = 3;
const KEY = 'k3y-should-not-leak';
const BASE = 'https://tron-node.example.invalid/' + KEY;

/** 假的 sleep：只记录要等多久，不真等 */
function fakeSleep() {
  const waits = [];
  return { waits, sleep: async (ms) => { waits.push(Number(ms)); } };
}

/** 按顺序回应的假节点：script 里每一项是 200（正常结果）或 { status, retryAfter }；用完后一直返回正常结果 */
function scripted(script, okBody) {
  const calls = [];
  const queue = [...script];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ path: new URL(url).pathname, body: init.body });
    const s = queue.length ? queue.shift() : 200;
    if (s === 200) return new Response(JSON.stringify(okBody), { status: 200, headers: { 'content-type': 'application/json' } });
    const headers = { 'content-type': 'text/plain' };
    if (s.retryAfter !== undefined) headers['retry-after'] = String(s.retryAfter);
    return new Response('Too Many Requests', { status: s.status, headers });
  };
  return { calls, fetchImpl };
}

async function adapterWith(fetchImpl, sleep) {
  const { createTronAdapter } = await import('../server/wallet/adapters/tron.js');
  return createTronAdapter({ base: BASE, fetchImpl, usdt: randomTron(), apiKey: KEY, timeoutMs: 2000, sleep });
}

// ---------- 1. 适配器：429 / 503 重试 ----------

test('TRON 适配器：HTTP 429 后重试，第 3 次成功就正常返回（共请求 3 次，等了 2 次，用注入的 sleep、退避不缩短）', async () => {
  const { sleep, waits } = fakeSleep();
  const node = scripted([{ status: 429 }, { status: 429 }, 200], { bytecode: '6080', contract_address: '41' + '11'.repeat(20) });
  const a = await adapterWith(node.fetchImpl, sleep);
  assert.equal(await a.isContract(randomTron()), true, '重试后拿到正常结果');
  assert.equal(node.calls.length, 3, '429 两次 + 成功一次 = 3 次请求');
  assert.ok(node.calls.every((c) => c.path.endsWith('/wallet/getcontract')));
  assert.equal(waits.length, 2, '每次重试前等一下（走注入的 sleep，不真等）');
  assert.ok(waits.every((w) => w > 0 && w <= 10_000), `每次间隔 0～10 秒：${waits}`);
  assert.ok(waits[1] >= waits[0], `退避：第二次不比第一次短：${waits}`);
});

test('TRON 适配器：HTTP 503 同样重试；余额查询（triggerconstantcontract）中途 429 也能拿到余额', async () => {
  const { sleep, waits } = fakeSleep();
  const node = scripted([{ status: 503 }, 200], { result: { result: true }, constant_result: ['0'.repeat(56) + '05f5e100'] });
  const a = await adapterWith(node.fetchImpl, sleep);
  assert.equal(await a.tokenBalanceRaw(randomTron()), 100_000_000n);
  assert.equal(node.calls.length, 2);
  assert.equal(waits.length, 1);

  const { sleep: s2 } = fakeSleep();
  const n2 = scripted([{ status: 429 }, { status: 429 }, { status: 429 }, 200], { result: { result: true }, constant_result: ['0'.repeat(63) + '7'] });
  const a2 = await adapterWith(n2.fetchImpl, s2);
  assert.equal(await a2.tokenBalanceRaw(randomTron()), 7n, '第 4 次（最后一次）成功也算成功');
  assert.equal(n2.calls.length, MAX_ATTEMPTS);
});

test('TRON 适配器：Retry-After 有就照着等（但最多 10 秒）；没有时 3 次间隔合计 ≤ 15 秒', async () => {
  const { sleep, waits } = fakeSleep();
  const node = scripted([{ status: 429, retryAfter: 2 }, { status: 429, retryAfter: 120 }, 200], {});
  const a = await adapterWith(node.fetchImpl, sleep);
  assert.equal(await a.isContract(randomTron()), false);
  assert.equal(waits.length, 2);
  assert.ok(waits[0] >= 2000 && waits[0] <= 10_000, `Retry-After: 2 → 至少等 2 秒：${waits[0]}`);
  assert.ok(waits[1] <= 10_000, `Retry-After: 120 → 最多等 10 秒，不卡住后台请求：${waits[1]}`);

  const f = fakeSleep();
  const n2 = scripted([{ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }], {});
  const a2 = await adapterWith(n2.fetchImpl, f.sleep);
  await assert.rejects(a2.isContract(randomTron()));
  assert.equal(f.waits.length, MAX_ATTEMPTS - 1, '4 次请求之间等 3 次，最后一次失败后不再等');
  assert.ok(f.waits.reduce((s, w) => s + w, 0) <= 15_000, `合计 ≤ 15 秒：${f.waits}`);
});

test('TRON 适配器：一直 429 / 503 → 最多请求 4 次，抛 TronNodeError（code rpc_http、带 httpStatus），仍算连接类错误、不泄露节点地址', async () => {
  const { TronNodeError } = await import('../server/wallet/adapters/tron.js');
  const { isConnectionError } = await import('../server/wallet/providers/contract-tron.js');
  const { isConnectionError: isConnEvm } = await import('../server/wallet/providers/contract.js');
  for (const status of [429, 503]) {
    const { sleep } = fakeSleep();
    const node = scripted(Array.from({ length: 10 }, () => ({ status })), {});
    const a = await adapterWith(node.fetchImpl, sleep);
    let err;
    try { await a.isContract(randomTron()); } catch (e) { err = e; }
    assert.ok(err, `${status}：要抛出`);
    assert.equal(node.calls.length, MAX_ATTEMPTS, `${status}：最多请求 ${MAX_ATTEMPTS} 次，实际 ${node.calls.length}`);
    assert.ok(err instanceof TronNodeError, `${status}：要是 TronNodeError，不是普通 Error：${err?.constructor?.name}`);
    assert.equal(err.code, 'rpc_http');
    assert.equal(err.httpStatus, status, `${status}：错误上带 httpStatus（识别限流 / 节点繁忙）`);
    assert.ok(isConnectionError(err) && isConnEvm(err), '仍算连接类错误（广播时不误判为发送失败）');
    assert.ok(!String(err.message).includes(KEY) && !String(err.message).includes('example.invalid'), `错误信息不含节点地址 / API Key：${err.message}`);
  }
});

test('TRON 适配器：HTTP 400 / 404 不重试（只请求 1 次），照旧抛 rpc_http', async () => {
  for (const status of [400, 404]) {
    const { sleep, waits } = fakeSleep();
    const node = scripted([{ status }, { status }, { status }], {});
    const a = await adapterWith(node.fetchImpl, sleep);
    await assert.rejects(a.isContract(randomTron()), (e) => e.code === 'rpc_http');
    assert.equal(node.calls.length, 1, `${status} 不重试`);
    assert.equal(waits.length, 0);
  }
});

// ---------- 2. 凑批：部分 429 也能凑出来，并发有上限 ----------

/**
 * 包一层替身节点：记录同时在途的请求数（峰值）；paths 里的请求每 every 次返回一次 429（mode = 'always' 时一直 429，'down' 时连不上）
 * 每个请求先让出一轮事件循环（setImmediate），并发的请求才会同时"在途"、峰值才量得出来
 */
function limitedNode(node, { every = 3, mode = 'some', paths = ['/wallet/getcontract', '/wallet/triggerconstantcontract'] } = {}) {
  const st = { inflight: 0, peak: 0, n: 0, r429: 0 };
  const fetchImpl = async (url, init = {}) => {
    st.inflight++;
    st.peak = Math.max(st.peak, st.inflight);
    try {
      await new Promise((r) => setImmediate(r));
      const path = new URL(typeof url === 'string' ? url : String(url)).pathname;
      if (paths.includes(path)) {
        if (mode === 'down') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
        if (mode === 'always' || ++st.n % every === 0) {
          st.r429++;
          return new Response('Too Many Requests', { status: 429, headers: { 'content-type': 'text/plain', ...(st.r429 % 2 ? { 'retry-after': '1' } : {}) } });
        }
      }
      return await node.fetchImpl(url, init);
    } finally { st.inflight--; }
  };
  return { st, fetchImpl };
}

/** contract 提供方只开 TRON；n 个客户各一个 TRON 合约地址，每个到账 amount USDT（链上余额 + 到账记录） */
async function setupTron({ customers = 20, amount = 200, wrap = {} } = {}) {
  const { createContractProvider } = await import('../server/wallet/providers/contract.js');
  const { createTronAdapter } = await import('../server/wallet/adapters/tron.js');
  const { addressFor } = await import('../server/wallet/addresses.js');
  const core = await import('../server/pay/core.js');
  const { scheme, usdt } = tronScheme();
  const operator = testOperator();
  const node = fakeTronNode({ head: 1000, scheme, usdt });
  node.activate(operator.address, 5_000_000_000);
  const db = await setupDb({ customers: Array.from({ length: customers }, (_, i) => ['m1', `c${i + 1}`]) });
  // 先用不限流的适配器分配地址、记到账，再换成限流的节点
  const plain = createTronAdapter({ base: node.base, fetchImpl: node.fetchImpl, usdt, confirmations: 19, timeoutMs: 2000 });
  const p0 = createContractProvider({ db, chains: { tron: { adapter: plain, scheme, usdt } }, tronOperatorKey: operator.key });
  const addrs = [];
  for (let i = 1; i <= customers; i++) addrs.push((await addressFor(db, { merchantId: 'm1', customerId: `c${i}`, chain: 'tron', providers: { contract: p0 } })).address);
  for (const a of addrs) {
    const raw = usd(amount);
    const tx = node.transfer({ to: a, amount: raw, block: node.state.head });
    await core.recordDeposit(db, { chain: 'tron', txid: tx.txid, logIndex: 0, block: tx.block, time: Date.now(), from: randomTron(), to: a, amount: Number(raw), rawAmount: String(raw) });
  }
  const lim = limitedNode(node, wrap);
  const { sleep, waits } = fakeSleep();
  const adapter = createTronAdapter({ base: node.base, fetchImpl: lim.fetchImpl, usdt, confirmations: 19, timeoutMs: 2000, sleep });
  const p = createContractProvider({ db, chains: { tron: { adapter, scheme, usdt } }, tronOperatorKey: operator.key });
  return { db, node, lim, waits, adapter, providers: { contract: p }, addrs };
}

test(`凑批（TRON，20 个已到账地址）：节点每 3 次请求有 1 次 429 → 照样凑出 1 批 20 个地址，不报错；对节点同时在途 ≤ ${MAX_INFLIGHT} 个`, async () => {
  const { proposeSweep } = await import('../server/wallet/sweep.js');
  const t = await setupTron({ customers: 20, amount: 200 });
  const mails = [];
  let bs;
  try {
    bs = await proposeSweep(t.db, { chain: 'tron', providers: t.providers, notify: async (s, x) => mails.push([s, x]) });
  } catch (e) {
    assert.fail(`部分请求 429 时凑批不该报错（现在：${e?.message}）`);
  }
  assert.ok(t.lim.st.r429 > 0, '前提：确实有请求被 429');
  assert.equal(bs.length, 1, '20 × 200 USDT，一批装得下');
  assert.equal(bs[0].items.length, 20);
  assert.deepEqual(bs[0].items.map((i) => i.address).sort(), [...t.addrs].sort());
  assert.equal(mails.length, 1, '凑批成功照常发一封邮件');
  assert.ok(t.lim.st.peak <= MAX_INFLIGHT, `对 TRON 节点同时在途的请求最多 ${MAX_INFLIGHT} 个，实际峰值 ${t.lim.st.peak}`);
});

test(`凑批（TRON）：调用方传 balanceConcurrency 8，对 TRON 节点同时在途仍 ≤ ${MAX_INFLIGHT} 个`, async () => {
  const { proposeSweep } = await import('../server/wallet/sweep.js');
  const t = await setupTron({ customers: 20, amount: 200, wrap: { every: 1_000_000 } }); // 不限流，只量并发
  const bs = await proposeSweep(t.db, { chain: 'tron', providers: t.providers, balanceConcurrency: 8 });
  assert.equal(bs.length, 1);
  assert.ok(t.lim.st.peak <= MAX_INFLIGHT, `峰值 ${t.lim.st.peak}`);
});

// ---------- 3. 管理员"现在就凑一批"：节点一直 429 → 503 node_busy ----------

async function adminActs(t) {
  const { walletAdminActions } = await import('../server/wallet/admin-actions.js');
  const mails = [];
  const layer = { enabledChains: ['tron'], providers: t.providers, adapters: { tron: t.adapter } };
  const acts = walletAdminActions({ db: t.db, layer, verifyAdminCode: async () => true, notify: async (s, x) => mails.push([s, x]), origin: 'https://admin.example.invalid' });
  return { acts, mails };
}
const batchCount = async (db) => (await db.query(`select count(*)::int n from wallet_sweep_batches`))[0].n;
const itemCount = async (db) => (await db.query(`select count(*)::int n from wallet_sweep_items`))[0].n;

test('现在就凑一批（TRON）：节点一直 429 → PayError node_busy 503（不是 500）；不建批次、不发邮件；后台显示"节点繁忙，稍后再试"', async () => {
  const { PayError } = await import('../server/pay/core.js');
  const { errorResponse } = await import('../server/pay/common.js');
  const t = await setupTron({ customers: 20, amount: 200, wrap: { mode: 'always' } });
  const { acts, mails } = await adminActs(t);
  let err;
  try { await acts['wallet-sweep-propose']({ chain: 'tron' }, 'admin@example.invalid'); } catch (e) { err = e; }
  assert.ok(err, '要抛出');
  assert.ok(err instanceof PayError, `要是 PayError（否则接口统一返回 500"服务器出错了"）：${err?.constructor?.name} ${err?.message}`);
  assert.equal(err.code, 'node_busy');
  assert.equal(err.status, 503);
  const res = errorResponse(err);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'node_busy');
  assert.equal(await batchCount(t.db), 0, '不建批次');
  assert.equal(await itemCount(t.db), 0);
  assert.equal(mails.length, 0, '不发邮件');
  assert.ok(t.waits.length > 0, '放弃前确实重试过（走注入的 sleep）');

  const src = readFileSync(new URL('../site/src/scripts/admin-wallet.ts', import.meta.url), 'utf8');
  const m = src.match(/\bnode_busy\s*:\s*'([^']*)'/);
  assert.ok(m, '后台 admin-wallet.ts 的 ERR 里要有 node_busy');
  assert.match(m[1], /节点繁忙/);
  assert.match(m[1], /稍后再试/);
  assert.ok(!/[A-Za-z]{4,}/.test(m[1].replace(/TRON|TronGrid/g, '')), `给管理员看的是中文：${m[1]}`);
});

test('现在就凑一批（TRON）附带：节点连不上 → PayError rpc_unreachable 503（不是 500）；不建批次；后台 ERR 里有 rpc_unreachable 的中文说明', async () => {
  const { PayError } = await import('../server/pay/core.js');
  const t = await setupTron({ customers: 5, amount: 200, wrap: { mode: 'down' } });
  const { acts, mails } = await adminActs(t);
  let err;
  try { await acts['wallet-sweep-propose']({ chain: 'tron' }, 'admin@example.invalid'); } catch (e) { err = e; }
  assert.ok(err instanceof PayError, `要是 PayError：${err?.constructor?.name} ${err?.message}`);
  assert.equal(err.code, 'rpc_unreachable');
  assert.equal(err.status, 503);
  assert.equal(await batchCount(t.db), 0);
  assert.equal(mails.length, 0);
  const src = readFileSync(new URL('../site/src/scripts/admin-wallet.ts', import.meta.url), 'utf8');
  const m = src.match(/\brpc_unreachable\s*:\s*'([^']*)'/);
  assert.ok(m, '后台 admin-wallet.ts 的 ERR 里要有 rpc_unreachable');
  assert.match(m[1], /节点/);
  assert.match(m[1], /稍后再试/);
});
