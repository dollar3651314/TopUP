// 研发补测（上线前清理 P1-b，独立审查的三处）：
//   1. 只有能证明来自节点客户端的错才换成 node_busy / rpc_unreachable / node_error；发邮件失败、数据坏了等照旧 500（否则页面说"节点连不上、钱没动、请重试"，重试会重复开通商户）
//   2. 换成错误码时原始错误信息写进服务器日志（返回里不带）
//   3. 页面过期按服务器自己提供的 admin 页的 data-build 判断（镜像只改 ENV 里的提交号重打时不会每个请求都 409），读不到才用 GIT_COMMIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '../server/pay/db.js';
import { migrate } from '../server/pay/schema.js';
import { PayError } from '../server/pay/core.js';
import { createWalletApi, nodeClient } from '../server/pay/wallet-api.js';
import { derivePayKeys } from '../server/pay/common.js';
import { createTronGrid } from '../server/pay/trongrid.js';
import { nodeFailure } from '../server/wallet/admin-actions.js';
import { TronNodeError } from '../server/wallet/adapters/tron.js';
import { loadConfig } from '../server/config.js';

const SECRET = 'test-app-secret-test-app-secret-0123456789';
const capture = async (fn) => {
  const lines = []; const s = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => lines.push(a.join(' '));
  try { return { r: await fn(), lines }; } finally { Object.assign(console, s); }
};

test('nodeFailure：没有节点标记的 TypeError、SyntaxError、超时原样返回（照旧 500）；带标记的、rpc_* code、TronNodeError 才换', async () => {
  const fetchErr = new TypeError('fetch failed');
  const jsonErr = new SyntaxError('Unexpected token < in JSON at position 0');
  const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  for (const e of [fetchErr, jsonErr, timeout, new Error('build_failed')]) assert.equal(nodeFailure(e), e, `${e.name} ${e.message}：不是节点的错，不换`);
  const { r, lines } = await capture(() => [
    nodeFailure(Object.assign(new TypeError('fetch failed'), { node: true })),
    nodeFailure(Object.assign(new Error('trongrid 429 /v1/accounts/T1'), { status: 429, node: true })),
    nodeFailure(new TronNodeError('tron: /wallet/triggersmartcontract: txID does not match raw_data_hex')),
  ]);
  assert.deepEqual(r.map((x) => [x instanceof PayError, x.code, x.status]), [[true, 'rpc_unreachable', 503], [true, 'node_busy', 503], [true, 'node_error', 502]]);
  assert.ok(lines.some((l) => l.includes('txID does not match raw_data_hex') && l.includes('node_error')), `原始信息写进日志：${lines.join(' | ')}`);
  assert.ok(lines.some((l) => l.includes('/v1/accounts/')), '接口路径只在日志里');
});

test('nodeClient：老 TronGrid 客户端抛的错打上 node 标记；同步方法照旧同步返回；不是函数的属性原样', async () => {
  const c = nodeClient({ network: 'nile', a: async () => { throw new TypeError('fetch failed'); }, b: () => 7, s: () => { throw new SyntaxError('JSON'); } });
  assert.equal(c.network, 'nile');
  assert.equal(c.b(), 7);
  await assert.rejects(c.a(), (e) => e.node === true);
  assert.throws(() => c.s(), (e) => e.node === true);
});

test('开通商户时发邮件失败（TypeError fetch failed）→ 照旧 500 internal_error，不说成节点连不上', async () => {
  const db = await createTestDb(); await migrate(db);
  const api = createWalletApi({ db, tron: createTronGrid({ network: 'nile', fetchImpl: async () => Response.json({}) }), keys: derivePayKeys(SECRET), wallets: { hot: '', cold: '' },
    requireAdmin: async () => ({ testAdmin: false }), verifyAdminCode: async () => true, send: async () => { throw new TypeError('fetch failed'); }, origin: 'https://admin.example' });
  const { r } = await capture(async () => {
    const res = await api(new Request('https://x/api/wallet/?a=merchant-open', { method: 'POST', headers: { 'content-type': 'application/json', 'x-topup-csrf': '1' }, body: JSON.stringify({ name: 'Acme', email: 'a@example.test', fee_in: { ppm: 10000, fixed: 0, min: 0 }, fee_out: { ppm: 0, fixed: 2000000, min: 0 }, order_mode: { enabled: true, low: 900000, high: 1100000, ttlMin: 30, lookbackH: 24 } }) }));
    return { status: res.status, body: await res.json() };
  });
  assert.equal(r.status, 500, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'internal_error');
  await db.end?.();
});

test('页面过期：按服务器自己提供的 admin 页 data-build 判断；GIT_COMMIT 和页面不同（只改 ENV 重打的镜像）时，带页面构建号的请求不 409', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p1-stale-'));
  const P = 'c'.repeat(40), G = 'd'.repeat(40), OLD = 'e'.repeat(40);
  mkdirSync(join(dir, 'admin'), { recursive: true });
  writeFileSync(join(dir, 'admin', 'index.html'), `<div id="admin-root" data-build="${P}" data-wallet-env="local"></div>`);
  const saved = process.env.GIT_COMMIT; process.env.GIT_COMMIT = G;
  const { createWeb } = await import('../server/web.js');
  const { r: web } = await capture(async () => { const w = createWeb(loadConfig({ APP_ENV: 'local', DATA_DIR: dir, APP_SECRET: SECRET }), { site: dir }); await (await w.app).pay; return w; });
  const req = async (build) => (await capture(() => web.handle(new Request('http://127.0.0.1/api/wallet/?a=payout-limits', { headers: { 'x-topup-build': build } })))).r.status;
  try {
    assert.equal(await req(P), 401, '页面和服务器提供的页面一致：照旧要登录');
    assert.equal(await req(OLD), 409, '旧页面：409 stale_page');
  } finally {
    if (saved === undefined) delete process.env.GIT_COMMIT; else process.env.GIT_COMMIT = saved;
    try { await (await (await web.app).pay).db.end?.(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
