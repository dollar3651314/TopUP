// 测试先写（测试经理）：生产环境的部署路径（deploy/kit/topup.sh + deploy/compose.yml）。开发不要改这个文件，有异议找测试经理改。
// 生产"先搭起来，不算上线"：生产机是管理员自己的一台小虚拟机（Debian 13、4 核、8 GB 内存、16 GB 磁盘约 11 GB 空闲、已装 Docker），
// 网卡上没有公网 IP，外面进来只能走平台自带的端口发布（平台网关做 TLS，转到机器上的一个内部端口）。
//
// 这里定下的约定（接口；开发按这个做）：
//   - 第一次部署：TOPUP_ENV=production TOPUP_GATEWAY=platform TOPUP_HTTP_PORT=<端口> bash topup.sh install <平台发布的主机名>
//     （平台网关模式不要证书邮箱、不做 DNS 和证书；PUBLIC_URL = https://<这个主机名>；不是网关模式时照旧 install <域名> <邮箱>）
//     · deploy.env 写 TOPUP_ENV=production；.env 写 TRON_NETWORK=mainnet；"在平台网关后面"模式时 deploy.env 写 TOPUP_GATEWAY=platform、TOPUP_HTTP_PORT=<端口>
//     · 镜像只用 <镜像>:production（下载、取工具包、看版本号、自动更新都跟着这个标签），不碰 :staging
//     · 生产必须 TRON_NETWORK=mainnet，测试环境必须 nile，不对就拒绝、不启动；已经按测试环境装过的机器不能直接改成生产（反过来也一样）
//     · .env 里有 TEST_ADMIN_TOKEN_SHA256 或 TEST_MERCHANT_IP_BYPASS 时生产拒绝启动（install、start），提示里只有变量名
//     · 生产从不停别的项目（只检查、报出名字）；测试环境照旧停
//     · 平台网关模式：不申请证书（不调 certbot、不生成自签名证书），不检查 80/443，nginx 只发布 TOPUP_HTTP_PORT；改为检查这个端口有没有被占
//     · 不是网关模式时，80/443 的检查也要看本机进程（ss -ltnp），不只看容器；TopUP 自己的容器（docker-proxy）不算占用
//     · 内存上限按环境：测试环境不变（合计 880 MB）；生产 postgres 1024 / redis 256 / web 512 / worker 512 / nginx 64（合计 2368 MB），
//       第 5 步那一行的"容器上限合计 N MB"要和 compose.yml 实际生效的上限之和一致；Node 堆、Postgres、Redis 参数按环境
//     · web、worker 两个应用服务 pull_policy: never（只用部署工具拉好的镜像）
//     · 磁盘：16 GB 的盘剩 11 GB 能部署，剩 3 GB 不能
//     · 系统：Debian 13（trixie）照常支持；机器上已经有 Docker 时不重装、不改 Docker 的设置、不重启 Docker（会把机器上别的容器一起重启）
//     · 系统信息文件可以用 TOPUP_OS_RELEASE 指定（默认 /etc/os-release；测试用）
//     · 异地备份的目录跟着环境走（topup-production/），不写死 topup-staging
// 做法：和 e2e/deploy-drill.sh 一样直接运行 topup.sh，但 docker、systemctl、curl、ss、apt-get、certbot、rclone、age 都换成假的（记下调用），
// 不起容器；compose 的 up 那一次用真的 docker compose config（同样的参数和变量文件）算出实际生效的配置来核对内存上限、端口。
// 没有 docker compose 时跳过和 compose 配置有关的检查。真实容器的演练仍用 e2e/deploy-drill.sh。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, appendFileSync, unlinkSync } from 'node:fs';
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

// 健康检查：compose up 过以后返回当前版本、环境、worker 刚跑过
const FAKE_CURL = String.raw`#!/usr/bin/env bash
echo "$*" >> "$FAKE/curl.log"
case "$*" in
  */api/health/*)
    [ -s "$FAKE/up" ] || exit 7
    tag=$(sed -n 's/^IMAGE_TAG=//p' "$TOPUP_DIR/state/image.env" 2> /dev/null)
    env=$(sed -n 's/^TOPUP_ENV=//p' "$TOPUP_DIR/deploy.env" | tail -1)
    net=$(sed -n 's/^TRON_NETWORK=//p' "$TOPUP_DIR/.env" | tail -1)
    printf '{"ok":true,"env":"%s","commit":"%s","db":true,"storage":true,"secret":true,"blob":true,"mail":false,"mailMode":"none","pay":{"tron":"%s"},"worker":{"age_s":0,"ok":true},"wallet":{"chains":[]}}\n' "$env" "${"$"}{tag:0:7}" "$net"
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

const kv = (text, k) => (text.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1];
const PROD = { TOPUP_DRILL: '1', TOPUP_ENV: 'production', TOPUP_GATEWAY: 'platform', TOPUP_HTTP_PORT: '8080', TOPUP_DRILL_MEM_MB: '3000', TOPUP_DRILL_DISK_GB: '11' };
const STAGING = { TOPUP_DRILL: '1', TOPUP_DRILL_MEM_MB: '2000', TOPUP_DRILL_DISK_GB: '20' };
const DOMAIN = ['pay.example.com', 'ops@example.com'];
// 生产第一次部署用平台发布的地址（https://<端口>-<编号>.<平台域名>）：只给主机名、不给证书邮箱
const GW_HOST = '8080-qa0test.instabox.tech';
const PDOM = [GW_HOST];

/** compose 实际生效的配置（compose up 那一次） */
function composeCfg(s) {
  const raw = s.read('compose-config.json');
  assert.ok(raw, `docker compose config 没有输出：${s.read('compose-config.err')}`);
  return JSON.parse(raw);
}
const MB = (v) => Math.round(Number(v) / 1048576);
const svcMem = (cfg) => Object.fromEntries(['postgres', 'redis', 'web', 'worker', 'nginx'].map((n) => [n, MB(cfg.services[n].mem_limit)]));
const cmdOf = (svc) => [].concat(svc.command || [], svc.entrypoint || []).join(' ');
const published = (svc) => (svc.ports || []).map((p) => String(p.published));

// ---------- 一、生产第一次部署（平台网关模式） ----------

test('生产第一次部署（平台网关模式）：一条命令完成；deploy.env / .env 按生产写；只用 :production 镜像；没申请证书', () => {
  const s = server();
  try {
    const r = s.run(['install', ...PDOM], PROD);
    assert.equal(r.code, 0, r.out);
    const d = s.file('deploy.env'); const e = s.file('.env');
    assert.equal(kv(d, 'TOPUP_ENV'), 'production', 'deploy.env：TOPUP_ENV=production');
    assert.equal(kv(e, 'TRON_NETWORK'), 'mainnet', '.env：TRON_NETWORK=mainnet');
    assert.equal(kv(d, 'TOPUP_GATEWAY'), 'platform', 'deploy.env 记下平台网关模式');
    assert.equal(kv(d, 'TOPUP_HTTP_PORT'), '8080', 'deploy.env 记下内部端口');
    const dl = s.read('docker.log');
    assert.match(dl, new RegExp(`${IMG}:production\\b`), '用 :production 标签');
    assert.doesNotMatch(dl, /:staging\b/, `生产不碰 :staging：\n${dl}`);
    assert.equal(s.read('up').trim(), V1, '启动的是 :production 指向的版本');
    assert.equal(s.read('certbot.log'), '', '不调 certbot');
    assert.ok(!existsSync(join(s.W, 'le/live/topup/fullchain.pem')), '网关模式不生成证书（自签名也不要）');
    assert.doesNotMatch(r.out, /^✗/m, r.out);
    assert.equal(kv(d, 'DOMAIN'), GW_HOST, 'deploy.env：DOMAIN = 平台发布的主机名');
  } finally { s.done(); }
});

test('生产从不停别的项目：demo 项目在运行 → 只报出名字，不停它的定时器、不停它的容器', () => {
  const s = server();
  try {
    const r = s.run(['install', ...PDOM], PROD);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /demo/, '报出别的项目的名字');
    const sc = s.read('systemctl.log');
    assert.doesNotMatch(sc, /(disable|stop).*demo-/, `没碰 demo 的定时器：\n${sc}`);
    assert.doesNotMatch(s.read('docker.log'), /^stop .*demo-/m, '没停 demo 的容器');
    assert.match(s.read('ps'), /^demo-app /m, 'demo 还在运行');
    // start 也一样
    s.run(['stop'], PROD);
    const r2 = s.run(['start'], PROD);
    assert.equal(r2.code, 0, r2.out);
    assert.doesNotMatch(s.read('systemctl.log'), /(disable|stop).*demo-/);
    assert.doesNotMatch(s.read('docker.log'), /^stop .*demo-/m);
  } finally { s.done(); }
});

test('对照：测试环境照旧停别的项目（demo）', () => {
  const s = server();
  try {
    const r = s.run(['install', ...DOMAIN], STAGING);
    assert.equal(r.code, 0, r.out);
    assert.match(s.read('systemctl.log'), /disable --now demo-deploy\.timer/);
    assert.equal(kv(s.file('.env'), 'TRON_NETWORK'), 'nile');
    assert.equal(kv(s.file('deploy.env'), 'TOPUP_ENV'), 'staging');
  } finally { s.done(); }
});

// ---------- 二、主网 / 测试网互相拒绝；生产拒绝两个测试变量 ----------

test('生产：.env 里 TRON_NETWORK 不是 mainnet → 拒绝、不启动', () => {
  const s = server();
  try {
    s.seed('.env', 'TRON_NETWORK=nile\n');
    const r = s.run(['install', ...PDOM], PROD);
    assert.notEqual(r.code, 0, r.out);
    assert.equal(s.read('up'), '', '没有启动');
    assert.match(r.out, /mainnet/, '说明生产要连主网');
  } finally { s.done(); }
});

test('测试环境：.env 里 TRON_NETWORK=mainnet → 拒绝、不启动', () => {
  const s = server();
  try {
    s.seed('.env', 'TRON_NETWORK=mainnet\n');
    const r = s.run(['install', ...DOMAIN], STAGING);
    assert.notEqual(r.code, 0, r.out);
    assert.equal(s.read('up'), '');
  } finally { s.done(); }
});

test('已经按测试环境装过的机器，不能直接用 TOPUP_ENV=production 再 install（反过来也不行）', () => {
  for (const [had, want] of [['staging', PROD], ['production', STAGING]]) {
    const s = server();
    try {
      s.seed('deploy.env', `TOPUP_ENV=${had}\n`);
      const r = s.run(['install', ...(want === PROD ? PDOM : DOMAIN)], want);
      assert.notEqual(r.code, 0, `${had} → ${want.TOPUP_ENV || 'staging'}：${r.out}`);
      assert.equal(s.read('up'), '');
      assert.equal(kv(s.file('deploy.env'), 'TOPUP_ENV'), had, 'deploy.env 没被改');
    } finally { s.done(); }
  }
});

test('生产：.env 里有 TEST_ADMIN_TOKEN_SHA256 或 TEST_MERCHANT_IP_BYPASS → install 拒绝、不启动，提示里只有变量名', () => {
  const hash = 'ab'.repeat(32);
  for (const [k, v] of [['TEST_ADMIN_TOKEN_SHA256', hash], ['TEST_MERCHANT_IP_BYPASS', 'm_qaprod777']]) {
    const s = server();
    try {
      s.seed('.env', `${k}=${v}\n`);
      const r = s.run(['install', ...PDOM], PROD);
      assert.notEqual(r.code, 0, `${k}：${r.out}`);
      assert.equal(s.read('up'), '', `${k}：没有启动`);
      assert.match(r.out, new RegExp(k), '提示里有变量名');
      assert.ok(!r.out.includes(v), '提示里没有值');
    } finally { s.done(); }
  }
});

test('生产装好以后：start 时发现测试变量 → 拒绝；set TEST_MERCHANT_IP_BYPASS、gen-test-admin 拒绝', () => {
  const s = server();
  try {
    assert.equal(s.run(['install', ...PDOM], PROD).code, 0);
    let r = s.run(['set', 'TEST_MERCHANT_IP_BYPASS', 'm_x1'], PROD);
    assert.notEqual(r.code, 0); assert.equal(kv(s.file('.env'), 'TEST_MERCHANT_IP_BYPASS') || '', '');
    r = s.run(['gen-test-admin'], PROD);
    assert.notEqual(r.code, 0); assert.equal(kv(s.file('.env'), 'TEST_ADMIN_TOKEN_SHA256') || '', '');
    s.run(['stop'], PROD);
    s.seed('.env', 'TEST_ADMIN_TOKEN_SHA256=' + 'cd'.repeat(32) + '\n');
    const ups = s.read('up');
    r = s.run(['start'], PROD);
    assert.notEqual(r.code, 0, r.out);
    assert.equal(s.read('up'), ups, '没有启动');
  } finally { s.done(); }
});

test('生产装好以后：.env 被改成 TRON_NETWORK=nile → start 拒绝', () => {
  const s = server();
  try {
    assert.equal(s.run(['install', ...PDOM], PROD).code, 0);
    s.run(['stop'], PROD);
    s.seed('.env', 'TRON_NETWORK=nile\n');
    const ups = s.read('up');
    const r = s.run(['start'], PROD);
    assert.notEqual(r.code, 0, r.out);
    assert.equal(s.read('up'), ups);
  } finally { s.done(); }
});

// ---------- 三、内存上限按环境；pull_policy；端口 ----------

test('生产：compose 实际生效的内存上限、Node 堆、Postgres、Redis 参数按生产；第 5 步报的合计和实际一致；web、worker pull_policy: never；nginx 只发布内部端口', { skip: noCompose }, () => {
  const s = server();
  try {
    const r = s.run(['install', ...PDOM], PROD);
    assert.equal(r.code, 0, r.out);
    const cfg = composeCfg(s);
    const mem = svcMem(cfg);
    assert.deepEqual(mem, { postgres: 1024, redis: 256, web: 512, worker: 512, nginx: 64 });
    for (const n of Object.keys(mem)) assert.equal(cfg.services[n].memswap_limit, cfg.services[n].mem_limit, `${n}：不用交换分区`);
    const sum = Object.values(mem).reduce((a, b) => a + b, 0);
    assert.equal(Number((r.out.match(/容器上限合计 (\d+) MB/) || [])[1]), sum, `第 5 步的合计 = compose 实际上限之和 ${sum}`);
    for (const n of ['web', 'worker']) {
      assert.match(cfg.services[n].environment.NODE_OPTIONS, /--max-old-space-size=384\b/, `${n} 堆 384`);
      assert.equal(cfg.services[n].pull_policy, 'never', `${n} pull_policy: never`);
      assert.equal(cfg.services[n].environment.APP_ENV, 'production');
      assert.equal(cfg.services[n].environment.PUBLIC_URL, `https://${GW_HOST}`, `${n}：PUBLIC_URL 是平台发布的 https 地址`);
    }
    const pg = cmdOf(cfg.services.postgres);
    assert.match(pg, /shared_buffers=256MB/); assert.match(pg, /effective_cache_size=1GB/); assert.match(pg, /max_connections=40\b/);
    const rd = cmdOf(cfg.services.redis);
    assert.match(rd, /--maxmemory 192mb/i); assert.match(rd, /noeviction/);
    const ports = published(cfg.services.nginx);
    assert.deepEqual(ports, ['8080'], `网关模式 nginx 只发布 8080：${ports}`);
  } finally { s.done(); }
});

test('对照：测试环境的 compose 配置不变（1.6 GB 的服务器：合计 880 MB、堆 144、Postgres 48MB/20 连接、Redis 48mb、80/443），web、worker 也是 pull_policy: never', { skip: noCompose }, () => {
  const s = server();
  try {
    const r = s.run(['install', ...DOMAIN], STAGING);
    assert.equal(r.code, 0, r.out);
    const cfg = composeCfg(s);
    assert.deepEqual(svcMem(cfg), { postgres: 256, redis: 80, web: 256, worker: 256, nginx: 32 });
    assert.equal(Number((r.out.match(/容器上限合计 (\d+) MB/) || [])[1]), 880);
    for (const n of ['web', 'worker']) {
      assert.match(cfg.services[n].environment.NODE_OPTIONS, /--max-old-space-size=144\b/);
      assert.equal(cfg.services[n].pull_policy, 'never', `${n} pull_policy: never`);
    }
    const pg = cmdOf(cfg.services.postgres);
    assert.match(pg, /shared_buffers=48MB/); assert.match(pg, /effective_cache_size=128MB/); assert.match(pg, /max_connections=20\b/);
    assert.match(cmdOf(cfg.services.redis), /--maxmemory 48mb/i);
    assert.deepEqual(published(cfg.services.nginx).sort(), ['443', '80']);
  } finally { s.done(); }
});

test('生产内存检查按生产的上限：可用 2400 MB 不够 → 不启动；磁盘剩 11 GB 能部署、剩 3 GB 不能', () => {
  let s = server();
  try {
    const r = s.run(['install', ...PDOM], { ...PROD, TOPUP_DRILL_MEM_MB: '2400' });
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /内存不够：可用 2400 MB/);
    assert.equal(s.read('up'), '');
  } finally { s.done(); }
  s = server();
  try {
    const r = s.run(['install', ...PDOM], { ...PROD, TOPUP_DRILL_DISK_GB: '3' });
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /磁盘/);
    assert.equal(s.read('up'), '');
  } finally { s.done(); }
  s = server();
  try {
    const r = s.run(['install', ...PDOM], { ...PROD, TOPUP_DRILL_DISK_GB: '11' });
    assert.equal(r.code, 0, `16 GB 的盘剩 11 GB 要能部署：${r.out}`);
  } finally { s.done(); }
});

test('网关模式：不查 80/443（本机别的程序占着也照常部署）；内部端口被本机进程占着 → 拒绝并说出是谁', () => {
  let s = server({ demo: false });
  try {
    s.set('ss', 'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\nLISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("caddy",pid=812,fd=6))\nLISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("caddy",pid=812,fd=7))\n');
    const r = s.run(['install', ...PDOM], PROD);
    assert.equal(r.code, 0, r.out);
  } finally { s.done(); }
  s = server({ demo: false });
  try {
    s.set('ss', 'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\nLISTEN 0 5 0.0.0.0:8080 0.0.0.0:* users:(("python3",pid=901,fd=3))\n');
    const r = s.run(['install', ...PDOM], PROD);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /8080/); assert.match(r.out, /python3/);
    assert.equal(s.read('up'), '');
  } finally { s.done(); }
});

test('不是网关模式：80/443 被本机进程（不是容器）占着 → 拒绝并说出是谁；TopUP 自己的 docker-proxy 不算', () => {
  const s = server({ demo: false });
  try {
    s.set('ss', 'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\nLISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("caddy",pid=812,fd=7))\n');
    let r = s.run(['install', ...DOMAIN], STAGING);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /caddy/); assert.equal(s.read('up'), '');
    s.clear('ss');
    r = s.run(['install', ...DOMAIN], STAGING);
    assert.equal(r.code, 0, r.out);
    // 再运行一次：80/443 是 TopUP 自己的 nginx（docker-proxy）占着，不算
    s.set('ss', 'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\nLISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("docker-proxy",pid=1201,fd=7))\nLISTEN 0 4096 0.0.0.0:443 0.0.0.0:* users:(("docker-proxy",pid=1215,fd=7))\n');
    const ps = s.read('ps').replace(/^topup-nginx-1 .*$/m, 'topup-nginx-1 topup nginx:1.27-alpine 0.0.0.0:80->80/tcp,;0.0.0.0:443->443/tcp');
    s.set('ps', ps);
    r = s.run(['install', ...DOMAIN], STAGING);
    assert.equal(r.code, 0, r.out);
  } finally { s.done(); }
});

// ---------- 四、自动更新、清理旧镜像、异地备份的目录 ----------

test('生产自动更新：跟着 :production（不看 :staging）；清理旧镜像不删 :production', () => {
  const s = server({ demo: false });
  try {
    assert.equal(s.run(['install', ...PDOM], PROD).code, 0);
    s.set('docker.log', '');
    s.set('rev', V2 + '\n');
    const shas = ['3', '4', '5', '6', '7', '8'].map((c) => c.repeat(40));
    s.set('tags', ['production', V2, V1, ...shas].join('\n') + '\n');
    const r = s.run(['update'], PROD);
    assert.equal(r.code, 0, r.out + s.read('docker.log'));
    const dl = s.read('docker.log');
    assert.match(dl, new RegExp(`${IMG}:production\\b`));
    assert.doesNotMatch(dl, /:staging\b/, `生产的自动更新不看 :staging：\n${dl}`);
    assert.equal(s.read('up').trim().split('\n').pop(), V2, '换到 :production 指向的新版本');
    assert.doesNotMatch(dl, new RegExp(`image rm ${IMG}:production\\b`), '清理时不删 :production');
    assert.match(dl, /image rm /, '前提：确实清理了旧镜像');
  } finally { s.done(); }
});

test('生产异地备份上传到 topup-production/，不是 topup-staging/；topup.sh 里没有写死的 topup-staging/', () => {
  assert.ok(!/topup-staging\//.test(readFileSync(KIT, 'utf8')), 'R2 的目录跟着环境走：topup.sh 里不写死 topup-staging/');
  const s = server({ demo: false });
  try {
    assert.equal(s.run(['install', ...PDOM], PROD).code, 0);
    const d = join(s.dir, 'deploy.env');
    let text = readFileSync(d, 'utf8');
    for (const [k, v] of [['BACKUP_OFFSITE', 'r2'], ['R2_ACCOUNT_ID', 'acct'], ['R2_BUCKET', 'bkt'], ['R2_ACCESS_KEY_ID', 'id'], ['R2_SECRET_ACCESS_KEY', 'sk'], ['BACKUP_AGE_RECIPIENT', 'age1adminfake']]) {
      text = text.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`);
      if (!new RegExp(`^${k}=`, 'm').test(text)) text += `${k}=${v}\n`;
    }
    writeFileSync(d, text);
    const r = s.run(['backup'], PROD);
    assert.equal(r.code, 0, r.out);
    const rc = s.read('rclone.log');
    assert.match(rc, /copyto .*r2:bkt\/topup-production\//, `上传到 topup-production/：${rc}`);
    assert.doesNotMatch(rc, /topup-staging/);
  } finally { s.done(); }
});

// ---------- 五、第 1 步（不是演练模式）：Debian 13、已有 Docker、下载 :production ----------

test('第 1 步：Debian 13（trixie）照常支持；已经有 Docker 不重装、不改 Docker 设置、不重启 Docker；第 2 步下载的是 :production', () => {
  const daemon = '/etc/docker/daemon.json';
  const hadDaemon = existsSync(daemon);
  const s = server({ demo: false });
  try {
    s.set('pull-fail', '1'); // 第 2 步下载失败就停：只看第 1、2 步
    const { TOPUP_DRILL, TOPUP_DRILL_MEM_MB, TOPUP_DRILL_DISK_GB, ...env } = PROD;
    const r = s.run(['install', ...PDOM], env);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /^✓ 第 1 步/m, `第 1 步通过：${r.out}`);
    assert.ok(!r.out.split('\n').some((l) => /提醒/.test(l) && /Debian|trixie/.test(l)), `Debian 13 不当成不支持的系统：${r.out}`);
    assert.doesNotMatch(s.read('apt-get.log'), /docker/, `已有 Docker：不装 docker 相关的包：${s.read('apt-get.log')}`);
    assert.doesNotMatch(s.read('systemctl.log'), /restart docker/, '不重启 Docker');
    assert.ok(hadDaemon || !existsSync(daemon), '已有 Docker：不写 /etc/docker/daemon.json');
    assert.match(s.read('docker.log'), new RegExp(`^pull .*${IMG}:production\\b`, 'm'), '下载 :production');
    assert.doesNotMatch(s.read('docker.log'), /:staging\b/);
  } finally {
    if (!hadDaemon && existsSync(daemon)) rmSync(daemon, { force: true });
    s.done();
  }
});
