// 测试先写（测试经理）：上线前清理 P1——管理员重置后旧会话"复活"。开发不要改这个文件，有异议找测试经理改测试。
// 问题：后台会话 Cookie 只按 admin.version 校验（server/kyb/auth.js、server/kyb/admin.js、server/pay/admin-gate.js）。
// sudo topup admin-reset 删掉 Redis 里的 topup:admin 以后重新初始化，新管理员又从 version = 1 开始——
// 重置之前签发的 Cookie（8 小时有效期内）重新变得有效：丢了 / 被偷的旧 Cookie 在重置后照样能进后台。
//
// 这里定下的约定（接口；开发按这个做）：
//   - 每次（重新）初始化管理员（setup-confirm 成功）都生成一个新的随机标识（例如 topup:admin 里的 id / epoch，至少 128 位随机），
//     会话 Cookie 绑定这个标识（以及原来的 version）；校验时标识对不上 → 无效。
//     （也可以用"永不重复的递增版本号"，但这个计数不能放在 admin-reset 会删的那几个键里，见下）
//   - admin-reset 删的键不变：topup:admin、topup:admin:pending、topup:admin:lock、topup:admin:fails、topup:admin:totp-last
//     （test/qa-p1-deploy.test.js 定的；这里按这五个键模拟重置）
//   - 重置前签发的 Cookie：开户后台（/api/kyb/?g=admin）secured 动作 401、me 返回 authed = false；
//     运营后台（server/pay/admin-gate.js 的 requireAdmin）401。新管理员登录后的 Cookie 照常可用；退出登录照旧让 Cookie 失效
//   - 不管新管理员之后退出登录几次（version 涨到和旧 Cookie 一样），旧 Cookie 也不能复活
//   - Redis 里已有的、没有标识的旧管理员记录（升级前初始化的）：开发自定（例如第一次读到时补一个标识，旧 Cookie 要重新登录），
//     这里不测
// 做法：和 test/kyb-flow.test.js 一样用内存 Redis（server/kyb/memredis.js）+ 假时钟，直接调用处理函数。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemRedis } from '../server/kyb/memredis.js';
import { deriveKeys } from '../server/kyb/crypto.js';
import { createRepo } from '../server/kyb/repo.js';
import { createLocalBlobs } from '../server/kyb/blobs.js';
import { createAdminHandler } from '../server/kyb/admin.js';
import { createAdminGate } from '../server/pay/admin-gate.js';
import { totpCode } from '../server/kyb/totp.js';

const quiet = { error() {}, warn() {} };
const B = 'http://kyb.test';
const PW = 'a-long-password-123';
const RESET_KEYS = ['topup:admin', 'topup:admin:pending', 'topup:admin:lock', 'topup:admin:fails', 'topup:admin:totp-last'];

function setup() {
  let t = Date.parse('2026-11-17T02:00:00Z');
  const now = () => t;
  const dir = mkdtempSync(join(tmpdir(), 'qa-admin-sess-'));
  const redis = createMemRedis({ now });
  const keys = deriveKeys('qa-admin-session-secret-0123456789abcdef');
  const repo = createRepo({ redis, keys, now });
  const blobs = createLocalBlobs(join(dir, 'blobs'));
  const config = { mailTo: 'admin@example.test', adminSetupToken: 'setup-token-one' };
  const ad = createAdminHandler({ repo, blobs, send: async () => {}, redis, keys, config, now, log: quiet });
  const gate = createAdminGate({ redis, kybKeys: keys, now });
  /** 调一次开户后台的接口；返回 [状态码, JSON, 新 Cookie（有 set-cookie 时）] */
  const call = async (action, { cookie = '', body } = {}) => {
    const r = await ad(new Request(`${B}/api/admin/${action}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }));
    const sc = r.headers.get('set-cookie');
    return [r.status, await r.json(), sc ? sc.split(';')[0] : null];
  };
  /** 初始化（口令 = 当前 config.adminSetupToken）+ 登录，返回 { cookie, secret } */
  const initAndLogin = async () => {
    const [s1, b1] = await call('setup-begin/', { body: { setupToken: config.adminSetupToken, password: PW } });
    assert.equal(s1, 200, `初始化第 1 步：${JSON.stringify(b1)}`);
    const [s2, b2] = await call('setup-confirm/', { body: { setupToken: config.adminSetupToken, code: totpCode(b1.secret, t) } });
    assert.equal(s2, 200, `初始化第 2 步：${JSON.stringify(b2)}`);
    t += 60_000; // 换一个时间步再登录（同一个动态码不能用两次）
    const cookie = await login(b1.secret);
    return { cookie, secret: b1.secret };
  };
  const login = async (secret) => {
    const [s, b, c] = await call('login/', { body: { password: PW, code: totpCode(secret, t) } });
    assert.equal(s, 200, `登录：${JSON.stringify(b)}`);
    assert.ok(c && /^topup_admin=.+/.test(c), '登录返回会话 Cookie');
    return c;
  };
  /** 和 sudo topup admin-reset --confirm 一样：删掉这五个键，换一个初始化口令 */
  const adminReset = async () => {
    for (const k of RESET_KEYS) await redis.del(k);
    config.adminSetupToken = 'setup-token-two';
  };
  /** 这个 Cookie 现在能不能用：开户后台 apps、me，运营后台 requireAdmin */
  const probe = async (cookie) => {
    const [apps] = await call('apps/', { cookie });
    const [, me] = await call('me/', { cookie });
    let gateStatus = 200;
    try { await gate.requireAdmin(new Request('https://x/api/wallet/?a=payout-limits', { headers: { cookie } })); } catch (e) { gateStatus = e.status || 500; }
    return { apps, authed: me.authed, gate: gateStatus };
  };
  return { call, initAndLogin, login, adminReset, probe, redis, advance: (ms) => (t += ms), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('前提：重置前签发的 Cookie 在重置前可用（开户后台、运营后台都认）', async () => {
  const s = setup();
  try {
    const { cookie } = await s.initAndLogin();
    assert.deepEqual(await s.probe(cookie), { apps: 200, authed: true, gate: 200 });
  } finally { s.done(); }
});

test('admin-reset 后重新初始化：重置前的 Cookie（还在 8 小时内）→ 开户后台 401、me 未登录、运营后台 401；新管理员的 Cookie 可用', async () => {
  const s = setup();
  try {
    const { cookie: old } = await s.initAndLogin();
    s.advance(10 * 60_000);
    await s.adminReset();
    assert.equal((await s.probe(old)).apps, 401, '重置后、重新初始化前：旧 Cookie 401（没有管理员）');
    s.advance(10 * 60_000);
    const { cookie: fresh } = await s.initAndLogin();
    s.advance(60_000); // 合计约 21 分钟，远在 8 小时有效期内
    assert.deepEqual(await s.probe(old), { apps: 401, authed: false, gate: 401 }, '重置前签发的 Cookie 不能在重新初始化后复活');
    assert.deepEqual(await s.probe(fresh), { apps: 200, authed: true, gate: 200 }, '新管理员的 Cookie 照常可用');
  } finally { s.done(); }
});

test('旧管理员退出过一次（旧 Cookie 的版本号是 2）；重置后新管理员也退出一次（版本号又到 2）→ 旧 Cookie 仍然 401', async () => {
  const s = setup();
  try {
    const { cookie: first, secret } = await s.initAndLogin();
    const [lo] = await s.call('logout/', { cookie: first, body: {} });
    assert.equal(lo, 200, '前提：退出登录');
    assert.equal((await s.probe(first)).apps, 401, '前提：退出后旧 Cookie 失效');
    s.advance(60_000);
    const old = await s.login(secret); // 旧管理员第二个会话
    assert.equal((await s.probe(old)).apps, 200, '前提：再次登录可用');
    s.advance(10 * 60_000);
    await s.adminReset();
    s.advance(10 * 60_000);
    const { cookie: n1, secret: ns } = await s.initAndLogin();
    assert.equal((await s.probe(old)).apps, 401, '重新初始化后旧 Cookie 401');
    const [lo2] = await s.call('logout/', { cookie: n1, body: {} });
    assert.equal(lo2, 200, '新管理员退出一次');
    s.advance(60_000);
    const n2 = await s.login(ns);
    assert.deepEqual(await s.probe(old), { apps: 401, authed: false, gate: 401 }, '新管理员的版本号涨到和旧 Cookie 一样，旧 Cookie 也不能复活');
    assert.deepEqual(await s.probe(n1), { apps: 401, authed: false, gate: 401 }, '对照：新管理员退出前的 Cookie 照旧失效');
    assert.deepEqual(await s.probe(n2), { apps: 200, authed: true, gate: 200 }, '对照：新管理员当前的 Cookie 可用');
  } finally { s.done(); }
});

test('每次初始化的标识都不同：重置两次，三次初始化的管理员记录（去掉密码、验证器、创建时间）互不相同（不能每次都从 version = 1 重来）', async () => {
  const s = setup();
  try {
    const ids = [];
    const snap = async () => {
      const raw = await s.redis.get('topup:admin');
      const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const { pw, totp, createdAt, ...rest } = a; // 剩下 version 和新加的标识（随机 id / epoch，或永不重复的版本号）
      ids.push(JSON.stringify(rest));
    };
    await s.initAndLogin(); await snap();
    for (let i = 0; i < 2; i++) { await s.adminReset(); s.advance(60_000); await s.initAndLogin(); await snap(); }
    assert.equal(new Set(ids).size, 3, `三次初始化的会话标识互不相同：${ids.join(' | ')}`);
  } finally { s.done(); }
});
