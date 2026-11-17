// 测试先写（测试经理）：上线前清理 P1 —— 部署工具 deploy/kit/topup.sh 的三件事。开发不要改这个文件，有异议找测试经理改测试。
// 做法和 test/qa-production-deploy.test.js 一样（直接运行 topup.sh，docker、systemctl、curl 等换成假的、记下调用；替身脚本照抄那个文件，
// 那个文件不导出、也不改它）。另加一个假的 date：时间戳格式（+%Y%m%d-%H%M%S）一律回同一个时刻，模拟"同一秒里跑了两次"。
//
// 这里定下的约定（接口；开发按这个做）：
//   一、sudo topup admin-reset --confirm：管理员密码 / 验证器丢了时重置运营后台的管理员账号
//      - 用法列表里有一行 "sudo topup admin-reset"；还没部署过 → 拒绝；不带 --confirm → 什么都不做（退出码非 0，说明要加 --confirm）
//      - 带 --confirm：用 redis-cli 删掉 Redis 里的管理员凭据（topup:admin 以及 topup:admin:pending / lock / fails / totp-last），
//        换一个新的 ADMIN_SETUP_TOKEN（写进 .env，旧口令作废），重建 web 让它生效；之后 sudo topup admin-token 显示的是新口令，后台可以重新初始化
//      - 屏幕输出和日志里不出现新旧口令；日志（logs/admin-reset-*.log）记下谁（SUDO_USER）、什么时候做的；尝试发一封提醒邮件
//      - 要 root：和别的子命令一样（这里不单测）
//   二、sudo topup restore [备份文件名] --confirm：把本机的加密备份恢复进正在运行的系统
//      - 用法列表里有 "sudo topup restore"；本机没有备份 → 拒绝；不带 --confirm → 什么都不做（不停服务、不导入）
//      - 不写文件名用最新的一份；写了文件名（backup/ 下的 topup-*.tar.age）就用那一份，找不到就拒绝
//      - 生产（TOPUP_ENV=production）还要再加 --production，否则拒绝
//      - 先做一次备份（标签含 restore，例如 topup-<时间>-pre-restore.tar.age），再停 web、worker，pg_restore --clean 导入正在运行的 Postgres，
//        恢复 Redis 和开户文件（data/blobs），再启动、等健康检查通过
//      - 不覆盖现在的 .env、deploy.env；备份里的 APP_SECRET 和现在的不一样 → 拒绝（开户资料、敏感字段解不开），什么都不动
//      - 输出、日志里不出现 APP_SECRET 等密钥的值
//   三、日志文件名每次运行都不同（同一秒里跑两次也不会互相覆盖、互相删掉）：watch、update、backup 都是
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, appendFileSync, unlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KIT = join(ROOT, 'deploy/kit/topup.sh');
const IMG = 'ghcr.io/example/topup';
const V1 = '1'.repeat(40);
const V2 = '2'.repeat(40);
const realDocker = (() => {
  const r = spawnSync('bash', ['-c', 'command -v docker'], { encoding: 'utf8' });
  const p = r.stdout.trim();
  if (!p) return '';
  return spawnSync(p, ['compose', 'version'], { encoding: 'utf8' }).status === 0 ? p : '';
})();
const noCompose = realDocker ? false : '没有 docker compose（核对 compose 配置要用）';

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

// 健康检查：compose up 过以后返回当前版本、环境、worker 刚跑过（worker.commit = 当前版本：新 worker 报到了；约定见 test/qa-p1-worker-heartbeat.test.js）
const FAKE_CURL = String.raw`#!/usr/bin/env bash
echo "$*" >> "$FAKE/curl.log"
case "$*" in
  */api/health/*)
    [ -s "$FAKE/up" ] || exit 7
    # 经 nginx 的内部端口（127.0.0.1:8080）那一路可以单独弄坏
    case "$*" in *127.0.0.1:8080/*) [ -f "$FAKE/gw-health-fail" ] && exit 7 ;; esac
    tag=$(sed -n 's/^IMAGE_TAG=//p' "$TOPUP_DIR/state/image.env" 2> /dev/null)
    env=$(sed -n 's/^TOPUP_ENV=//p' "$TOPUP_DIR/deploy.env" | tail -1)
    net=$(sed -n 's/^TRON_NETWORK=//p' "$TOPUP_DIR/.env" | tail -1)
    printf '{"ok":true,"env":"%s","commit":"%s","db":true,"storage":true,"secret":true,"blob":true,"mail":false,"mailMode":"none","pay":{"tron":"%s"},"worker":{"age_s":0,"ok":true,"commit":"%s"},"wallet":{"chains":[]}}\n' "$env" "${"$"}{tag:0:7}" "$net" "${"$"}{tag:0:7}"
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
// age：加密 = 加一行头；解密（-d）= 去掉这一行头（恢复要真的能解开备份）；输入是最后一个参数（文件）或标准输入
const FAKE_AGE = String.raw`#!/usr/bin/env bash
out=""; dec=""; prev=""; last=""; for a in "$@"; do [ "$prev" = -o ] && out=$a; [ "$a" = -d ] && dec=1; prev=$a; last=$a; done
src=/dev/stdin; [ -f "$last" ] && [ "$last" != "$out" ] && src=$last
if [ -n "$dec" ]; then tail -n +2 "$src" > "${"$"}{out:-/dev/stdout}"; exit 0; fi
if [ -n "$out" ]; then { printf 'age-encryption.org/v1\n'; cat "$src"; } > "$out"; else cat "$src"; fi
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


const kv = (text, k) => (text.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1];
const STAGING = { TOPUP_DRILL: '1', TOPUP_DRILL_MEM_MB: '2000', TOPUP_DRILL_DISK_GB: '20' };
const PROD = { TOPUP_DRILL: '1', TOPUP_ENV: 'production', TOPUP_GATEWAY: 'platform', TOPUP_HTTP_PORT: '8080', TOPUP_DRILL_MEM_MB: '3000', TOPUP_DRILL_DISK_GB: '11' };
const DOMAIN = ['pay.example.com', 'ops@example.com'];
const PDOM = ['8080-qa0test.example.invalid'];
const logs = (s, prefix) => { try { return readdirSync(join(s.dir, 'logs')).filter((f) => f.startsWith(`${prefix}-`) && f.endsWith('.log')); } catch { return []; } };
const backups = (s) => { try { return readdirSync(join(s.dir, 'backup')).filter((f) => /^topup-.*\.tar\.age$/.test(f)); } catch { return []; } };
const linesAfter = (text, n) => text.split('\n').slice(n).join('\n');

/** 部署好的测试环境（或生产）；SUDO_USER 记成 qa-ops */
function deployed(env = STAGING, dom = DOMAIN) {
  const s = server();
  const r = s.run(['install', ...dom], env);
  assert.equal(r.code, 0, `前提：部署成功\n${r.out}`);
  const run = s.run;
  s.run = (args, extra = {}) => run(args, { ...env, SUDO_USER: 'qa-ops', ...extra });
  return s;
}

// ---------- 一、admin-reset ----------

test('admin-reset：用法里有；没部署过拒绝；不带 --confirm 什么都不做', () => {
  const s = server();
  try {
    const u = s.run(['help'], STAGING);
    assert.match(u.out, /sudo topup admin-reset/, `用法列表里要有 admin-reset：\n${u.out}`);
    const r0 = s.run(['admin-reset', '--confirm'], STAGING);
    assert.notEqual(r0.code, 0, '还没部署过：拒绝');
  } finally { s.done(); }
  const d = deployed();
  try {
    const token = kv(d.file('.env'), 'ADMIN_SETUP_TOKEN');
    const n = d.read('docker.log').split('\n').length;
    const r = d.run(['admin-reset']);
    assert.notEqual(r.code, 0, `不带 --confirm：不做（退出码非 0）\n${r.out}`);
    assert.match(r.out, /--confirm/, '说明怎么确认');
    assert.doesNotMatch(r.out, /不认识/, '要认识这个子命令');
    assert.doesNotMatch(linesAfter(d.read('docker.log'), n - 1), /redis-cli/, '没有动 Redis');
    assert.equal(kv(d.file('.env'), 'ADMIN_SETUP_TOKEN'), token, '初始化口令没变');
  } finally { d.done(); }
});

test('admin-reset --confirm：删掉 Redis 里的管理员凭据、换新的初始化口令并重建 web；屏幕和日志里没有新旧口令；日志记下是谁做的；admin-token 显示新口令', () => {
  const d = deployed();
  try {
    const old = kv(d.file('.env'), 'ADMIN_SETUP_TOKEN');
    assert.ok(old && old.length >= 16, '前提：install 生成过初始化口令');
    const n = d.read('docker.log').split('\n').length;
    const r = d.run(['admin-reset', '--confirm']);
    assert.equal(r.code, 0, r.out);
    const dl = linesAfter(d.read('docker.log'), n - 1);
    const del = dl.split('\n').find((l) => /redis-cli/.test(l) && /topup:admin/.test(l));
    assert.ok(del, `用 redis-cli 删 topup:admin：\n${dl}`);
    for (const k of ['topup:admin:pending', 'topup:admin:lock', 'topup:admin:fails', 'topup:admin:totp-last']) assert.ok(dl.includes(k), `也删 ${k}（锁定、失败计数、半途的初始化）`);
    assert.match(dl, /compose .*\bup\b.*\bweb\b|compose .*restart.*\bweb\b/, `重建 web（新口令生效）：\n${dl}`);
    const now = kv(d.file('.env'), 'ADMIN_SETUP_TOKEN');
    assert.ok(now && now !== old && now.length >= old.length, '换了一个新的初始化口令（旧的作废）');
    const logsText = logs(d, 'admin-reset').map((f) => d.file(`logs/${f}`)).join('\n');
    assert.ok(logsText, '有 admin-reset 的日志');
    for (const t of [old, now]) {
      assert.ok(!r.out.includes(t), '屏幕上不显示口令');
      assert.ok(!logsText.includes(t), '日志里没有口令');
    }
    assert.match(logsText, /qa-ops/, '日志记下是谁做的（SUDO_USER）');
    assert.match(dl, /\brun\b.*ALERT_SUBJECT/, '尝试发一封提醒邮件（没配邮件时只记日志）');
    const t = d.run(['admin-token']);
    assert.equal(t.code, 0, t.out);
    assert.ok(t.out.includes(now) && !t.out.includes(old), 'admin-token 显示的是新口令');
  } finally { d.done(); }
});

// ---------- 二、restore ----------

/** 部署好、做过一次备份（备份前 data/blobs 里有一个开户文件） */
function withBackup(env = STAGING, dom = DOMAIN) {
  const d = deployed(env, dom);
  d.seed('data/blobs/kyb/doc-1.bin', 'doc-1');
  const b = d.run(['backup']);
  assert.equal(b.code, 0, `前提：备份成功\n${b.out}`);
  assert.equal(backups(d).length, 1);
  return d;
}

test('restore：用法里有；本机没有备份 → 拒绝；不带 --confirm → 不停服务、不导入；写了不存在的文件名 → 拒绝', () => {
  const d = deployed();
  try {
    assert.match(d.run(['help']).out, /sudo topup restore\b/, '用法列表里要有 restore');
    const r0 = d.run(['restore', '--confirm']);
    assert.notEqual(r0.code, 0, '没有备份：拒绝');
    assert.doesNotMatch(r0.out, /不认识/);
  } finally { d.done(); }
  const s = withBackup();
  try {
    const n = s.read('docker.log').split('\n').length;
    const r = s.run(['restore']);
    assert.notEqual(r.code, 0, '不带 --confirm：不做');
    assert.match(r.out, /--confirm/);
    const dl = linesAfter(s.read('docker.log'), n - 1);
    assert.doesNotMatch(dl, /pg_restore|compose .*\b(stop|down)\b/, `没停服务、没导入：\n${dl}`);
    const r2 = s.run(['restore', 'topup-20000101-000000-nope.tar.age', '--confirm']);
    assert.notEqual(r2.code, 0, '找不到这份备份：拒绝');
    assert.doesNotMatch(linesAfter(s.read('docker.log'), n - 1), /pg_restore/);
  } finally { s.done(); }
});

test('restore --confirm（测试环境）：先备份一次（标签含 restore）→ 停 web、worker → pg_restore --clean 导入 → 开户文件恢复 → 启动；.env 不被覆盖；没有密钥的值', () => {
  const s = withBackup();
  try {
    rmSync(join(s.dir, 'data/blobs/kyb/doc-1.bin'));
    s.seed('data/blobs/kyb/after-backup.bin', 'later');
    const envBefore = s.file('.env');
    const n = s.read('docker.log').split('\n').length;
    const r = s.run(['restore', '--confirm']);
    assert.equal(r.code, 0, r.out);
    const dl = linesAfter(s.read('docker.log'), n - 1);
    const at = (re) => dl.split('\n').findIndex((l) => re.test(l));
    assert.ok(backups(s).some((f) => /restore/.test(f)), `先做了一份恢复前的备份：${backups(s)}`);
    assert.ok(at(/pg_dump/) >= 0 && at(/pg_dump/) < at(/pg_restore/), `恢复前先备份（pg_dump 在 pg_restore 之前）：\n${dl}`);
    assert.ok(at(/compose .*\b(stop|rm)\b.*\bweb\b|compose .*\bstop\b.*\bworker\b/) >= 0 && at(/compose .*\b(stop|rm)\b.*(web|worker)/) < at(/pg_restore/), `导入前停 web、worker：\n${dl}`);
    assert.match(dl.split('\n')[at(/pg_restore/)], /--clean/, 'pg_restore --clean（导入正在运行的库，先清掉旧对象）');
    assert.ok(at(/compose .*\bup\b/) > at(/pg_restore/), '导入后重新启动');
    assert.ok(existsSync(join(s.dir, 'data/blobs/kyb/doc-1.bin')), '开户文件恢复成备份时的样子');
    assert.equal(s.file('.env'), envBefore, '.env 不被覆盖');
    const secret = kv(envBefore, 'APP_SECRET');
    const logsText = logs(s, 'restore').map((f) => s.file(`logs/${f}`)).join('\n');
    assert.ok(secret && !r.out.includes(secret) && !logsText.includes(secret), '输出和日志里没有 APP_SECRET');
  } finally { s.done(); }
});

test('restore：写了文件名就用那一份；备份里的 APP_SECRET 和现在的不同 → 拒绝、什么都不动', () => {
  const s = withBackup();
  try {
    const name = backups(s)[0];
    const r = s.run(['restore', name, '--confirm']);
    assert.equal(r.code, 0, r.out);
    assert.ok(r.out.includes(name), '说明用的是哪一份');
  } finally { s.done(); }
  const t = withBackup();
  try {
    const e = t.file('.env').replace(/^APP_SECRET=.*$/m, `APP_SECRET=${'z'.repeat(48)}`);
    writeFileSync(join(t.dir, '.env'), e);
    const n = t.read('docker.log').split('\n').length;
    const r = t.run(['restore', '--confirm']);
    assert.notEqual(r.code, 0, `主密钥不一致：拒绝\n${r.out}`);
    assert.match(r.out, /APP_SECRET|主密钥/);
    const dl = linesAfter(t.read('docker.log'), n - 1);
    assert.doesNotMatch(dl, /pg_restore|compose .*\b(stop|down)\b/, '什么都不动');
    assert.ok(!r.out.includes('z'.repeat(48)), '不显示密钥的值');
  } finally { t.done(); }
});

test('restore（生产）：只有 --confirm 拒绝，要再加 --production；两个都有才恢复', () => {
  const s = withBackup(PROD, PDOM);
  try {
    const n = s.read('docker.log').split('\n').length;
    const r = s.run(['restore', '--confirm']);
    assert.notEqual(r.code, 0, `生产只有 --confirm：拒绝\n${r.out}`);
    assert.match(r.out, /--production/);
    assert.doesNotMatch(linesAfter(s.read('docker.log'), n - 1), /pg_restore/);
    const r2 = s.run(['restore', '--confirm', '--production']);
    assert.equal(r2.code, 0, r2.out);
    assert.match(linesAfter(s.read('docker.log'), n - 1), /pg_restore/);
  } finally { s.done(); }
});

// ---------- 三、日志文件名每次不同 ----------

/** 假 date：时间戳格式一律回同一秒，其余交给真的 date */
function freezeDate(s) {
  const real = spawnSync('bash', ['-c', 'command -v date'], { encoding: 'utf8' }).stdout.trim();
  const bin = join(s.W, 'bin');
  writeFileSync(join(bin, 'date'), `#!/usr/bin/env bash\nfor a in "$@"; do case "$a" in *%Y%m%d-%H%M%S*) echo 20261117-120000; exit 0 ;; esac; done\nexec ${real} "$@"\n`);
  chmodSync(join(bin, 'date'), 0o755);
}

test('日志文件名：同一秒里跑两次 watch——第一次（状态变了，留日志）的日志不被第二次（没变化，删掉自己的日志）覆盖或删掉', () => {
  const s = deployed();
  try {
    freezeDate(s);
    rmSync(join(s.dir, 'state/watch'), { force: true });
    for (const f of logs(s, 'watch')) rmSync(join(s.dir, 'logs', f));
    assert.equal(s.run(['watch']).code, 0);
    const first = logs(s, 'watch');
    assert.equal(first.length, 1, '第一次：状态变了，留一份日志');
    const text = s.file(`logs/${first[0]}`);
    assert.match(text, /状态变化/);
    assert.equal(s.run(['watch']).code, 0);
    const after = logs(s, 'watch');
    assert.deepEqual(after, first, `第二次（没变化）只删它自己的日志，第一次的还在：${after}`);
    assert.equal(s.file(`logs/${first[0]}`), text, '第一次的日志内容没被清空');
  } finally { s.done(); }
});

test('日志文件名：同一秒里跑两次 backup → 两份日志；update 先换版本（留日志）再跑一次（没有新版本）→ 第一次的日志还在', () => {
  const s = deployed();
  try {
    freezeDate(s);
    assert.equal(s.run(['backup']).code, 0);
    assert.equal(s.run(['backup', 'manual']).code, 0);
    assert.equal(logs(s, 'backup').length, 2, `两次备份各一份日志：${logs(s, 'backup')}`);
    for (const f of logs(s, 'update')) rmSync(join(s.dir, 'logs', f));
    s.set('rev', V2 + '\n');
    const u1 = s.run(['update']);
    assert.equal(u1.code, 0, u1.out);
    const first = logs(s, 'update');
    assert.equal(first.length, 1, '换了版本：留一份日志');
    assert.equal(s.run(['update']).code, 0);
    assert.deepEqual(logs(s, 'update'), first, '第二次（没有新版本）不覆盖、不删第一次的日志');
  } finally { s.done(); }
});
