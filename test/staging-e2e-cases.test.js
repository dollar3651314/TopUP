// 测试环境业务验收用例（e2e/staging-e2e/ 的 E02～E11）在本机整套跑一遍，和 staging-e2e-kit.test.js 一样：
// 起一个 APP_ENV=staging 的 web（真实 Postgres、Redis，独立 schema）、配上随机测试令牌的哈希；另建一个测试商户（API Key、来源地址白名单 127.0.0.1、100 USDT 余额）。
// TronGrid（nile）在这个进程里用替身回答（热钱包余额、交易原文），不连外网；以太坊、BSC 没配节点（以太坊打款没开通、没有能归集的链）。
//   ① 带商户 Key 跑全部用例：全部通过；只有"归集凑批"因为本机凑不出归集批次（没有开通的链或没有够门槛的余额）而跳过；跑完商户造的单全部驳回、余额和冻结复原、上限和原来一样、没有没签名的批次
//   ② 不带商户 Key：要建单的步骤跳过并写明原因，其余照常通过
//   ③ 带 Key 但来源地址不在商户白名单：要建单的步骤跳过并写明原因
// 输出里不能有令牌和商户 Secret。需要 TEST_DATABASE_URL、TEST_REDIS_URL（CI 的第二轮单元测试有）；没有时跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.js';
import { createPgDb } from '../server/pay/db.js';
import { createMerchant } from '../server/pay/core.js';
import { createFakeTron } from '../server/pay/fake-trongrid.js';
import { hexToAddress } from '../server/pay/tron.js';
import { TRON_GENESIS_NILE } from './tron-helpers.js';

const PG = process.env.TEST_DATABASE_URL || '';
const RD = process.env.TEST_REDIS_URL || '';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skip = PG && RD ? false : '没有设置 TEST_DATABASE_URL、TEST_REDIS_URL';
const CASES = ['payout-review', 'payout-plan', 'payout-limits', 'sweep-recon', 'permissions'].map((f) => `e2e/staging-e2e/${f}.test.mjs`);

/** 把 createWeb 的 handle 挂到本机随机端口；像 Nginx 一样写入 x-real-ip 请求头（开放 API 的来源地址白名单用它） */
async function serve(handle) {
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    headers.set('x-real-ip', '127.0.0.1');
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
    const r = await handle(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body }));
    const h = {}; r.headers.forEach((v, k) => (h[k] = v));
    res.writeHead(r.status, h); res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

/** TronGrid 的替身：只回答这几个用例会用到的接口（账户、USDT 余额、构造 USDT 转账），其余 503 */
function fakeTronGrid(realFetch) {
  const fake = createFakeTron({ network: 'nile' });
  const HOT_USDT = 100_000_000; // 热钱包 100 测试 USDT
  return async (input, init = {}) => {
    const url = String(input?.url || input);
    // TRON_NODE_URL 指的本机关着的端口（127.0.0.1:9）也由替身回答：K-4 起测试管理员要核对 TRON 节点的创世块是 Nile
    if (!/^https:\/\/[a-z.]*trongrid\.io\//.test(url) && !url.startsWith('http://127.0.0.1:9/')) return realFetch(input, init);
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : {};
    if (path === '/wallet/getblockbynum' && Number(body.num) === 0) return Response.json({ blockID: TRON_GENESIS_NILE, block_header: { raw_data: { number: 0 } } });
    if (url.startsWith('http://127.0.0.1:9/')) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); // 其余照旧连不上
    if (path.startsWith('/v1/accounts/')) return Response.json({ data: [{ balance: 1_000_000_000, trc20: [] }] });
    if (path === '/wallet/triggerconstantcontract') return Response.json({ result: { result: true }, constant_result: [HOT_USDT.toString(16).padStart(64, '0')] });
    if (path === '/wallet/triggersmartcontract') {
      const p = String(body.parameter || '');
      const tx = await fake.buildUsdtTransfer({ from: body.owner_address, to: hexToAddress(`41${p.slice(24, 64)}`), amount: Number(BigInt(`0x${p.slice(64)}`)), feeLimit: body.fee_limit });
      return Response.json({ result: { result: true }, transaction: tx });
    }
    return new Response('{}', { status: 503 });
  };
}

function run(env, args = []) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [join(ROOT, 'e2e/staging-e2e/run.mjs'), ...args], { env: { PATH: process.env.PATH, ...env }, cwd: ROOT });
    let out = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => ok({ code, out }));
  });
}
const count = (out, what) => Number((new RegExp(`ℹ ${what} (\\d+)`).exec(out) || [])[1] ?? NaN);

test('E02～E11 在本机的测试环境跑：带商户 Key 全部通过且数据复原；不带 Key、来源地址不在白名单时要建单的步骤跳过并写明原因', { skip, timeout: 300_000 }, async () => {
  const token = `tta_${randomBytes(32).toString('hex')}`;
  const hash = createHash('sha256').update(token).digest('hex');
  const schema = `t_e2ecases_${Date.now().toString(36)}`;
  const admin = await createPgDb(PG); await admin.query(`create schema ${schema}`);
  const u = new URL(PG); u.searchParams.set('options', `-c search_path=${schema}`);
  const dir = mkdtempSync(join(tmpdir(), 'topup-e2ecases-'));
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeTronGrid(realFetch);
  const { createWeb } = await import('../server/web.js');
  const err = console.error, log = console.log; console.error = () => {}; console.log = () => {};
  const web = createWeb(loadConfig({
    APP_ENV: 'staging', DATABASE_URL: u.toString(), REDIS_URL: RD, APP_SECRET: 'k'.repeat(40), BLOB_DIR: dir, PUBLIC_URL: 'https://x.test',
    TRON_NETWORK: 'nile', TRON_NODE_URL: 'http://127.0.0.1:9', TEST_ADMIN_TOKEN_SHA256: hash,
  }), { site: dir });
  const { server, url } = await serve(web.handle);
  const hide = (s) => s.replaceAll(token, '<令牌>');
  try {
    const pay = await web.app.then((a) => a.pay);
    const { db, ops } = pay;
    const fee = { ppm: 0, fixed: 0, min: 0 };
    const m = await createMerchant(db, { name: '本机验收商户', feeIn: fee, feeOut: fee });
    const { api_key: key, api_secret: secret } = await ops.regenerateSecret(m);
    await ops.setIpWhitelist(m, ['127.0.0.1']);
    await db.query('update balances set available = 100000000 where merchant_id = $1', [m.id]);
    const limits0 = JSON.stringify((await db.query(`select value from pay_meta where key = 'payout_limits'`))[0]?.value ?? null);
    const base = { STAGING_URL: url, STAGING_TEST_ADMIN_TOKEN: token, GITHUB_RUN_ID: '4242', GITHUB_RUN_ATTEMPT: '1' };
    const clean = (s) => hide(s).replaceAll(secret, '<Secret>');

    // ① 带商户 Key：全部通过，只有归集凑批跳过（本机凑不出归集批次）
    const r1 = await run({ ...base, STAGING_E2E_MERCHANT_KEY: key, STAGING_E2E_MERCHANT_SECRET: secret }, CASES);
    assert.equal(r1.code, 0, clean(r1.out));
    assert.ok(!r1.out.includes(token) && !r1.out.includes(secret), '输出里没有令牌和商户 Secret');
    assert.equal(count(r1.out, 'fail'), 0, clean(r1.out));
    assert.equal(count(r1.out, 'skipped'), 1, clean(r1.out));
    assert.match(r1.out, /﹣ E09 归集凑批[^\n]*# 没有(开通归集的链|凑出批次)/);
    // 数据复原：造的单全部驳回（带运行号）、余额和冻结回到原样、上限和原来一样、没有没签名的打款批次
    const ws = await db.query('select status, merchant_ref from withdrawals where merchant_id = $1', [m.id]);
    assert.ok(ws.length >= 8, `造了单（${ws.length} 笔）`);
    assert.ok(ws.every((w) => w.status === 'rejected'), `全部驳回：${ws.map((w) => w.status).join(',')}`);
    assert.ok(ws.every((w) => w.merchant_ref.startsWith('e2e-4242-1-')), 'merchant_ref 带运行号');
    const [b] = await db.query('select available, frozen from balances where merchant_id = $1', [m.id]);
    assert.equal(Number(b.available), 100_000_000);
    assert.equal(Number(b.frozen), 0);
    const limits1 = JSON.stringify((await db.query(`select value from pay_meta where key = 'payout_limits'`))[0]?.value ?? null);
    const [lim] = await db.query(`select value from pay_meta where key = 'payout_limits'`);
    assert.ok(limits0 === limits1 || (limits0 === 'null' && lim), '上限和跑之前一样（之前没存过的，写回的是默认值）');
    const [planned] = await db.query(`select count(*)::int n from payout_tx_batches where status = 'planned'`);
    assert.equal(planned.n, 0, '没有留下没签名的打款批次');
    const keys = await db.query('select key from idempotency where merchant_id = $1', [m.id]);
    assert.ok(keys.length > 0 && keys.every((k) => k.key.startsWith('e2e-4242-1-')), 'Idempotency-Key 带运行号');

    // ② 不带商户 Key：要建单的跳过并写明原因，其余通过
    const r2 = await run(base, CASES);
    assert.equal(r2.code, 0, hide(r2.out));
    assert.equal(count(r2.out, 'fail'), 0, hide(r2.out));
    assert.ok(count(r2.out, 'skipped') >= 8, hide(r2.out));
    assert.match(r2.out, /没有测试商户的 API Key/);

    // ③ 带 Key、来源地址不在白名单：建单的跳过并写明原因
    await ops.setIpWhitelist(m, ['127.0.0.2']);
    const r3 = await run({ ...base, STAGING_E2E_MERCHANT_KEY: key, STAGING_E2E_MERCHANT_SECRET: secret }, ['e2e/staging-e2e/payout-review.test.mjs']);
    assert.equal(r3.code, 0, clean(r3.out));
    assert.match(r3.out, /出网地址不在测试商户的来源地址白名单/);
  } finally {
    console.error = err; console.log = log;
    globalThis.fetch = realFetch;
    server.close();
    await (await web.app).close().catch(() => {});
    await admin.query(`drop schema ${schema} cascade`).catch(() => {});
    await admin.end();
    rmSync(dir, { recursive: true, force: true });
  }
});
