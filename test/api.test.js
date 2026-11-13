import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/config.js';
import { createWeb } from '../server/web.js';

const quietly = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
const get = (web, path) => web.handle(new Request(`http://x.test${path}`));

// web 入口：生产环境没有配置存储时，接口返回 503、健康检查返回 503，并且不会泄露配置值
test('web：没有配置存储时安全失败（接口 503、健康检查 503，不泄露配置值）', async () => {
  await quietly(async () => {
    const web = createWeb(loadConfig({ APP_ENV: 'production' }));
    const h = await get(web, '/api/health/');
    assert.equal(h.status, 503);
    assert.deepEqual(await h.json(), { ok: false, env: 'production', commit: '', storage: false, db: false, mail: false, mailMode: 'none', secret: false, blob: false, pay: { tron: 'mainnet', trongridKey: false }, worker: { age_s: null, ok: false } });
    // 收付款接口在没有配置数据库时返回 503，不泄露任何信息
    for (const f of ['v1/balance', 'merchant', 'pay', 'wallet']) {
      const r = await get(web, `/api/${f}/?a=me`);
      assert.equal(r.status, 503, f);
      assert.deepEqual(await r.json(), { error: { code: 'not_configured' } });
    }
    // 定时任务不再有对外的接口（由 worker 进程执行）；旧的表单接口不存在
    for (const p of ['/api/tick/', '/api/cron/cleanup/', '/api/leads/']) assert.equal((await get(web, p)).status, 404, p);
    // 开户接口在没有配置时返回 503，不泄露任何信息
    const r2 = await get(web, '/api/kyb/?g=onboarding&a=state');
    assert.equal(r2.status, 503);
    assert.deepEqual(await r2.json(), { ok: false, error: 'not_configured' });
  });
});

test('配置：环境变量的首尾空白和换行会被去掉', async () => {
  const c = loadConfig({ APP_SECRET: '  abc\n', ADMIN_SETUP_TOKEN: 'x\r\n', SMTP_HOST: ' smtp.example.test ' });
  assert.equal(c.appSecret, 'abc'); assert.equal(c.adminSetupToken, 'x'); assert.equal(c.smtp.host, 'smtp.example.test');
});

test('接口入口：固定的路由表；开户接口按 g 参数分发，g 不对时返回 404；没有配置时安全返回 503；不带尾斜杠的地址 308 跳转', async () => {
  await quietly(async () => {
    assert.equal((await get(createWeb(loadConfig({ APP_ENV: 'production' })), '/api/kyb/?g=admin&a=me')).status, 503);
    const dir = mkdtempSync(join(tmpdir(), 'topup-web-'));
    try {
      const web = createWeb(loadConfig({ APP_ENV: 'local', DATA_DIR: dir }), { site: dir });
      assert.equal((await get(web, '/api/kyb/?g=nope&a=me')).status, 404);
      assert.equal((await get(web, '/api/kyb/?g=admin&a=me')).status, 200);
      assert.equal((await get(web, '/api/nope/')).status, 404);
      const r = await web.handle(new Request('http://x.test/api/kyb?g=admin', { method: 'POST' }));
      assert.equal(r.status, 308); assert.equal(r.headers.get('location'), '/api/kyb/?g=admin');
      // 每个响应都带上安全响应头（server/http-rules.json）
      assert.equal(r.headers.get('x-frame-options'), 'DENY');
      assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
      await (await web.app).close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

test('配置检查：生产和测试环境缺少的变量逐个列出（只列变量名），本地不要求', async () => {
  const { missingConfig } = await import('../server/app.js');
  assert.deepEqual(missingConfig(loadConfig({ APP_ENV: 'local' })), []);
  assert.deepEqual(missingConfig(loadConfig({ APP_ENV: 'production', APP_SECRET: 'short' })), ['REDIS_URL', 'DATABASE_URL', 'APP_SECRET', 'BLOB_DIR', 'PUBLIC_URL']);
  assert.deepEqual(missingConfig(loadConfig({ APP_ENV: 'staging', REDIS_URL: 'redis://r', DATABASE_URL: 'postgres://d', APP_SECRET: 'x'.repeat(32), BLOB_DIR: '/b', PUBLIC_URL: 'https://p' })), []);
  // TronGrid 替身只在本地生效，生产和测试环境设了 FAKE_TRON 也不用替身
  assert.equal(loadConfig({ APP_ENV: 'local' }).fakeTron, true);
  assert.equal(loadConfig({ APP_ENV: 'local', FAKE_TRON: '0' }).fakeTron, false);
  assert.equal(loadConfig({ APP_ENV: 'production', FAKE_TRON: '1' }).fakeTron, false);
  // 镜像里（NODE_ENV=production）不能以本地模式运行
  const { refuseLocal } = await import('../server/app.js');
  assert.match(refuseLocal(loadConfig({ NODE_ENV: 'production' })), /APP_ENV=local/);
  assert.equal(refuseLocal(loadConfig({ NODE_ENV: 'production', APP_ENV: 'staging' })), null);
  assert.equal(refuseLocal(loadConfig({})), null);
});

test('测试环境：邮件标题带"[测试环境]"；健康检查返回 env，且不要求定时任务口令', async () => {
  const { envSubject } = await import('../server/mailer.js');
  assert.equal(envSubject(loadConfig({ APP_ENV: 'staging' }), 'Hi'), '[测试环境] Hi');
  assert.equal(envSubject(loadConfig({ APP_ENV: 'production' }), 'Hi'), 'Hi');
  await quietly(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'topup-web-'));
    try {
      const web = createWeb(loadConfig({ APP_ENV: 'staging', REDIS_URL: 'redis://127.0.0.1:1', DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db', MAIL_FROM: 'a@x', MAIL_TO: 'b@x', SMTP_HOST: 'smtp.x', APP_SECRET: 'x'.repeat(40), BLOB_DIR: dir, PUBLIC_URL: 'https://x.test', TRONGRID_API_KEY: 'k' }), { site: dir });
      const b = await (await get(web, '/api/health/')).json();
      assert.equal(b.env, 'staging'); assert.equal('cron' in b, false);
      assert.deepEqual([b.storage, b.db, b.mail, b.secret, b.blob, b.pay.trongridKey], [true, true, true, true, true, true]);
      // 数据库连不上：ok 为 false，测试环境多返回一个原因类别（不含配置值）
      assert.equal(b.ok, false); assert.equal(b.pay.reason, 'db_unreachable');
      await (await web.app).close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
