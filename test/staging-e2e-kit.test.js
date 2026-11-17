// 测试环境验收用例的工具（e2e/staging-e2e/run.mjs、lib.mjs、basics.test.mjs）在本机整套跑一遍：
// 起一个 APP_ENV=staging 的 web（真实 Postgres、Redis，独立 schema），配上随机生成的测试令牌的哈希，用 run.mjs 跑 basics.test.mjs，
// 要全部通过，输出里不能有令牌、不另存报告；用例进程只拿到白名单里的环境变量；健康检查不是 staging 的地址，run.mjs 一个用例都不跑。
// 需要 TEST_DATABASE_URL、TEST_REDIS_URL（CI 的第二轮单元测试有）；没有时跳过。不连任何外部服务（TRON 节点指向本机关着的端口）。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.js';
import { createPgDb } from '../server/pay/db.js';
import { fakeTronGridNet, TRON_GENESIS_NILE } from './tron-helpers.js';

const PG = process.env.TEST_DATABASE_URL || '';
const RD = process.env.TEST_REDIS_URL || '';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skip = PG && RD ? false : '没有设置 TEST_DATABASE_URL、TEST_REDIS_URL';

/** 把 createWeb 的 handle 挂到本机随机端口 */
async function serve(handle) {
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
    const r = await handle(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body }));
    const h = {}; r.headers.forEach((v, k) => (h[k] = v));
    res.writeHead(r.status, h); res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function run(env, args = []) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [join(ROOT, 'e2e/staging-e2e/run.mjs'), ...args], { env: { PATH: process.env.PATH, ...env }, cwd: ROOT });
    let out = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => ok({ code, out }));
  });
}

test('run.mjs 对本机的测试环境跑 basics.test.mjs：全部通过，输出里没有令牌、不另存报告', { skip, timeout: 120_000 }, async () => {
  const token = `tta_${randomBytes(32).toString('hex')}`;
  const hash = createHash('sha256').update(token).digest('hex');
  const schema = `t_e2ekit_${Date.now().toString(36)}`;
  const admin = await createPgDb(PG); await admin.query(`create schema ${schema}`); await admin.end();
  const u = new URL(PG); u.searchParams.set('options', `-c search_path=${schema}`);
  const dir = mkdtempSync(join(tmpdir(), 'topup-e2ekit-'));
  const { createWeb } = await import('../server/web.js');
  // TRON 节点（TRON_NODE_URL 指的本机关着的端口）和 TronGrid 由本机替身回答创世块：K-4 起测试管理员要核对节点真是 Nile
  const restoreNet = fakeTronGridNet({ '127.0.0.1:9': TRON_GENESIS_NILE });
  const err = console.error; console.error = () => {};
  const web = createWeb(loadConfig({
    APP_ENV: 'staging', DATABASE_URL: u.toString(), REDIS_URL: RD, APP_SECRET: 'k'.repeat(40), BLOB_DIR: dir, PUBLIC_URL: 'https://x.test',
    TRON_NETWORK: 'nile', TRON_NODE_URL: 'http://127.0.0.1:9', TEST_ADMIN_TOKEN_SHA256: hash,
  }), { site: dir });
  const { server, url } = await serve(web.handle);
  try {
    await web.app.then((a) => a.pay);
    const r = await run({ STAGING_URL: url, STAGING_TEST_ADMIN_TOKEN: token });
    assert.equal(r.code, 0, r.out.replace(token, '<令牌>'));
    assert.match(r.out, /测试管理员已开/);
    assert.ok(!r.out.includes(token), '输出里没有令牌');
    assert.ok(!existsSync(join(ROOT, 'e2e/staging-e2e/.out')), '不另存报告');
    // 用例进程：拿不到父进程的其他环境变量；加载 lib.mjs 后令牌已从环境里删掉（用例只能用请求函数）
    const probe = join(ROOT, 'e2e/staging-e2e/zz-kit-env-probe.test.mjs');
    writeFileSync(probe, "import test from 'node:test'; import assert from 'node:assert/strict'; import './lib.mjs';\n"
      + "test('env', () => { assert.ok(process.env.OTHER_PARENT_VAR === undefined, 'other'); assert.ok(process.env.STAGING_TEST_ADMIN_TOKEN === undefined, 'token'); });\n");
    try {
      const pr = await run({ STAGING_URL: url, STAGING_TEST_ADMIN_TOKEN: token, OTHER_PARENT_VAR: 'x' }, ['e2e/staging-e2e/zz-kit-env-probe.test.mjs']);
      assert.equal(pr.code, 0, pr.out.replace(token, '<令牌>'));
    } finally { rmSync(probe, { force: true }); }
    // 令牌错：第一个用例之后照样跑，但 401 → 失败（退出码不是 0），输出里也没有令牌
    const bad = await run({ STAGING_URL: url, STAGING_TEST_ADMIN_TOKEN: 'tta_wrong' }, ['e2e/staging-e2e/basics.test.mjs']);
    assert.notEqual(bad.code, 0);
    // 只认 e2e/staging-e2e/*.test.mjs
    const outside = await run({ STAGING_URL: url, STAGING_TEST_ADMIN_TOKEN: token }, ['test/test-admin.test.js']);
    assert.notEqual(outside.code, 0);
    assert.match(outside.out, /只能跑 e2e\/staging-e2e/);
  } finally {
    console.error = err;
    restoreNet();
    server.close();
    await (await web.app).close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test('健康检查不是测试环境（或测试管理员没开）：run.mjs 一个用例都不跑', { timeout: 60_000 }, async () => {
  for (const health of [{ env: 'production', ok: true }, { env: 'staging', test_admin: false }]) {
    const { server, url } = await serve(async () => Response.json(health));
    try {
      const r = await run({ STAGING_URL: url, STAGING_TEST_ADMIN_TOKEN: 'tta_x' });
      assert.notEqual(r.code, 0);
      assert.ok(!/# tests/.test(r.out), `没有跑用例：${r.out}`);
    } finally { server.close(); }
  }
  // 不是 https、也不是本机：拒绝
  const r = await run({ STAGING_URL: 'http://example.invalid', STAGING_TEST_ADMIN_TOKEN: 'tta_x' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /https/);
});

// 运行日志公开：assert.equal / deepEqual / strictEqual 失败时 node 的 spec 输出会把实际值（接口返回）打印出来；console.log、JSON.stringify
// 也会把接口返回带进日志。所以验收用例目录里的每个 .mjs 都只许用 assert.ok(条件, 说明) 和 lib.mjs 的 ok()、expectError()；
// lib.mjs（发请求要 JSON.stringify 请求体）、run.mjs（打印一行"连的是哪个提交"）两处是认可的例外，只豁免打印和序列化这一条
test('静态检查：e2e/staging-e2e/ 的 .mjs 里没有会把实际值打进日志的断言；用例文件里没有 console.*、JSON.stringify', () => {
  const dir = join(ROOT, 'e2e/staging-e2e');
  const BAD_ASSERT = /\b(equal|deepEqual|strictEqual|deepStrictEqual|notEqual|notDeepEqual|notStrictEqual|notDeepStrictEqual|partialDeepStrictEqual|match|doesNotMatch)\s*\(/;
  const BAD_PRINT = /\bconsole\s*\.\s*(log|info|warn|error|debug|dir|table|trace)\b|\bJSON\s*\.\s*stringify\b|process\s*\.\s*std(out|err)\s*\.\s*write/;
  const PRINT_OK = new Set(['lib.mjs', 'run.mjs']);
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs'));
  assert.ok(files.some((f) => f.endsWith('.test.mjs')));
  for (const f of files) {
    readFileSync(join(dir, f), 'utf8').split('\n').forEach((line, i) => {
      assert.ok(!BAD_ASSERT.test(line), `${f}:${i + 1} 用了会打印实际值的断言，改成 assert.ok(条件, 说明) 或 ok()、expectError()`);
      if (!PRINT_OK.has(f)) assert.ok(!BAD_PRINT.test(line), `${f}:${i + 1} 不要打印或序列化接口返回（console.*、JSON.stringify、process.stdout.write）`);
    });
  }
});
