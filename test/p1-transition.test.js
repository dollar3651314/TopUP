// 开发补测（上线前清理 P1）：两处过渡规则。
// 一、deploy/kit/topup.sh 的 app_alive：目标版本的健康检查 worker 一项有 commit 字段 → 要等于目标版本；
//     没有这个字段（"心跳带提交号"之前的老版本 web）→ 退回旧规则（只看扫链时间），换回老版本不会永远判失败。
// 二、升级前初始化的管理员记录（topup:admin 里没有 sid）：只认同样没有标识的 Cookie；退出登录时补上标识。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeSession, readSession, newAdminSid } from '../server/kyb/auth.js';

const KIT = fileURLToPath(new URL('../deploy/kit/topup.sh', import.meta.url));
const src = readFileSync(KIT, 'utf8');
const fn = src.slice(src.indexOf('app_alive() {'), src.indexOf('\n}\n', src.indexOf('app_alive() {')) + 3);
const T = 'abcdef0123456789abcdef0123456789abcdef01';
const OLDV = '1234567000000000000000000000000000000000';
const body = (worker, commit = T.slice(0, 7)) => JSON.stringify({ ok: true, commit, db: true, storage: true, secret: true, worker, wallet: { chains: [] } });
const alive = (b, want = T, within = '10') => spawnSync('bash', ['-c', `${fn}\napp_alive "$1" "$2" "$3"`, 'x', b, want, within], { encoding: 'utf8' }).status === 0;

test('app_alive：新版本 web（worker 有 commit 字段）要求 worker.commit = 目标版本', () => {
  assert.ok(fn.startsWith('app_alive() {') && fn.endsWith('}\n'), '取到了 app_alive');
  assert.equal(alive(body({ age_s: 0, ok: true, commit: T.slice(0, 7) })), true, '新 worker 报到');
  assert.equal(alive(body({ age_s: 0, ok: true, commit: OLDV.slice(0, 7) })), false, '旧 worker 的心跳再新鲜也不算');
  assert.equal(alive(body({ age_s: 0, ok: true, commit: null })), false, '心跳里没有提交号（旧 worker 写的）也不算');
  assert.equal(alive(body({ age_s: 30, ok: true, commit: T.slice(0, 7) })), false, '提交号对，但心跳早于开始等');
  assert.equal(alive(body({ age_s: 0, ok: true, commit: T.slice(0, 7) }, OLDV.slice(0, 7))), false, 'web 的提交号不对');
});

test('app_alive 过渡：老版本 web（worker 一项没有 commit 字段）退回旧规则——只看扫链时间', () => {
  assert.equal(alive(body({ age_s: 0, ok: true })), true, '换回老版本：老 worker 跑过一轮就算活着');
  assert.equal(alive(body({ age_s: 30, ok: true })), false, '旧规则照旧：扫链时间早于开始等不算');
  assert.equal(alive(body({ age_s: 0, ok: true }, OLDV.slice(0, 7))), false, 'web 的提交号仍然要对得上');
});

test('升级前的管理员记录（没有 sid）：没有标识的 Cookie 照旧可用；有了 sid 以后旧 Cookie 失效；带别的 sid 的 Cookie 不认', () => {
  const key = Buffer.alloc(32, 7); const now = Date.parse('2026-11-17T00:00:00Z');
  const legacy = makeSession(key, 1, now);
  assert.ok(readSession(key, `topup_admin=${legacy}`, { version: 1 }, now + 1000), '升级前的记录 + 升级前的 Cookie');
  assert.ok(readSession(key, `topup_admin=${legacy}`, 1, now + 1000), '只传版本号的写法不变');
  const sid = newAdminSid();
  assert.ok(Buffer.from(sid, 'base64url').length >= 16, '标识至少 128 位');
  assert.equal(readSession(key, `topup_admin=${legacy}`, { version: 1, sid }, now + 1000), null, '记录有了标识：没有标识的旧 Cookie 失效');
  const fresh = makeSession(key, 1, now, sid);
  assert.ok(readSession(key, `topup_admin=${fresh}`, { version: 1, sid }, now + 1000));
  assert.equal(readSession(key, `topup_admin=${fresh}`, { version: 1, sid: newAdminSid() }, now + 1000), null, '别的标识');
  assert.equal(readSession(key, `topup_admin=${fresh}`, { version: 1 }, now + 1000), null, '记录没有标识时不认带标识的 Cookie');
});

// 三、worker 暂停时（state/worker-hold）只查一次的"活着"（真实 IP 的 set 之后经 Nginx 的核对）只看 web，和 wait_alive 一样
const fnOf = (name) => {
  const i = src.indexOf(`${name}() {`); assert.ok(i >= 0, `topup.sh 里有 ${name}`);
  const eol = src.indexOf('\n', i);
  return src.slice(i, eol).trimEnd().endsWith('}') ? src.slice(i, eol + 1) : src.slice(i, src.indexOf('\n}\n', i) + 3); // 一行的函数 / 多行的函数
};
test('alive_now：worker 暂停时只看 web（worker 心跳旧、没有 commit 也算活着）；没暂停时和 app_alive 一样；真实 IP 的核对用它', () => {
  const lib = ['app_alive', 'worker_held', 'web_alive', 'alive_now'].map(fnOf).join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'p1-hold-'));
  try {
    mkdirSync(join(dir, 'state'));
    const run = (b) => spawnSync('bash', ['-c', `HOLD_REL=state/worker-hold\n${lib}\nalive_now "$1" "$2"`, 'x', b, T], { encoding: 'utf8', env: { ...process.env, TOPUP_DIR: dir } }).status === 0;
    const stale = body({ age_s: 4000, ok: false, commit: null });
    assert.equal(run(stale), false, '没暂停：worker 没报到不算活着');
    assert.equal(run(body({ age_s: 0, ok: true, commit: T.slice(0, 7) })), true, '没暂停：新 worker 报到');
    writeFileSync(join(dir, 'state/worker-hold'), 'reason=restore\n');
    assert.equal(run(stale), true, '暂停中：只看 web');
    assert.equal(run(body({ age_s: 4000, ok: false, commit: null }, OLDV.slice(0, 7))), false, '暂停中：web 的提交号仍然要对得上');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const realip = src.slice(src.indexOf('改了以后经 Nginx 的端口') - 600, src.indexOf('改了以后经 Nginx 的端口'));
  assert.match(realip, /alive_now "\$body" "\$\(cur_tag\)"/, '真实 IP 的核对用 alive_now（不是 app_alive）');
});
