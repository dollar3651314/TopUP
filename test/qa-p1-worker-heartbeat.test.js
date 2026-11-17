// 测试先写（测试经理）：上线前清理 P1——自动更新"假成功"。开发不要改这个文件，有异议找测试经理改测试。
// 问题：deploy/kit/topup.sh 的 wait_alive 只看 worker 最近一次扫链在"开始等之后（多留 5 秒）"。旧 worker（被替换之前）
// 刚好在那几秒里跑过一轮，就满足条件——换到一个 worker 根本起不来的新版本，也会判成"更新成功"，接着清理旧镜像（再也换不回去）。
// 要求：判"活着"必须证明跑起来的是新版本——web 的提交号 = 新版本，并且 worker 的心跳里带着它自己的提交号、也 = 新版本。
//
// 这里定下的约定（接口；开发按这个做）：
//   一、worker 心跳带自己的提交号
//      - 心跳仍是 pay_meta 里 key = 'tick_last' 那一行（server/pay/tick.js 的 runTick 每轮最后写），值里加一个字段 commit：
//        { at, commit, ...各步骤结果 }，commit = (process.env.GIT_COMMIT || '').slice(0, 7)，写的时候读环境变量（和健康检查顶层 commit 同一格式）
//   二、健康检查 /api/health/ 的 worker 一项加 commit：
//      - worker = { age_s, ok, commit }（commit 放在 ok 后面，e2e/smoke.sh 的 '"worker":{"age_s":N,"ok":true' 照样能匹配）
//      - worker.commit 原样取自 tick_last.commit（是 worker 写的，不是 web 自己的 GIT_COMMIT）；心跳里没有 commit（旧版本 worker 写的）或还没有心跳 → null
//   三、topup.sh 的 wait_alive（update、rollback、start、set、set-key 等所有"等健康检查"的地方）：
//      - 要求 .commit == 目标版本前 7 位，并且 .worker.commit == 目标版本前 7 位、worker.ok == true，其余条件不变
//      - 只是"worker 心跳新鲜"不够：旧版本 worker 的心跳再新鲜（age_s = 0）也不算新版本活着
//      - update 判失败时照旧：记进 state/skip、换回原版本、不清理镜像（不 docker image rm / prune）、不改 state/previous
//   五、worker 暂停（state/worker-hold，restore 之后 worker 是 --scale worker=0，健康检查里只有恢复出来的旧心跳或没有心跳）：
//      - update 不换版本（不下载、不启动、不清理、不记 skip，退出码 0）——和现在一样，换了版本也证明不了新 worker 活着
//      - 暂停期间 set / set-key 等重建 web 的命令照旧只看 web（不因为 worker 心跳旧 / 没有 commit 而失败）
//      - sudo topup start-worker --confirm 启动 worker 后，同样要等到 worker.commit = 当前版本（心跳没有 commit 或是别的版本 → 失败，退出码非 0）
//   四、e2e/deploy-drill.sh：场景 5（更新到 v2 成功）也要核对 worker.commit = v2；场景 11 的 vB（新 worker 不扫链）
//      在新约定下不再依赖"旧 worker 心跳碰巧过期"，结果必须稳定是"换回 v2"
//
// 做法：server 部分用 PGlite（runTick）和真实 Postgres + Redis（健康检查，需要 TEST_DATABASE_URL、TEST_REDIS_URL，没有时跳过）；
// topup.sh 部分和 test/qa-production-deploy.test.js 一样直接运行 topup.sh，docker、systemctl、curl 等换成假的
// （替身照抄那个文件，只有假 curl 改成 worker 一项可以单独控制）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, appendFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, createPgDb } from '../server/pay/db.js';
import { migrate } from '../server/pay/schema.js';
import { getMeta, setMeta } from '../server/pay/core.js';
import { createFakeTron } from '../server/pay/fake-trongrid.js';
import { runTick } from '../server/pay/tick.js';
import { loadConfig } from '../server/config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KIT = join(ROOT, 'deploy/kit/topup.sh');
const IMG = 'ghcr.io/example/topup';
const V1 = '1'.repeat(40);
const V2 = '2'.repeat(40);
const OLD = 'abcdef0123456789abcdef0123456789abcdef01';
const NEW = '0123456789abcdef0123456789abcdef01234567';
const PG = process.env.TEST_DATABASE_URL || '';
const RD = process.env.TEST_REDIS_URL || '';
const noPg = PG && RD ? false : '没有设置 TEST_DATABASE_URL、TEST_REDIS_URL';
const realDocker = (() => {
  const r = spawnSync('bash', ['-c', 'command -v docker'], { encoding: 'utf8' });
  const p = r.stdout.trim();
  if (!p) return '';
  return spawnSync(p, ['compose', 'version'], { encoding: 'utf8' }).status === 0 ? p : '';
})();

function withCommit(v, fn) {
  const was = process.env.GIT_COMMIT;
  if (v === undefined) delete process.env.GIT_COMMIT; else process.env.GIT_COMMIT = v;
  const back = () => { if (was === undefined) delete process.env.GIT_COMMIT; else process.env.GIT_COMMIT = was; };
  return Promise.resolve().then(fn).finally(back);
}

// ---------- 一、worker 心跳带自己的提交号 ----------

test('worker 心跳：runTick 写的 tick_last 里有 at 和 commit（= GIT_COMMIT 前 7 位，写的时候读环境变量）', async () => {
  const db = await createTestDb(); await migrate(db);
  const err = console.error; console.error = () => {};
  try {
    const tron = createFakeTron({ pageSize: 3 });
    const deps = { db, tron, getTarget: async () => null, fetchImpl: async () => new Response('', { status: 200 }), resolve: async () => [{ address: '203.0.113.10' }] };
    await withCommit(OLD, () => runTick(deps));
    let m = await getMeta(db, 'tick_last');
    assert.ok(m && m.at && !Number.isNaN(Date.parse(m.at)), `tick_last 有 at：${JSON.stringify(m)}`);
    assert.equal(m.commit, OLD.slice(0, 7), `tick_last.commit = 旧版本前 7 位：${JSON.stringify(m)}`);
    // 换版本（同一进程里换环境变量，模拟新镜像的 worker）：下一轮写的是新的
    await withCommit(NEW, () => runTick(deps));
    m = await getMeta(db, 'tick_last');
    assert.equal(m.commit, NEW.slice(0, 7), `下一轮心跳的 commit = 新版本前 7 位：${JSON.stringify(m)}`);
  } finally { console.error = err; try { await db.end?.(); } catch {} }
});

// ---------- 二、健康检查 worker.commit ----------

test('健康检查：worker.commit 来自 worker 的心跳（不是 web 自己的提交号）；旧心跳没有 commit → null；放在 ok 后面', { skip: noPg, timeout: 120_000 }, async () => {
  const schema = `t_qahb_${Date.now().toString(36)}`;
  const a0 = await createPgDb(PG); await a0.query(`create schema ${schema}`); await a0.end();
  const u = new URL(PG); u.searchParams.set('options', `-c search_path=${schema}`);
  const dir = mkdtempSync(join(tmpdir(), 'topup-qahb-'));
  const config = loadConfig({
    APP_ENV: 'staging', DATABASE_URL: u.toString(), REDIS_URL: RD, APP_SECRET: 'h'.repeat(48), BLOB_DIR: dir, PUBLIC_URL: 'https://x.test',
    TRON_NETWORK: 'nile', TRON_NODE_URL: 'http://127.0.0.1:9', TRONGRID_API_KEY: 'k', MAIL_FROM: 'a@example.com', MAIL_TO: 'b@example.com', SMTP_HOST: 'smtp.example.com',
  });
  const err = console.error; console.error = () => {};
  let web;
  try {
    const { createWeb } = await import('../server/web.js');
    const { runOnce } = await import('../server/worker.js');
    web = createWeb(config, { site: dir });
    const app = await web.app;
    const pay = await app.pay;
    const health = async () => { const t = await (await web.handle(new Request('https://x.test/api/health/'))).text(); return { b: JSON.parse(t), t }; };
    // 1) 旧版本的 worker 跑了一轮（和 server/worker.js 的循环同一个函数）
    await withCommit(OLD, () => runOnce({ db: pay.db, tick: pay.tick, daily: async () => ({}), owner: 'qa-hb', atUtc: '23:59', now: Date.now() }));
    // 2) web 已经是新版本，worker 还没换（或换了起不来）：web 的 commit = 新，worker.commit 仍然 = 旧，而且心跳很新鲜
    await withCommit(NEW, async () => {
      const { b, t } = await health();
      assert.equal(b.commit, NEW.slice(0, 7), 'web 的提交号 = 新版本');
      assert.equal(b.worker?.ok, true, `前提：worker 心跳新鲜：${t}`);
      assert.equal(b.worker?.commit, OLD.slice(0, 7), `worker.commit 是 worker 心跳里的（旧版本），不是 web 自己的：${JSON.stringify(b.worker)}`);
      assert.match(t, /"worker":\{"age_s":\d+,"ok":true,"commit":"[0-9a-f]{7}"/, 'worker = { age_s, ok, commit }（e2e/smoke.sh 的匹配不受影响）');
    });
    // 3) 心跳是旧版本 worker 写的、里面没有 commit → worker.commit = null
    await setMeta(pay.db, 'tick_last', { at: new Date().toISOString(), ms: 1 });
    await withCommit(NEW, async () => {
      const { b } = await health();
      assert.ok('commit' in (b.worker || {}), `worker 一项总有 commit 字段：${JSON.stringify(b.worker)}`);
      assert.equal(b.worker.commit, null, '没有 commit 的旧心跳 → null（不能拿 web 的提交号顶上）');
    });
  } finally {
    console.error = err;
    if (web) await (await web.app).close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    const a = await createPgDb(PG); await a.query(`drop schema ${schema} cascade`).catch(() => {}); await a.end();
  }
});

// ---------- 三、topup.sh：只有新版本的 worker 报到才算更新成功 ----------
const FAKE_DOCKER = String.raw`#!/usr/bin/env bash
F=$FAKE
printf '%s\n' "$*" >> "$F/docker.log"
# 容器状态：每行 "名字 项目 镜像 端口"
ps_lines() { [ -f "$F/ps" ] && cat "$F/ps"; }
case "$1" in
  --version) echo "Docker version 29.8.2, build fake"; exit 0 ;;
  pull) [ -f "$F/pull-fail" ] && exit 1; exit 0 ;;
  tag) exit 0 ;;
  image)
    case "$2" in
      inspect) cat "$F/rev" 2> /dev/null; exit 0 ;;
      ls) cat "$F/tags" 2> /dev/null; exit 0 ;;
      *) exit 0 ;;
    esac ;;
  run)
    out=""; prev=""
    for a in "$@"; do [ "$prev" = -v ] && case "$a" in *:/out) out=${"$"}{a%:/out} ;; esac; prev=$a; done
    if [ -n "$out" ]; then cp -r "$REPO/deploy/." "$out/"; cp "$REPO/.env.example" "$out/kit/app.env.example"; fi
    exit 0 ;;
  ps)
    proj=""; fmt=""; prev=""
    for a in "$@"; do
      [ "$prev" = --filter ] && case "$a" in label=com.docker.compose.project=*) proj=${"$"}{a#label=com.docker.compose.project=} ;; esac
      [ "$prev" = --format ] && fmt=$a
      prev=$a
    done
    ps_lines | while read -r n p i ports; do
      [ -z "$proj" ] || [ "$p" = "$proj" ] || continue
      case "$fmt" in *Ports*) echo "$n ${"$"}{ports//;/ }" ;; *) echo "$n" ;; esac
    done
    exit 0 ;;
  exec)
    case "$*" in *"nginx -t"*) [ -f "$F/nginx-t-fail" ] && { echo 'nginx: [emerg] fake'; exit 1; } ;; esac
    exit 0 ;;
  inspect)
    c=${"$"}{@: -1}; ps_lines | awk -v c="$c" '$1 == c { print $3 }'; exit 0 ;;
  stop)
    shift; for c in "$@"; do [ -f "$F/ps" ] && grep -v "^$c " "$F/ps" > "$F/ps.tmp"; [ -f "$F/ps.tmp" ] && mv "$F/ps.tmp" "$F/ps"; done; exit 0 ;;
  compose)
    pre=(); seen=""
    for a in "${"$"}{@:2}"; do
      if [ -z "$seen" ]; then case "$a" in up|down|stop|start|run|exec|ps|logs|restart|config|pull|rm|create) seen=$a ;; *) pre+=("$a") ;; esac; fi
    done
    case "$seen" in
      up)
        tag=$(sed -n 's/^IMAGE_TAG=//p' "$TOPUP_DIR/state/image.env" 2> /dev/null)
        echo "$tag" >> "$F/up"
        if [ -n "$REAL_DOCKER" ]; then "$REAL_DOCKER" compose "${"$"}{pre[@]}" config --format json > "$F/compose-config.json" 2> "$F/compose-config.err" || true; fi
        [ -f "$F/ps" ] && grep -v ' topup ' "$F/ps" > "$F/ps.tmp"; [ -f "$F/ps.tmp" ] && mv "$F/ps.tmp" "$F/ps"
        for s in postgres redis web worker nginx; do echo "topup-$s-1 topup img-$s -" >> "$F/ps"; done
        exit 0 ;;
      down|stop)
        [ -f "$F/ps" ] && grep -v ' topup ' "$F/ps" > "$F/ps.tmp"; [ -f "$F/ps.tmp" ] && mv "$F/ps.tmp" "$F/ps"; exit 0 ;;
      exec)
        case "$*" in
          *"nginx -t"*) [ -f "$F/nginx-t-fail" ] && { echo 'nginx: [emerg] fake'; exit 1; }; echo 'nginx: configuration file /etc/nginx/nginx.conf test is successful' ;;
          *pg_dump*) echo FAKE-DUMP ;;
          *redis-cli*) mkdir -p "$TOPUP_DIR/data/redis"; echo FAKE-RDB > "$TOPUP_DIR/data/redis/backup.rdb" ;;
        esac
        exit 0 ;;
      run) echo mail_not_configured; exit 3 ;;
      *) exit 0 ;;
    esac ;;
  *) exit 0 ;;
esac
`;

const FAKE_SYSTEMCTL = String.raw`#!/usr/bin/env bash
echo "$*" >> "$FAKE/systemctl.log"
case "$1" in
  list-unit-files) for f in "$FAKE"/units/*.timer; do [ -e "$f" ] && echo "$(basename "$f") enabled enabled"; done ;;
  show) cat "$FAKE/units/${"$"}{@: -1}" 2> /dev/null ;;
  is-active) exit 3 ;;
  *) exit 0 ;;
esac
`;

// 健康检查：compose up 过以后返回当前版本（web 的 commit = 现在 image.env 里的版本）。
// worker 那一项单独控制，模拟"旧 worker 的心跳还新鲜、新 worker 根本没起来"：
//   $FAKE/worker-commit 有内容 → worker.commit 一直是它（不跟着换版本；内容是 null 时给 JSON null）；没有这个文件 → 跟着 image.env（新 worker 正常）
//   $FAKE/worker-age 有内容 → worker.age_s 用它；默认 0（刚跑过）
const FAKE_CURL = String.raw`#!/usr/bin/env bash
echo "$*" >> "$FAKE/curl.log"
case "$*" in
  */api/health/*)
    [ -s "$FAKE/up" ] || exit 7
    tag=$(sed -n 's/^IMAGE_TAG=//p' "$TOPUP_DIR/state/image.env" 2> /dev/null)
    env=$(sed -n 's/^TOPUP_ENV=//p' "$TOPUP_DIR/deploy.env" | tail -1)
    net=$(sed -n 's/^TRON_NETWORK=//p' "$TOPUP_DIR/.env" | tail -1)
    wc="\"${"$"}{tag:0:7}\""; [ -s "$FAKE/worker-commit" ] && wc="\"$(cat "$FAKE/worker-commit")\""; [ "$(cat "$FAKE/worker-commit" 2> /dev/null)" = null ] && wc=null
    age=0; [ -s "$FAKE/worker-age" ] && age=$(cat "$FAKE/worker-age")
    wok=true; [ "$age" -le 300 ] || wok=false
    printf '{"ok":true,"env":"%s","commit":"%s","db":true,"storage":true,"secret":true,"blob":true,"mail":false,"mailMode":"none","pay":{"tron":"%s"},"worker":{"age_s":%s,"ok":%s,"commit":%s},"wallet":{"chains":[]}}\n' "$env" "${"$"}{tag:0:7}" "$net" "$age" "$wok" "$wc"
    exit 0 ;;
esac
exit 7
`;

const LOGGER = (name) => `#!/usr/bin/env bash\necho "$*" >> "$FAKE/${name}.log"\nexit 0\n`;
const FAKE_SS = '#!/usr/bin/env bash\necho "$*" >> "$FAKE/ss.log"\ncat "$FAKE/ss" 2> /dev/null\nexit 0\n';
// age：只要能生成"密钥"、能把输入写到输出（这里不测加密本身）
const FAKE_AGE_KEYGEN = String.raw`#!/usr/bin/env bash
if [ "$1" = -o ]; then printf '# public key: age1fakefakefake\nAGE-SECRET-KEY-1FAKE\n' > "$2"; exit 0; fi
if [ "$1" = -y ]; then echo age1fakefakefake; exit 0; fi
exit 0
`;
const FAKE_AGE = String.raw`#!/usr/bin/env bash
out=""; prev=""; for a in "$@"; do [ "$prev" = -o ] && out=$a; prev=$a; done
if [ -n "$out" ]; then { printf 'age-encryption.org/v1\n'; cat; } > "$out"; else cat; fi
`;

const DEBIAN13 = 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nNAME="Debian GNU/Linux"\nVERSION_ID="13"\nVERSION="13 (trixie)"\nVERSION_CODENAME=trixie\nID=debian\n';

/** 一套临时的服务器：假命令、假 demo 项目、空的 /opt/topup */
function server({ demo = true } = {}) {
  const W = mkdtempSync(join(tmpdir(), 'topup-qaprod-'));
  const F = join(W, 'fake');
  const bin = join(W, 'bin');
  mkdirSync(join(F, 'units'), { recursive: true }); mkdirSync(bin); mkdirSync(join(W, 'opt/demo'), { recursive: true });
  const put = (n, s) => { writeFileSync(join(bin, n), s); chmodSync(join(bin, n), 0o755); };
  put('docker', FAKE_DOCKER); put('systemctl', FAKE_SYSTEMCTL); put('curl', FAKE_CURL); put('ss', FAKE_SS);
  put('apt-get', LOGGER('apt-get')); put('certbot', LOGGER('certbot')); put('rclone', LOGGER('rclone'));
  put('age-keygen', FAKE_AGE_KEYGEN); put('age', FAKE_AGE);
  writeFileSync(join(F, 'rev'), V1 + '\n');
  writeFileSync(join(F, 'os-release'), DEBIAN13);
  // 系统自带的定时器（不是别的项目）+ demo 项目（在运行，不占 80/443）
  for (const u of ['apt-daily', 'logrotate']) { writeFileSync(join(F, `units/${u}.timer`), ''); writeFileSync(join(F, `units/${u}.service`), `/usr/lib/${u}`); }
  if (demo) {
    writeFileSync(join(F, 'units/demo-deploy.timer'), '');
    writeFileSync(join(F, 'units/demo-deploy.service'), `{ path=${W}/opt/demo/deploy.sh ; argv[]=${W}/opt/demo/deploy.sh }`);
    writeFileSync(join(F, 'ps'), 'demo-app demo demo/app:1 -\ndemo-db demo redis:7 -\n');
  }
  const s = {
    W, F, dir: join(W, 'opt/topup'),
    read: (n) => { try { return readFileSync(join(F, n), 'utf8'); } catch { return ''; } },
    file: (rel) => { try { return readFileSync(join(W, 'opt/topup', rel), 'utf8'); } catch { return ''; } },
    seed(rel, text) { mkdirSync(dirname(join(s.dir, rel)), { recursive: true }); appendFileSync(join(s.dir, rel), text); },
    set: (n, text) => writeFileSync(join(F, n), text),
    clear: (n) => { try { unlinkSync(join(F, n)); } catch {} },
    run(args, env = {}) {
      const r = spawnSync('bash', [KIT, ...args], {
        encoding: 'utf8', timeout: 60_000,
        env: {
          PATH: `${bin}:${process.env.PATH}`, HOME: W, LANG: 'C.UTF-8', FAKE: F, REPO: ROOT, REAL_DOCKER: realDocker,
          TOPUP_DIR: join(W, 'opt/topup'), LE_DIR: join(W, 'le'), WEBROOT_DIR: join(W, 'www'), TOPUP_OTHERS_ROOT: join(W, 'opt'),
          TOPUP_IMAGE: IMG, TOPUP_WAIT_S: '6', TOPUP_OS_RELEASE: join(F, 'os-release'), NO_PROXY: '*', no_proxy: '*',
          ...env,
        },
      });
      return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
    },
    done: () => rmSync(W, { recursive: true, force: true }),
  };
  return s;
}

const STAGING = { TOPUP_DRILL: '1', TOPUP_DRILL_MEM_MB: '2000', TOPUP_DRILL_DISK_GB: '20' };
const DOMAIN = ['pay.example.com', 'ops@example.com'];
const lastUp = (s) => s.read('up').trim().split('\n').pop();

/** 装好 v1（worker 正常报到 v1），然后 :staging 指向 v2，留几个旧镜像标签（成功时会被清理） */
function installedV1() {
  const s = server({ demo: false });
  const r = s.run(['install', ...DOMAIN], STAGING);
  assert.equal(r.code, 0, `前提：v1 装好：${r.out}`);
  s.set('docker.log', '');
  s.set('rev', V2 + '\n');
  s.set('tags', ['staging', V2, V1, ...['3', '4', '5', '6', '7', '8'].map((c) => c.repeat(40))].join('\n') + '\n');
  return s;
}

test('自动更新：web 已是新版本，但 worker 心跳一直是旧版本的（而且很新鲜，age_s = 0）→ 判失败：换回 v1、记进 skip、不清理镜像', () => {
  const s = installedV1();
  try {
    s.set('worker-commit', V1.slice(0, 7)); // 新 worker 起不来，健康检查里只有旧 worker 的心跳
    const r = s.run(['update'], STAGING);
    const dl = s.read('docker.log');
    assert.notEqual(r.code, 0, `新版本的 worker 从没报到，不能算更新成功：\n${r.out}`);
    assert.equal(s.file('state/skip').trim(), V2, 'v2 记进 state/skip（不再自动重试）');
    assert.equal(lastUp(s), V1, `换回了 v1（最后一次启动的是 v1）：\n${s.read('up')}`);
    assert.doesNotMatch(dl, /image rm |image prune/, `判失败时不清理旧镜像（否则换不回去）：\n${dl}`);
    assert.notEqual(s.file('state/previous').trim(), V2, '没有把 v2 当成成功过的版本');
  } finally { s.done(); }
});

test('对照：新版本 worker 正常报到（worker.commit = v2）→ 更新成功、记下上一个版本 v1、清理旧镜像', () => {
  const s = installedV1();
  try {
    const r = s.run(['update'], STAGING);
    assert.equal(r.code, 0, r.out + s.read('docker.log'));
    assert.equal(lastUp(s), V2);
    assert.equal(s.file('state/previous').trim(), V1);
    assert.match(s.read('docker.log'), /image rm /, '成功后照常清理旧镜像');
  } finally { s.done(); }
});

test('对照：worker.commit = v2 但心跳不新鲜（age_s = 290，开始等之前就写的）→ 也不算活着，换回 v1、不清理', () => {
  const s = installedV1();
  try {
    s.set('worker-age', '290');
    const r = s.run(['update'], STAGING);
    assert.notEqual(r.code, 0, r.out);
    assert.equal(s.file('state/skip').trim(), V2);
    assert.doesNotMatch(s.read('docker.log'), /image rm |image prune/);
  } finally { s.done(); }
});

test('手动 rollback：换回 v1 后 worker 心跳一直是 v2 的（v1 的 worker 没起来）→ 不能报"已换回"，退出码非 0', () => {
  const s = installedV1();
  try {
    assert.equal(s.run(['update'], STAGING).code, 0, '前提：先更新到 v2');
    s.set('worker-commit', V2.slice(0, 7));
    const r = s.run(['rollback'], STAGING);
    assert.notEqual(r.code, 0, `v1 的 worker 没报到，rollback 不能算成功：\n${r.out}`);
    assert.doesNotMatch(r.out, /已换回/, r.out);
  } finally { s.done(); }
});

// ---------- 五、worker 暂停（restore 之后）----------

/** 装好 v1，然后像 restore 之后一样：worker 暂停（state/worker-hold），worker 被缩到 0，健康检查里的心跳是恢复出来的（没有 commit） */
function heldV1() {
  const s = installedV1();
  mkdirSync(join(s.dir, 'state'), { recursive: true });
  writeFileSync(join(s.dir, 'state/worker-hold'), 'backup=topup-20261117-000000-daily.tar.age\nat=2026-11-17 00:00:00 UTC\nby=qa\n');
  s.set('worker-commit', 'null');
  s.set('worker-age', '400');
  return s;
}

test('worker 暂停时：有新版本也不更新（不下载、不启动、不清理、不记 skip，退出码 0）', () => {
  const s = heldV1();
  try {
    const ups = s.read('up');
    const r = s.run(['update'], STAGING);
    assert.equal(r.code, 0, r.out);
    const dl = s.read('docker.log');
    assert.equal(s.read('up'), ups, '没有启动任何版本');
    assert.doesNotMatch(dl, /^pull |image rm |image prune/m, `没有下载、没有清理：\n${dl}`);
    assert.equal(s.file('state/skip'), '', '不记 skip');
  } finally { s.done(); }
});

test('worker 暂停时：set MAIL_TO 重建 web 照常成功（只看 web；worker 心跳旧、没有 commit 不算失败）', () => {
  const s = heldV1();
  try {
    const r = s.run(['set', 'MAIL_TO', 'ops@example.com'], STAGING);
    assert.equal(r.code, 0, r.out);
  } finally { s.done(); }
});

test('start-worker --confirm：worker 启动后心跳一直没有 commit（新 worker 没报到）→ 退出码非 0，不能报"worker 已启动"', () => {
  const s = heldV1();
  try {
    s.set('worker-age', '0'); // 心跳很新鲜，但不是当前版本的 worker 写的（没有 commit）
    const r = s.run(['start-worker', '--confirm'], STAGING);
    assert.notEqual(r.code, 0, `worker.commit 不是当前版本，不能算启动成功：\n${r.out}`);
    assert.doesNotMatch(r.out, /worker 已启动/, r.out);
  } finally { s.done(); }
});

test('对照：start-worker --confirm，worker.commit = 当前版本、心跳新鲜 → 成功', () => {
  const s = heldV1();
  try {
    s.clear('worker-commit'); s.set('worker-age', '0');
    const r = s.run(['start-worker', '--confirm'], STAGING);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /worker 已启动/);
  } finally { s.done(); }
});
