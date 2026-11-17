// 测试先写（测试经理）：生产环境"先搭起来，不算上线"——应用这一层。开发不要改这个文件，有异议找测试经理改。
// 用 config/wallets.json 的 production 一节 + 真实 Postgres、Redis（独立 schema），按服务器上的方式配置 APP_ENV=production：
//   - createApp 成功、收付款初始化成功（refuseConfig 返回 null）
//   - worker 跑一轮之后，健康检查 env = production、pay.tron = mainnet、worker.ok = true、commit 有值
//   - ETH、BSC、TRON 三条链都是 not_enabled（production 一节的合约地址全空 = 有意没开通），ok = true，不返回任何地址
//   - 健康检查里没有测试环境才有的 test_admin、test_merchant_ip_bypass 两项
// 生产拒绝 TEST_ADMIN_TOKEN_SHA256、TEST_MERCHANT_IP_BYPASS 已有测试，这里不重复：
//   test/test-admin.test.js（"生产配了测试管理员"一段：refuseConfig、createApp 拒绝、说明里没有值）
//   test/qa-merchant-ip-bypass.test.js（"生产配了这个变量：拒绝启动"一段）
// 需要 TEST_DATABASE_URL、TEST_REDIS_URL（CI 第二轮单元测试有）；没有时跳过。不连外部服务：TRON 节点指向本机关着的端口，数据库是空的不扫链。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.js';
import { refuseConfig } from '../server/app.js';
import { createPgDb } from '../server/pay/db.js';

const PG = process.env.TEST_DATABASE_URL || '';
const RD = process.env.TEST_REDIS_URL || '';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skip = PG && RD ? false : '没有设置 TEST_DATABASE_URL、TEST_REDIS_URL';

test('前提：config/wallets.json 的 production 一节存在，ETH、BSC、TRON 的合约地址全空（三条链都没开通）', () => {
  const w = JSON.parse(readFileSync(join(ROOT, 'config/wallets.json'), 'utf8')).production;
  assert.ok(w && typeof w === 'object', '有 production 一节');
  for (const chain of ['eth', 'bsc']) {
    const c = w.evm?.[chain];
    assert.ok(c, `production.evm.${chain} 存在`);
    for (const k of ['usdt', 'factory', 'implementation', 'parent', 'batcher', 'hot', 'payout']) assert.equal(c[k], '', `production.evm.${chain}.${k} 空着`);
  }
  assert.ok(w.tron, 'production.tron 存在');
  for (const k of ['usdt', 'factory', 'implementation', 'parent', 'batcher']) assert.equal(w.tron[k], '', `production.tron.${k} 空着`);
});

test('APP_ENV=production（production 一节、真实 Postgres + Redis）：初始化成功，健康检查 env = production、TRON 主网、worker 正常、三条链都 not_enabled', { skip, timeout: 120_000 }, async () => {
  const schema = `t_qaprod_${Date.now().toString(36)}`;
  const admin = await createPgDb(PG); await admin.query(`create schema ${schema}`); await admin.end();
  const u = new URL(PG); u.searchParams.set('options', `-c search_path=${schema}`);
  const dir = mkdtempSync(join(tmpdir(), 'topup-qaprod-'));
  const env = {
    APP_ENV: 'production', NODE_ENV: 'production', DATABASE_URL: u.toString(), REDIS_URL: RD, APP_SECRET: 'p'.repeat(48), BLOB_DIR: dir,
    PUBLIC_URL: 'https://topup.example.com', TRON_NETWORK: 'mainnet', TRON_NODE_URL: 'http://127.0.0.1:9', TRONGRID_API_KEY: 'k',
    MAIL_FROM: 'a@example.com', MAIL_TO: 'b@example.com', SMTP_HOST: 'smtp.example.com',
  };
  const config = loadConfig(env);
  assert.equal(refuseConfig(config), null, '生产、没有测试变量：不拒绝启动');
  const commit = process.env.GIT_COMMIT;
  process.env.GIT_COMMIT = 'abcdef0123456789abcdef0123456789abcdef01';
  const { createWeb } = await import('../server/web.js');
  const { runOnce } = await import('../server/worker.js');
  const err = console.error; console.error = () => {};
  let web;
  try {
    web = createWeb(config, { site: dir });
    const app = await web.app;
    const pay = await app.pay; // 收付款初始化成功（失败会在这里抛出）
    assert.equal(app.config.appEnv, 'production');
    // 跑一轮 worker（和 server/worker.js 的循环同一个函数），健康检查才会有 worker.ok
    const r = await runOnce({ db: pay.db, tick: pay.tick, daily: async () => ({}), owner: 'qa-prod', atUtc: '23:59', now: Date.now() });
    assert.ok(!r.skipped, 'worker 抢到租约并跑了一轮');
    const res = await web.handle(new Request('https://topup.example.com/api/health/'));
    const b = await res.json();
    const shown = JSON.stringify(b);
    assert.equal(b.env, 'production', shown);
    assert.equal(b.commit, 'abcdef0');
    assert.equal(b.pay?.tron, 'mainnet', `TRON 是主网：${shown}`);
    assert.equal(b.db, true); assert.equal(b.storage, true); assert.equal(b.secret, true);
    assert.equal(b.worker?.ok, true, `worker 正常：${JSON.stringify(b.worker)}`);
    assert.equal(b.pay?.reason, undefined, '收付款初始化没有失败原因');
    assert.ok(b.wallet && Array.isArray(b.wallet.chains), `有 wallet 项：${JSON.stringify(b.wallet)}`);
    assert.equal(b.wallet.error, undefined);
    const by = Object.fromEntries(b.wallet.chains.map((c) => [c.chain, c]));
    for (const chain of ['eth', 'bsc', 'tron']) {
      assert.ok(by[chain], `有 ${chain} 一项`);
      assert.equal(by[chain].status, 'not_enabled', `${chain}：production 一节合约地址全空 → not_enabled（实际 ${by[chain].status}）`);
      assert.equal(by[chain].ok, true, `${chain} 没开通不算问题`);
    }
    assert.doesNotMatch(shown, /0x[0-9a-fA-F]{40}|\bT[1-9A-HJ-NP-Za-km-z]{33}\b/, '健康检查不返回地址的值');
    assert.ok(!('test_admin' in b) && !('test_merchant_ip_bypass' in b), '生产的健康检查没有测试环境的两项');
    // 整体 ok：库、Redis、主密钥、邮件、TronGrid Key 都配了 → 200
    assert.equal(res.status, 200, shown);
    assert.equal(b.ok, true, shown);
  } finally {
    console.error = err;
    if (commit === undefined) delete process.env.GIT_COMMIT; else process.env.GIT_COMMIT = commit;
    if (web) await (await web.app).close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    const a = await createPgDb(PG); await a.query(`drop schema ${schema} cascade`).catch(() => {}); await a.end();
  }
});
