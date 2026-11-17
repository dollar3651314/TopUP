// 测试先写（测试经理）：通用的冒烟检查脚本 e2e/smoke.sh。开发不要改这个文件，有异议找测试经理改。
// 这里定下的约定（接口）：
//   - 用法：bash e2e/smoke.sh <地址> <期望的提交前 7 位> <环境 production|staging>
//   - 每一项一行，"  ✅ 说明" 或 "  ❌ 说明"（和 e2e/smoke-staging.sh 一样）；有 ❌ 退出码不是 0
//   - 环境 = production 时：健康检查 env 要是 production、pay.tron 要是 mainnet；页面不能有测试环境标识（data-staging-banner）、
//     不能有原型标识（data-prototype-banner）；提交号对不上要报错
//   - 第三个参数只认 production、staging；健康检查的 env 和参数不一致要报错
//   - 等新版本上线的最长时间可以用 SMOKE_WAIT_S（秒）改短（测试用；默认值开发自定）
//   - 地址不出现在输出里（地址放在仓库密钥里）
// 做法：本机起一个"像生产"的假服务器（各接口按 e2e/smoke-staging.sh 检查的样子返回），先跑一遍记下 ❌ 的行；
// 再每次只改一处（测试环境标识、env、TRON 网络、提交号、原型标识），脚本必须多出至少一行 ❌、退出码不是 0。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SMOKE = join(ROOT, 'e2e/smoke.sh');
const COMMIT = 'abc1234';

function fakeProd(over = {}) {
  const o = { env: 'production', tron: 'mainnet', commit: COMMIT, banner: '', ...over };
  const page = (extra = '') => `<!doctype html><html><head><meta charset="utf-8"><title>TopUP</title></head><body ${o.banner}>${extra}<main>TopUP</main></body></html>`;
  const health = () => ({
    ok: true, env: o.env, commit: o.commit, storage: true, db: true, mail: true, mailMode: 'smtp', secret: true, blob: true,
    pay: { tron: o.tron, trongridKey: true }, worker: { age_s: 3, ok: true },
    wallet: { chains: ['eth', 'bsc', 'tron'].map((chain) => ({ chain, status: 'not_enabled', ok: true })), operator: false, operator_tron: false },
  });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname; const q = u.searchParams;
    const h = { 'content-security-policy': "default-src 'self'", 'strict-transport-security': 'max-age=31536000', 'x-content-type-options': 'nosniff' };
    const send = (code, body, type = 'text/html; charset=utf-8') => { res.writeHead(code, { ...h, 'content-type': type }); res.end(req.method === 'HEAD' ? undefined : body); };
    const json = (code, v) => send(code, JSON.stringify(v), 'application/json');
    if (p === '/api/health/') return json(200, health());
    if (p === '/api/kyb/') {
      if (req.method === 'POST' && req.headers.origin && !/^http:\/\/127\.0\.0\.1/.test(req.headers.origin)) return json(403, { error: 'forbidden' });
      if (q.get('g') === 'admin') return json(401, { error: 'unauthorized' });
      if (q.get('g') === 'onboarding') return json(404, { error: 'not_found' });
      return json(404, { error: 'not_found' });
    }
    if (p.startsWith('/api/v1/') || p === '/api/merchant/' || p === '/api/wallet/') return json(401, { error: 'unauthorized' });
    if (p === '/api/pay/') return json(404, { error: 'not_found' });
    if (p.startsWith('/api/')) return json(404, { error: 'not_found' });
    if (/^\/pay\/ORD-[0-9-]+\/$/.test(p)) return send(200, page());
    const pages = ['/', '/docs/', '/onboarding/', '/merchant/', '/admin/'];
    const bare = p.startsWith('/zh/') ? p.slice(3) : p;
    if (pages.includes(bare)) {
      const proto = bare === '/onboarding/' ? '<script type="application/json" data-config>{&quot;prototype&quot;:false}</script>' : '';
      return send(200, page(`${o.proto || ''}${proto}`));
    }
    return send(404, page());
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

function smoke(args, env = {}) {
  return new Promise((ok) => {
    const p = spawn('bash', [SMOKE, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp', NO_PROXY: '*', no_proxy: '*', SMOKE_WAIT_S: '2', ...env } });
    let out = '';
    const t = setTimeout(() => p.kill('SIGKILL'), 150_000);
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => { clearTimeout(t); ok({ code, out }); });
  });
}
const bad = (out) => new Set(out.split('\n').filter((l) => /❌/.test(l)).map((l) => l.replace(/（当前：[^）]*）/g, '').trim()));
const newFails = (good, r) => [...bad(r.out)].filter((l) => !good.has(l));

let goodFails = null;
async function goodRun() {
  if (goodFails) return goodFails;
  const { server, url } = await fakeProd();
  try {
    const r = await smoke([url, COMMIT, 'production']);
    assert.ok(/✅/.test(r.out), `e2e/smoke.sh 能跑、有 ✅ 的行：${r.out.slice(0, 2000)}`);
    assert.ok(!r.out.includes(url) && !r.out.includes(url.replace('http://', '')), '输出里没有地址');
    goodFails = bad(r.out);
    return goodFails;
  } finally { server.close(); }
}

test('对照：像生产的服务器 → 脚本能跑（有 ✅ 行），输出里没有地址', { timeout: 180_000 }, async () => {
  await goodRun();
});

for (const [name, over] of [
  ['页面有测试环境标识（data-staging-banner）', { banner: 'data-staging-banner' }],
  ['页面有原型标识（data-prototype-banner）', { banner: 'data-prototype-banner' }],
  ['健康检查 env 是 staging', { env: 'staging' }],
  ['健康检查 TRON 是 nile（不是主网）', { tron: 'nile' }],
  ['提交号对不上（服务器还是旧版本）', { commit: 'def5678' }],
]) {
  test(`生产：${name} → 多出 ❌、退出码不是 0、输出里没有地址`, { timeout: 180_000 }, async () => {
    const good = await goodRun();
    const { server, url } = await fakeProd(over);
    try {
      const t0 = Date.now();
      const r = await smoke([url, COMMIT, 'production']);
      assert.notEqual(r.code, 0, r.out);
      assert.ok(newFails(good, r).length > 0, `和对照相比要多出 ❌ 的行：\n${r.out}`);
      assert.ok(!r.out.includes(url.replace('http://', '')), '输出里没有地址');
      assert.ok(Date.now() - t0 < 120_000, 'SMOKE_WAIT_S=2 时不会等很久');
    } finally { server.close(); }
  });
}

test('环境参数：生产的服务器按 staging 检查 → 报错；不认识的环境名 → 退出码不是 0', { timeout: 180_000 }, async () => {
  const good = await goodRun();
  const { server, url } = await fakeProd();
  try {
    const r = await smoke([url, COMMIT, 'staging']);
    assert.notEqual(r.code, 0, r.out);
    assert.ok(newFails(good, r).length > 0, `env 不一致要报 ❌：\n${r.out}`);
    const r2 = await smoke([url, COMMIT, 'prod']);
    assert.notEqual(r2.code, 0, r2.out);
    const r3 = await smoke([url, COMMIT]);
    assert.notEqual(r3.code, 0, '缺环境参数');
  } finally { server.close(); }
});
