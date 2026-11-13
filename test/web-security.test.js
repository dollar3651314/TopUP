// 测试经理补的用例（第 0 批复核）：web 进程现在直接上生产（原来生产走托管平台，本地服务器只在开发时用），
// 所以本地开发才有的入口和静态文件服务，要在生产配置下单独确认安全。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/config.js';
import { createWeb } from '../server/web.js';

const quietly = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

// 原 TC-K11 检查的是"清理接口要口令"；现在清理改由 worker 执行，本地用 /__fake/cleanup/ 代替。
// /__fake/ 下还有"立即扫链""执行任意 SQL"等入口，生产和测试环境必须不存在（即使误设了 FAKE_TRON、FAKE_SQL）。
test('web：生产和测试环境没有 /__fake/ 入口（即使设置了 FAKE_TRON=1、FAKE_SQL=1）', async () => {
  const keep = process.env.FAKE_SQL;
  process.env.FAKE_SQL = '1';
  try {
    await quietly(async () => {
      for (const appEnv of ['production', 'staging']) {
        const dir = mkdtempSync(join(tmpdir(), 'topup-qa-fake-'));
        try {
          writeFileSync(join(dir, '404.html'), 'Page not found');
          const web = createWeb(loadConfig({ APP_ENV: appEnv, FAKE_TRON: '1', FAKE_SQL: '1' }), { site: dir });
          for (const p of ['/__fake/cleanup/', '/__fake/tick/', '/__fake/daily/', '/__fake/sql/', '/__fake/tron/pay/', '/__fake/tron/account/', '/__fake/tron/confirm-all/', '/__fake/evm/pay/']) {
            for (const method of ['GET', 'POST']) {
              const body = method === 'POST' ? JSON.stringify({ sql: 'select 1 as x', to: 'T', amount: 1 }) : undefined;
              const r = await web.handle(new Request(`http://x.test${p}`, { method, body, headers: { 'content-type': 'application/json' } }));
              assert.equal(r.status, 404, `${appEnv} ${method} ${p}`);
              assert.doesNotMatch(await r.text(), /"ok"\s*:\s*true|"x"\s*:\s*1/, `${appEnv} ${method} ${p}`);
            }
          }
        } finally { rmSync(dir, { recursive: true, force: true }); }
      }
    });
  } finally { if (keep === undefined) delete process.env.FAKE_SQL; else process.env.FAKE_SQL = keep; }
});

// 生产由 web 进程直接提供页面文件（原来由托管平台提供），地址里编码过的 ../ 不能读到页面目录以外的文件。
test('web：页面文件不会跳出页面目录（编码的 ../、名字以页面目录开头的相邻目录）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'topup-qa-site-'));
  try {
    const site = join(root, 'dist');
    mkdirSync(site);
    writeFileSync(join(site, 'index.html'), 'home');
    writeFileSync(join(site, '404.html'), 'Page not found');
    writeFileSync(join(root, 'secret.txt'), 'TOP-SECRET-PARENT');
    // 和页面目录同一层、名字以 dist 开头的目录（例如 dist-old、dist.bak），里面的文件同样不能被读到
    mkdirSync(join(root, 'dist-old'));
    writeFileSync(join(root, 'dist-old', 'secret.txt'), 'TOP-SECRET-SIBLING');
    await quietly(async () => {
      const web = createWeb(loadConfig({ APP_ENV: 'production' }), { site });
      for (const p of ['/..%2fsecret.txt', '/%2e%2e%2fsecret.txt', '/..%2fdist-old%2fsecret.txt', '/%2e%2e/dist-old/secret.txt', '/..%5cdist-old%5csecret.txt']) {
        const r = await web.handle(new Request(`http://x.test${p}`));
        const text = await r.text();
        assert.notEqual(r.status, 200, `${p} → ${r.status}`);
        assert.doesNotMatch(text, /TOP-SECRET/, `${p} 读到了页面目录以外的文件`);
      }
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 原 TC-24 的后半句（"前端请求的接口地址不会触发跳转"）只在已淘汰的表单上测过；表单淘汰后，改为检查保留页面的全部前端脚本：
// 接口地址都以 / 结尾（不带 / 会 308 跳转，POST 跳转后有的浏览器会丢请求体）
test('页面脚本：请求的接口地址都带尾斜杠（/api/<名称>/）', () => {
  const dir = new URL('../site/src/scripts/', import.meta.url);
  const bad = [];
  let n = 0;
  for (const f of readdirSync(dir)) {
    if (!/\.(ts|js|mjs)$/.test(f)) continue;
    const src = readFileSync(new URL(f, dir), 'utf8');
    for (const m of src.matchAll(/['"`](\/api\/[A-Za-z0-9_\-/]*)/g)) {
      n++;
      const path = m[1];
      if (path === '/api/' || !/^\/api\/[a-z0-9-]+\//.test(path)) bad.push(`${f}: ${path}`);
    }
  }
  assert.ok(n >= 4, `只找到 ${n} 处接口地址，扫描规则可能失效`);
  assert.deepEqual(bad, []);
});
