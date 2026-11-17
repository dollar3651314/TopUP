#!/usr/bin/env bash
# TopUP 服务器上的部署命令（测试环境和生产共用）。说明见 deploy/README.md。
# 第一次：管理员在服务器终端里粘贴一条命令（下载本文件并运行 install）：
#   测试环境：TOPUP_IMAGE=… bash topup.sh install <域名> <证书提醒邮箱>
#   生产（平台网关模式，TLS 由平台做）：TOPUP_IMAGE=… TOPUP_ENV=production TOPUP_GATEWAY=platform TOPUP_HTTP_PORT=8080 bash topup.sh install <平台发布的主机名>
#   环境写进 deploy.env 以后就固定了：测试环境装过的机器不能直接改成生产，反过来也一样。镜像标签跟着环境：staging / production。
# 之后用 sudo topup <子命令>：
#   sudo topup status            版本、容器、健康检查、内存、磁盘、备份、证书（不显示任何密钥）
#   sudo topup keys              哪些变量已填、哪些没填（只显示名字）
#   sudo topup set-key 变量名     填一个密钥（粘贴时屏幕上不显示），写进 .env 并自动生效
#   sudo topup set 变量名 值      填一个不是密钥的设置（例如收件人邮箱），自动生效
#   sudo topup gen-operator      测试环境：在服务器上生成两个归集发起账户（ETH/BSC 一个、TRON 一个），只显示地址
#   sudo topup admin-token       显示一次运营后台的初始化口令（第一次进后台用，初始化后作废）
#   sudo topup admin-reset --confirm   管理员密码 / 验证器丢了：删掉后台的管理员账号、换新的初始化口令（不显示），之后 admin-token 看新口令、重新初始化
#   sudo topup gen-test-admin    测试环境：生成测试管理员的令牌（给 GitHub 上的自动验收用例用），服务器只存它的哈希，令牌只在屏幕上显示一次
#   sudo topup test-admin-off    关掉测试管理员（删掉令牌的哈希，旧令牌立刻作废）
#   sudo topup set TEST_MERCHANT_IP_BYPASS 商户编号   测试环境：这个测试商户调开放 API 提币、批量打款时不查 IP 白名单（给自动验收用例用）
#   sudo topup test-merchant-ip-off   关掉上面这一项（删掉 TEST_MERCHANT_IP_BYPASS）
#   sudo topup test-mail         发一封测试邮件到 MAIL_TO
#   sudo topup backup            立刻备份一次（每天的定时备份也是它）：本机加密保存，默认不传到别处
#   sudo topup restore-drill     恢复演练：把本机最近一份备份解密、恢复进临时容器并核对，不碰正在运行的数据
#   sudo topup restore [备份文件名] --confirm   把本机的备份恢复进正在运行的系统（先自动备份一次现在的；生产还要加 --production）；恢复后 worker 暂停
#   sudo topup start-worker --confirm   恢复备份后：核对完备份时间之后链上已发生的打款、归集，再启动 worker
#   sudo topup backup-key        （异地备份用，默认用不到）生成管理员的备份密钥对：公钥写进 deploy.env，私钥只在屏幕上显示一次
#                                异地备份默认关闭；生产要开时 set BACKUP_OFFSITE r2 并填 R2_…，restore-drill --from-r2 从 R2 下载演练
#   sudo topup rollback          换回上一个版本，并且不再自动更新到当前这个版本
#   sudo topup retry             清掉"不再重试"的记录，下一分钟重新尝试最新版本
#   sudo topup set TOPUP_REAL_IP_FROM 地址段 / set TOPUP_REAL_IP_HEADER X-Forwarded-For   平台网关模式：实测网关后打开真实 IP（默认关）
#   sudo topup stop / start      停下 TopUP（停定时器 → 停应用 → 备份 → 停数据库，数据保留）/ 重新启动
# 定时器调用（不用手动运行）：update（每分钟看有没有新版本）、watch（每 5 分钟检查一次，状态变化时发邮件）、backup（每天）。
# 规矩：每步一行 ✓ / ✗；失败时写原因和下一步，然后停下；中途不问 y/n；可以重复运行；摘要和日志里不出现任何密钥的值。
set -uo pipefail

TOPUP_DIR=${TOPUP_DIR:-/opt/topup}
KIT="$TOPUP_DIR/deploy"
LE_DIR=${LE_DIR:-/etc/letsencrypt}
WEBROOT_DIR=${WEBROOT_DIR:-/var/www/certbot}
CERT_NAME=topup
# 别的项目的部署目录（/opt/<名字>/；演练时指到临时目录）
OTHERS_ROOT=${TOPUP_OTHERS_ROOT:-/opt}
# 演练模式（只在开发机上用，服务器上不要设）：不装软件、不碰 systemd、证书用自签名、镜像只用本机已有的
DRILL=${TOPUP_DRILL:-}
# 环境（staging / production）：install 时从这里来（默认 staging），之后一律以 deploy.env 为准；两边不一致就拒绝（不能换环境）
ENV_ARG=${TOPUP_ENV:-}
GW_ARG=${TOPUP_GATEWAY:-}
PORT_ARG=${TOPUP_HTTP_PORT:-}
# 系统信息文件（测试时可以换）
OS_RELEASE=${TOPUP_OS_RELEASE:-/etc/os-release}
# 容器内存上限按环境放在 deploy/profiles/<环境>.env（compose 也读同一个文件）；合计由 limits_mb 算
# 容器之外 Docker 还要的（MB）：每个容器一个 containerd-shim、每个对外端口一个 docker-proxy（开发机实测 RSS 合计约 77 MB，见 README 第 3 节）
# 启动前要求可用内存 ≥ 上限之和 + 这个数
RESERVE_MB=100
# 备份后清旧的；restore 先做的那次备份不清（要恢复的那一份可能正好是该清的）
BACKUP_PRUNE=1
HEALTH=http://127.0.0.1:18080/api/health/
# 备份：本机保留 7 天、至少 3 份；本机备份合计超过 TOPUP_BACKUP_MAX_MB（按环境，deploy/profiles/；环境变量可以临时改）时从最旧的删起（至少留 3 份）
# 本机备份的加密密钥（服务器自己生成，只在本机，600）
BACKUP_IDENTITY_REL=state/backup-identity
# 可以用 set-key 填的密钥（屏幕上不显示）；R2_ 开头的写进 deploy.env，其余写进 .env
SECRET_KEYS="RESEND_API_KEY SMTP_PASS TRONGRID_API_KEY ETH_RPC_URL BSC_RPC_URL TRON_NODE_URL SWEEP_OPERATOR_KEY SWEEP_OPERATOR_KEY_TRON TRONSAVE_API_KEY R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY"
# 可以用 set 填的普通设置（不是密钥，会显示）
# TEST_MERCHANT_IP_BYPASS 只能在测试环境设（check_value 挡）；关掉用 test-merchant-ip-off
# TOPUP_REAL_IP_HEADER、TOPUP_REAL_IP_FROM 只在平台网关模式用（真实 IP，写进 deploy.env）
PLAIN_KEYS="MAIL_FROM MAIL_TO SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USER ETH_CONFIRMATIONS BSC_CONFIRMATIONS TRON_CONFIRMATIONS TRON_NODE_QPS TRONSAVE_MAX_PRICE_SUN TRON_RENT_MAX_ENERGY USDT_CONTRACT BACKUP_OFFSITE R2_ACCOUNT_ID R2_BUCKET TEST_MERCHANT_IP_BYPASS TOPUP_REAL_IP_HEADER TOPUP_REAL_IP_FROM"
# 由部署决定的变量（compose.yml 的 environment 或镜像），不写进 .env
MANAGED_KEYS="APP_ENV PUBLIC_URL HOST PORT TRUST_PROXY GIT_COMMIT DATABASE_URL REDIS_URL BLOB_DIR"
DEPLOY_KEYS=" BACKUP_OFFSITE R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_ACCOUNT_ID R2_BUCKET BACKUP_AGE_RECIPIENT TOPUP_REAL_IP_HEADER TOPUP_REAL_IP_FROM "
# 生产不能有的测试环境变量（应用看到也会拒绝启动）
TEST_ONLY_KEYS="TEST_ADMIN_TOKEN_SHA256 TEST_MERCHANT_IP_BYPASS"

LOG=/dev/null
say() { echo "$*" | tee -a "$LOG"; }
detail() { echo "    $*" | tee -a "$LOG"; }
ok() { say "✓ $*"; }
die() {
  say "✗ $1"
  [ -z "${2:-}" ] || say "    下一步：$2"
  say "    详细日志：$LOG（截图发给运维前先遮住任何密钥）"
  exit 1
}
start_log() {
  local ts
  mkdir -p "$TOPUP_DIR/logs"
  ts=$(date -u +%Y%m%d-%H%M%S)
  # 文件名每次都不同（时间 + 随机后缀）：同一秒里跑两次也不会互相覆盖、互相删掉；mktemp 建的文件就是 600
  LOG=$(mktemp "$TOPUP_DIR/logs/$1-$ts-XXXXXX.log") || { LOG=/dev/null; echo "✗ 建不了日志文件（$TOPUP_DIR/logs）"; exit 1; }
  chmod 600 "$LOG"
  # 日志只留 30 天
  find "$TOPUP_DIR/logs" -name '*.log' -mtime +30 -delete 2> /dev/null || true
}
# 只追加到日志，不显示（自动运行的子命令用）
note() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }

envval() { sed -n "s/^$1=//p" "${2:-$TOPUP_DIR/.env}" 2> /dev/null | tail -1; }
dval() { envval "$1" "$TOPUP_DIR/deploy.env"; }
cur_tag() { sed -n 's/^IMAGE_TAG=//p' "$TOPUP_DIR/state/image.env" 2> /dev/null || true; }

# 环境：deploy.env 里的为准；还没有 deploy.env（第一次 install）时用 TOPUP_ENV，默认 staging。镜像标签和环境同名（staging / production）
topup_env() { local e; e=$(dval TOPUP_ENV); echo "${e:-${ENV_ARG:-staging}}"; }
track() { topup_env; }
gateway() { [ "$(dval TOPUP_GATEWAY)" = platform ]; }
# 按环境的参数（deploy/profiles/<环境>.env）；第二个参数是没有这个文件或这一项时的默认值
profile_file() { echo "$KIT/profiles/$(topup_env).env"; }
pval() { local v; v=$(envval "$1" "$(profile_file)"); echo "${v:-$2}"; }
# 所有容器内存上限之和（MB）：和 compose 实际生效的一样（同一个文件、同样的默认值 = 测试环境）
limits_mb() {
  local k d v sum=0
  for k in POSTGRES:256m REDIS:80m WEB:256m WORKER:256m NGINX:32m; do
    d=${k#*:}; v=$(pval "TOPUP_MEM_${k%%:*}" "$d")
    case "$v" in *[gG]) v=$(( ${v%[gG]} * 1024 )) ;; *[mM]) v=${v%[mM]} ;; *) v=${d%m} ;; esac
    sum=$((sum + v))
  done
  echo "$sum"
}
# 对外端口：平台网关模式只有 TOPUP_HTTP_PORT，否则 80、443
public_ports() { if gateway; then dval TOPUP_HTTP_PORT; else echo "80 443"; fi; }

# deploy.env 说了算：环境变量里的 TOPUP_ENV / TOPUP_GATEWAY / TOPUP_HTTP_PORT 不传给 compose（已经核对过和 deploy.env 一致）
compose() {
  local files=(-f "$KIT/compose.yml") envs=(--env-file "$TOPUP_DIR/deploy.env")
  gateway && files+=(-f "$KIT/compose.gateway.yml")
  [ ! -f "$(profile_file)" ] || envs+=(--env-file "$(profile_file)")
  env -u TOPUP_ENV -u TOPUP_GATEWAY -u TOPUP_HTTP_PORT \
    docker compose --project-name topup --project-directory "$TOPUP_DIR" "${files[@]}" "${envs[@]}" --env-file "$TOPUP_DIR/state/image.env" "$@"
}


# 把文件里 KEY 的值换成环境变量 VAL 的值（值不出现在命令行参数里）；没有这一行就加在最后；保持权限 600
env_write() {
  local key=$1 file=$2 tmp
  tmp=$(mktemp "$file.XXXXXX")
  chmod 600 "$tmp"
  KEY="$key" awk 'BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VAL"] }
    index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }' "$file" > "$tmp" && mv "$tmp" "$file"
  chmod 600 "$file"
}
rand() { openssl rand -hex "$1"; }

pull() {
  [ -n "$DRILL" ] && return 0
  docker pull -q "$1" > /dev/null 2>> "$LOG"
}
revision() { docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$1" 2> /dev/null || true; }

health_json() { curl -s --max-time 5 "$HEALTH" 2> /dev/null || true; }
# 应用活着：提交号对得上、数据库、Redis、主密钥都配好，web 的收付款初始化成功，worker 5 分钟内跑过。
# db / storage / secret 只说明"变量填了"；web 初始化失败（连不上库、建表出错）时它们照样是 true，
# 这时健康检查里没有 wallet 这一项（server/web.js：初始化成功才有），所以还要看 wallet 在不在。
# 第二个参数（目标版本）：web 的提交号（.commit）要等于它；worker 的心跳里带着 worker 自己的提交号（.worker.commit），也要等于它——
#   只有 web 换了、worker 还是旧的（或新 worker 根本没起来、旧 worker 的心跳还新鲜）不算新版本活着。
#   过渡：目标版本早于"心跳带提交号"（它的健康检查里 worker 一项根本没有 commit 这个字段）时，只能退回旧规则（只看第三个参数）。
#   判断依据是目标版本自己的 web 返回的内容（.commit 已经等于目标版本，web 和 worker 是同一个镜像），不是别的版本留下的心跳；
#   新版本的 web 一定有这个字段（没有心跳或心跳里没有提交号时是 null），所以只有换回老版本时才会走旧规则。
# 第三个参数（秒）：worker 最近一次扫链要在这么多秒以内——刚换版本时旧 worker 留下的扫链时间不算新版本的 worker 活着。
# 邮件、节点 Key 没配不算失败（那是要填的设置，换回旧版本也解决不了），在 status 和 watch 里显示
app_alive() {
  local body=$1 want=${2:-} within=${3:-}
  [ -n "$body" ] || return 1
  if [ -n "$want" ]; then
    [ "$(jq -r '.commit // empty' <<< "$body" 2> /dev/null)" = "${want:0:7}" ] || return 1
    if jq -e '(.worker | type) == "object" and (.worker | has("commit"))' <<< "$body" > /dev/null 2>&1; then
      [ "$(jq -r '.worker.commit // empty' <<< "$body" 2> /dev/null)" = "${want:0:7}" ] || return 1
    fi
  fi
  [ -z "$within" ] || jq -e --argjson s "$within" '.worker.age_s != null and .worker.age_s <= $s' <<< "$body" > /dev/null 2>&1 || return 1
  jq -e '.db == true and .storage == true and .secret == true and .worker.ok == true
    and (.wallet | type) == "object" and .wallet.error == null' <<< "$body" > /dev/null 2>&1
}
# worker 暂停（state/worker-hold，restore 之后）：恢复出来的打款、归集可能回到"已审核 / 待签名"，而链上其实已经付过，
# 核对完（sudo topup start-worker --confirm）之前不启动 worker；web 照常。暂停时"活着"只看 web
HOLD_REL=state/worker-hold
worker_held() { [ -f "$TOPUP_DIR/$HOLD_REL" ]; }
web_alive() {
  local body=$1 want=${2:-}
  [ -n "$body" ] || return 1
  [ -z "$want" ] || [ "$(jq -r '.commit // empty' <<< "$body" 2> /dev/null)" = "${want:0:7}" ] || return 1
  jq -e '.db == true and .storage == true and .secret == true and (.wallet | type) == "object" and .wallet.error == null' <<< "$body" > /dev/null 2>&1
}
# 只查一次的"活着"（不等）：worker 暂停时只看 web，和 wait_alive 一样
alive_now() { if worker_held; then web_alive "$1" "${2:-}"; else app_alive "$@"; fi; }
# 启动 / 重建全部容器；worker 暂停时不建 worker（--scale worker=0）
compose_up() { if worker_held; then compose up -d --remove-orphans --scale worker=0 "$@"; else compose up -d --remove-orphans "$@"; fi; }
wait_alive() {
  local want=$1 body start=$SECONDS end=$((SECONDS + ${TOPUP_WAIT_S:-180}))
  while [ "$SECONDS" -lt "$end" ]; do
    body=$(health_json)
    if worker_held; then web_alive "$body" "$want" && return 0; sleep 2; continue; fi
    # 换版本（或重建容器）之后新 worker 跑过一轮才算：心跳里的提交号 = 目标版本，扫链时间要晚于开始等的时候（多留 5 秒误差）
    app_alive "$body" "$want" $((SECONDS - start + 5)) && return 0
    sleep 2
  done
  note "3 分钟内没有通过健康检查。最后一次返回：$body"
  return 1
}

mem_avail_mb() { awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo; }

# ---------- 别的项目（只认 <名字>-deploy.timer 并且它的服务指向 /opt/<名字>/ 的，不碰系统自带的单元）----------
other_projects() {
  local t name exec
  for t in $(systemctl list-unit-files --type=timer --no-legend 2> /dev/null | awk '{print $1}' | grep -E '^[a-z0-9-]+-deploy\.timer$' | sort -u); do
    name=${t%-deploy.timer}
    [ "$name" = topup ] && continue
    exec=$(systemctl show -p ExecStart --value "$name-deploy.service" 2> /dev/null || true)
    case "$exec" in *"$OTHERS_ROOT/$name/"*) echo "$name" ;; esac
  done
}
project_running() { [ -n "$(docker ps -q --filter "label=com.docker.compose.project=$1" 2> /dev/null)" ]; }

# 停另一个项目（小内存服务器轮流用的顺序）：停它的定时器 → 等进行中的自动部署 → 停应用容器 → 它自己的备份 → 停数据库等其余容器。数据都保留
stop_other() {
  local p=$1 t c app=() rest=()
  for t in "$p-deploy.timer" "$p-backup.timer"; do systemctl disable --now "$t" >> "$LOG" 2>&1 || true; done
  for _ in $(seq 1 60); do systemctl is-active --quiet "$p-deploy.service" || break; sleep 5; done
  for c in $(docker ps --format '{{.Names}}' --filter "label=com.docker.compose.project=$p"); do
    case "$(docker inspect --format '{{.Config.Image}}' "$c")" in
      *mysql* | *postgres* | *redis* | *mariadb*) rest+=("$c") ;;
      *) app+=("$c") ;;
    esac
  done
  [ "${#app[@]}" = 0 ] || docker stop "${app[@]}" >> "$LOG" 2>&1 || return 1
  if [ -f "$OTHERS_ROOT/$p/backup.sh" ]; then
    if ! bash "$OTHERS_ROOT/$p/backup.sh" before-topup >> "$LOG" 2>&1; then
      note "$p 的备份失败，按原样恢复它"
      docker start "${app[@]}" >> "$LOG" 2>&1 || true
      for t in "$p-deploy.timer" "$p-backup.timer"; do systemctl enable --now "$t" >> "$LOG" 2>&1 || true; done
      return 2
    fi
  fi
  [ "${#rest[@]}" = 0 ] || docker stop "${rest[@]}" >> "$LOG" 2>&1 || return 1
  return 0
}

# 端口被谁占着（每个占用一行："端口 谁"）：别的容器发布了这个端口（TopUP 自己的 topup-* 不算），
# 或者本机进程在监听（ss -ltnp；Docker 端口转发的 docker-proxy 不算——那是容器的端口，上面按容器名已经查过）
port_holders() {
  local p
  for p in "$@"; do
    docker ps --format '{{.Names}} {{.Ports}}' 2> /dev/null | grep -v '^topup-' | grep -E "[: ]$p->" | awk -v p="$p" '{print p " 容器" $1}'
    command -v ss > /dev/null || continue
    ss -ltnp 2> /dev/null | awk -v p="$p" '$1 == "LISTEN" && $4 ~ (":" p "$") {
      n = "未知程序"; if (match($0, /users:\(\("[^"]+"/)) n = substr($0, RSTART + 9, RLENGTH - 10)
      if (n != "docker-proxy") print p " 本机程序" n }'
  done | sort -u
}
# 检查对外端口；被占着就停下并说出是谁（第一个参数是提示前缀）
check_ports() {
  local busy ports
  ports=$(public_ports)
  busy=$(port_holders $ports)
  [ -z "$busy" ] || die "${1}端口 $(echo "$ports" | sed 's/ / \/ /g') 被占着：$(echo "$busy" | tr '\n' ';' | sed 's/;$//; s/;/；/g')" \
    "先停掉占着端口的程序，再运行同一条命令；$(gateway && echo '或者换一个端口（平台上发布的端口要跟着换）' || echo '截图发运维')"
}

# 生产从不停别的项目：只列出在运行的名字（提醒）；测试环境照旧轮流用（停掉别的项目）
others_running() { local p; for p in $(other_projects); do project_running "$p" && printf '%s ' "$p"; done; }

# 环境和 .env 对不上的原因（空 = 没问题）：生产必须连主网、不能有测试环境专用的变量；测试环境必须连 Nile。只说变量名，不说值
# .env 每一行只能是"变量名=值"（或注释、空行）。docker compose 还认 "export X=…"、"X = …"、行首空格这些写法，
# 而这里的 envval 只认最简单的写法：两边读法不一样就可能放过实际是 nile 或带着测试变量的配置，所以这类行直接拒绝（只报行号）
env_bad_lines() {
  [ -f "$TOPUP_DIR/.env" ] || return 0
  awk '/^[[:space:]]*(#|$)/ { next } !/^[A-Za-z_][A-Za-z0-9_]*=/ { printf "%s%d", (n++ ? "、" : ""), NR }' "$TOPUP_DIR/.env"
}
env_refusal() {
  local net k bad
  bad=$(env_bad_lines)
  [ -z "$bad" ] || { echo ".env 第 ${bad} 行写法不对（只能是 变量名=值：不要 export、等号两边不要空格、行首不要空格）"; return; }
  net=$(envval TRON_NETWORK)
  if [ "$(topup_env)" = production ]; then
    [ "$net" = mainnet ] || { echo "生产必须连 TRON 主网：.env 里 TRON_NETWORK 要是 mainnet（现在是 ${net:-空的}）"; return; }
    for k in $TEST_ONLY_KEYS; do
      [ -z "$(envval "$k")" ] || { echo "生产的 .env 里不能有 $k（测试环境专用；应用也会拒绝启动）"; return; }
    done
  else
    [ "$net" = nile ] || echo "测试环境只能连 TRON 测试网：.env 里 TRON_NETWORK 要是 nile（现在是 ${net:-空的}）"
  fi
}
refusal_next() {
  case "$1" in
    *TEST_ADMIN_TOKEN_SHA256*) echo "sudo topup test-admin-off 删掉它，再运行同一条命令" ;;
    *TEST_MERCHANT_IP_BYPASS*) echo "sudo topup test-merchant-ip-off 删掉它，再运行同一条命令" ;;
    *写法不对*) echo "把那几行改成 变量名=值 的写法（sudo nano $TOPUP_DIR/.env），再运行同一条命令" ;;
    *) echo "截图发运维（不要自己改环境：测试环境和生产要分开两台机器）" ;;
  esac
}
# 会重建 web、worker 之前都要过这一关（install、start、update、自动换回、rollback、set / set-key 之后的生效）
env_guard() {
  local why; why=$(env_refusal)
  [ -z "$why" ] || die "${why}；${1:-TopUP 没有动}" "$(refusal_next "$why")"
}

# TOPUP_REAL_IP_FROM 的一段：IPv4（前缀 16～32）或 IPv6（前缀 48～128），不写前缀 = 单个地址；
# 不能和 Docker 默认地址池 172.17.0.0～172.31.255.255 重叠（端口转发经过 docker-proxy 时 Nginx 看到的来源在这里面，信任它等于信任所有人带的请求头）
ipv4_int() {
  local IFS=. o n=0 parts
  read -ra parts <<< "$1"
  [ "${#parts[@]}" = 4 ] || return 1
  for o in "${parts[@]}"; do
    [[ $o =~ ^[0-9]{1,3}$ ]] && [ $((10#$o)) -le 255 ] || return 1
    n=$(( n * 256 + 10#$o ))
  done
  echo "$n"
}
ipv6_ok() {
  local a=$1 left right g n=0 groups=()
  [[ $a =~ ^[0-9A-Fa-f:]+$ ]] || return 1
  if [[ $a == *::* ]]; then
    left=${a%%::*}; right=${a#*::}
    [[ $right != *::* ]] || return 1
    [ -z "$left" ] || { IFS=: read -ra g <<< "$left"; groups+=("${g[@]}"); [[ $left != *: ]] || return 1; }
    [ -z "$right" ] || { IFS=: read -ra g <<< "$right"; groups+=("${g[@]}"); [[ $right != :* && $right != *: ]] || return 1; }
    [ "${#groups[@]}" -le 7 ] || return 1
  else
    IFS=: read -ra groups <<< "$a"
    [ "${#groups[@]}" = 8 ] && [[ $a != *: ]] || return 1
  fi
  for g in "${groups[@]}"; do [[ $g =~ ^[0-9A-Fa-f]{1,4}$ ]] || return 1; done
}
realip_from_ok() {
  local v=$1 item addr pfx n start end lo hi
  case "$v" in '' | ,* | *, | *,,*) return 1 ;; esac
  lo=$(ipv4_int 172.17.0.0); hi=$(ipv4_int 172.31.255.255)
  for item in ${v//,/ }; do
    addr=${item%%/*}; pfx=
    [[ $item == */* ]] && { pfx=${item#*/}; [[ $pfx =~ ^[0-9]{1,3}$ ]] || return 1; pfx=$((10#$pfx)); }
    if n=$(ipv4_int "$addr"); then
      pfx=${pfx:-32}; [ "$pfx" -ge 16 ] && [ "$pfx" -le 32 ] || return 1
      start=$(( n & ~((1 << (32 - pfx)) - 1) )); end=$(( start + (1 << (32 - pfx)) - 1 ))
      [ "$end" -lt "$lo" ] || [ "$start" -gt "$hi" ] || return 1
    elif ipv6_ok "$addr"; then
      pfx=${pfx:-128}; [ "$pfx" -ge 48 ] && [ "$pfx" -le 128 ] || return 1
    else
      return 1
    fi
  done
}


# 平台网关模式的真实 IP（nginx-gateway/ 模板 include 这个文件）：deploy.env 的 TOPUP_REAL_IP_HEADER（off / X-Forwarded-For / X-Real-IP）
# 和 TOPUP_REAL_IP_FROM（逗号分隔的网关地址段）都填了才打开；默认关（不信任任何请求头）
realip_mode() {
  local h f
  h=$(dval TOPUP_REAL_IP_HEADER); f=$(dval TOPUP_REAL_IP_FROM)
  case "$h" in X-Forwarded-For | X-Real-IP) [ -n "$f" ] && { echo "$h"; return; } ;; esac
  echo off
}
write_realip() {
  local dir="$TOPUP_DIR/state/nginx" mode a
  mkdir -p "$dir"; chmod 755 "$dir"
  mode=$(realip_mode)
  {
    echo "# 由 deploy/kit/topup.sh 按 deploy.env 生成，不要手改（改用 sudo topup set TOPUP_REAL_IP_HEADER / TOPUP_REAL_IP_FROM）"
    if [ "$mode" = off ]; then
      echo "# 真实 IP：关（不信任任何请求头；应用看到的访客 IP 都是平台网关的地址）"
      echo "# 第一道限流：所有访客共用网关的地址，按 IP 的额度等于全站的额度，所以放宽成只防整站被打满（每秒 200 个、瞬间多 400 个、同时 512 个连接）"
      echo "limit_req_zone \$binary_remote_addr zone=topup_req:10m rate=200r/s;"
      echo "limit_conn_zone \$binary_remote_addr zone=topup_conn:10m;"
      echo "limit_req zone=topup_req burst=400 nodelay;"
      echo "limit_conn topup_conn 512;"
    else
      for a in $(dval TOPUP_REAL_IP_FROM | tr ',' ' '); do echo "set_real_ip_from $a;"; done
      echo "real_ip_header $mode;"
      echo "real_ip_recursive on;"
      echo "# 第一道限流（按访客的真实 IP，和测试环境一样）：每个 IP 每秒 20 个，瞬间最多多出 200 个；同时 100 个连接"
      echo "limit_req_zone \$binary_remote_addr zone=topup_req:10m rate=20r/s;"
      echo "limit_conn_zone \$binary_remote_addr zone=topup_conn:10m;"
      echo "limit_req zone=topup_req burst=200 nodelay;"
      echo "limit_conn topup_conn 100;"
    fi
  } > "$dir/realip.conf.new"
  chmod 644 "$dir/realip.conf.new"
  mv "$dir/realip.conf.new" "$dir/realip.conf"
}
# 改了真实 IP 的设置以后：写 realip.conf → 运行中的 Nginx 里 nginx -t → reload → 经 Nginx 的端口查健康检查。
# 任何一步不通过：deploy.env 的这一项、realip.conf 都换回原来的（再 reload 一次），退出码 1
apply_realip() {
  local key=$1 old=$2 conf="$TOPUP_DIR/state/nginx/realip.conf" bak port body i
  bak=$(mktemp); [ -f "$conf" ] && cp "$conf" "$bak"
  write_realip
  if [ -f "$TOPUP_DIR/state/stopped" ] || [ ! -s "$TOPUP_DIR/state/image.env" ]; then rm -f "$bak"; ok "TopUP 现在没有在运行，下次启动时生效"; return 0; fi
  realip_undo() {
    VAL="$old" env_write "$key" "$TOPUP_DIR/deploy.env"
    if [ -s "$bak" ]; then cp "$bak" "$conf"; chmod 644 "$conf"; else write_realip; fi
    rm -f "$bak"
    compose exec -T nginx nginx -s reload >> "$LOG" 2>&1 || true
    die "$1；已换回原来的 $key 和 Nginx 设置" "截图发运维（日志 $LOG）"
  }
  compose exec -T nginx nginx -t >> "$LOG" 2>&1 || realip_undo "Nginx 不接受新的设置（nginx -t 没通过）"
  compose exec -T nginx nginx -s reload >> "$LOG" 2>&1 || realip_undo "Nginx 重新加载设置失败"
  port=$(dval TOPUP_HTTP_PORT); body=""
  for i in 1 2 3 4 5; do
    body=$(curl -s --max-time 5 "http://127.0.0.1:$port/api/health/" 2> /dev/null || true)
    alive_now "$body" "$(cur_tag)" && break
    body=""; [ -n "$DRILL" ] || sleep 2
  done
  [ -n "$body" ] || realip_undo "改了以后经 Nginx 的端口 $port 健康检查没有通过"
  rm -f "$bak"
  ok "已生效。真实 IP：$(realip_mode)$( [ "$(realip_mode)" = off ] && echo '（关；两项都填了才开）')"
}



# ---------- 部署工具包 ----------
# 从镜像里取出 /topup-kit（compose.yml、nginx、kit）放到 $TOPUP_DIR/kit；.env、deploy.env、data、state、backup 不动
sync_kit() {
  local image=$1 tmp
  tmp=$(mktemp -d)
  docker run --rm --user 0:0 --network none --entrypoint sh -v "$tmp:/out" "$image" -c 'cp -r /topup-kit/. /out/' >> "$LOG" 2>&1 || { rm -rf "$tmp"; return 1; }
  mkdir -p "$KIT.new"
  rm -rf "$KIT.new"/*
  cp -r "$tmp"/. "$KIT.new"/
  rm -rf "$tmp" "$KIT.old"
  [ -d "$KIT" ] && mv "$KIT" "$KIT.old"
  mv "$KIT.new" "$KIT"
  rm -rf "$KIT.old"
  chmod 755 "$KIT"/kit/*.sh
  [ -n "$DRILL" ] || ln -sf "$KIT/kit/topup.sh" /usr/local/bin/topup
}

switch_to() {
  printf 'IMAGE_TAG=%s\n' "$1" > "$TOPUP_DIR/state/image.env.new"
  mv "$TOPUP_DIR/state/image.env.new" "$TOPUP_DIR/state/image.env"
  ! gateway || write_realip
  compose_up >> "$LOG" 2>&1
}

# 本机只留最近几个版本的镜像：正在用的、上一个，再加 TOPUP_KEEP_IMAGES 个（测试环境 3、生产 1，deploy/profiles/）；
# 环境标签（staging、production）不删——它和某个提交号是同一个镜像，删标签也省不了空间
prune_images() {
  local image cur prev n=0 tag keep
  image=$(dval TOPUP_IMAGE); cur=$(cur_tag); prev=$(cat "$TOPUP_DIR/state/previous" 2> /dev/null || true)
  keep=$(pval TOPUP_KEEP_IMAGES 5)
  for tag in $(docker image ls "$image" --format '{{.Tag}}'); do
    case "$tag" in staging | production | '<none>') continue ;; esac
    [ "$tag" != "$cur" ] && [ "$tag" != "$prev" ] || continue
    n=$((n + 1))
    [ "$n" -gt "$keep" ] && docker image rm "$image:$tag" > /dev/null 2>&1 || true
  done
  docker image prune -f > /dev/null 2>&1 || true
}


# ---------- 发邮件（用应用自己的发信设置：.env 的 MAIL_FROM、MAIL_TO、Resend 或 SMTP；测试环境标题自动带"[测试环境]"）----------
send_mail() {
  local subject=$1 text=$2 out
  [ -s "$TOPUP_DIR/state/image.env" ] || return 1
  out=$(ALERT_SUBJECT="$subject" ALERT_TEXT="$text" compose run --rm --no-deps -T -e ALERT_SUBJECT -e ALERT_TEXT web node --input-type=module -e '
const { loadConfig } = await import("/app/server/config.js");
const { createRawSender } = await import("/app/server/mailer.js");
const c = loadConfig();
if (!c.mailTo || !c.mailFrom || !(c.resendApiKey || c.smtp.host)) { console.log("mail_not_configured"); process.exit(3); }
await createRawSender(c)({ to: c.mailTo, subject: process.env.ALERT_SUBJECT, text: process.env.ALERT_TEXT });
console.log("sent");' 2>> "$LOG")
  note "发邮件「$subject」：${out:-失败}"
  [ "$out" = sent ]
}

# ---------- install：第一次部署（一条命令）----------
cmd_install() {
  local domain=${1:-} email=${2:-} image=${TOPUP_IMAGE:-} f pub resolved others p tag new env gw port had name track
  start_log install
  env=${ENV_ARG:-staging}; gw=$GW_ARG; port=$PORT_ARG
  case "$env" in staging) name=测试环境 ;; production) name=生产 ;; *) die "TOPUP_ENV 只能是 staging 或 production（现在是 $env）" ;; esac
  say "TopUP ${name}第一次部署（$(date '+%F %T %Z')）"
  # 环境写进 deploy.env 以后就固定了：测试环境装过的机器不能直接改成生产（反过来也一样），什么都不改
  had=$(dval TOPUP_ENV)
  [ -z "$had" ] || [ "$had" = "$env" ] || die "这台机器已经按 ${had} 部署过，不能直接改成 ${env}（什么都没有改）" \
    "测试环境和生产要分开两台机器；确实要重装，截图发运维（要先备份、清空 $TOPUP_DIR，数据会丢）"
  case "$gw" in '' | platform) ;; *) die "TOPUP_GATEWAY 只能是 platform（平台网关模式）或者不写" ;; esac
  if [ -n "$had" ] && [ "$(dval TOPUP_GATEWAY)" != "$gw" ]; then
    die "这台机器部署时的网关模式是「$(dval TOPUP_GATEWAY || true)」，这次是「${gw}」，不能直接改（什么都没有改）" "用第一次部署的那条命令；要改截图发运维"
  fi
  if [ -n "$gw" ]; then
    port=${port:-8080}
    printf '%s' "$port" | grep -Eq '^[1-9][0-9]{0,4}$' && [ "$port" -le 65535 ] || die "TOPUP_HTTP_PORT 要是端口号（例如 8080）"
    [ "$port" != 18080 ] || die "18080 是部署脚本看健康检查用的端口，TOPUP_HTTP_PORT 换一个（例如 8080）"
    [ -z "$had" ] || [ "$(dval TOPUP_HTTP_PORT)" = "$port" ] || die "这台机器部署时的端口是 $(dval TOPUP_HTTP_PORT)，这次是 ${port}（什么都没有改）" "用第一次部署的那条命令"
    [ -n "$domain" ] || die "要写平台发布的主机名：install <主机名>（例如 ${port}-xxxx.<平台域名>，不要 https:// 和斜杠）"
  else
    [ -n "$domain" ] && [ -n "$email" ] || die "要写域名和证书提醒邮箱：sudo topup install <域名> <邮箱>"
  fi
  printf '%s' "$domain" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' \
    || die "域名写法不对（只写域名，不要 https:// 和斜杠）"
  [ -n "$image" ] || image=$(dval TOPUP_IMAGE)
  [ -n "$image" ] || die "不知道镜像在哪里（TOPUP_IMAGE）" "用部署方案里给的那条完整命令"
  track=$env

  # 第 1 步：软件。机器上已经有 Docker 时不重装、不改 Docker 的设置、不重启 Docker（会把机器上别的容器一起重启）
  if [ -n "$DRILL" ]; then
    ok "第 1 步：软件——演练模式，跳过"
  else
    local os_id os_ver os_name
    os_id=$(sed -n 's/^ID=//p' "$OS_RELEASE" 2> /dev/null | tr -d '"')
    os_ver=$(sed -n 's/^VERSION_ID=//p' "$OS_RELEASE" 2> /dev/null | tr -d '"')
    os_name=$(sed -n 's/^PRETTY_NAME=//p' "$OS_RELEASE" 2> /dev/null | tr -d '"')
    case "$os_id $os_ver" in
      "ubuntu 24.04" | "debian 13") ;;
      *) detail "提醒：本脚本按 Ubuntu 24.04、Debian 13 编写，这台是 ${os_name:-未知}" ;;
    esac
    local need=() fresh_docker=""
    if ! command -v docker > /dev/null; then
      need+=(docker.io)
      # Ubuntu 的 compose 插件包叫 docker-compose-v2，Debian 13 叫 docker-compose
      [ "$os_id" = debian ] && need+=(docker-compose) || need+=(docker-compose-v2)
      fresh_docker=1
    fi
    # rclone 只有打开异地备份时才要（backup 会提示安装），默认不装；平台网关模式不要 certbot
    for p in age jq curl openssl; do command -v "$p" > /dev/null || need+=("$p"); done
    [ -n "$gw" ] || command -v certbot > /dev/null || need+=(certbot)
    if [ "${#need[@]}" -gt 0 ]; then
      say "  … 第 1 步：安装 ${need[*]}（约 1～3 分钟）"
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -q >> "$LOG" 2>&1 && apt-get install -y -q "${need[@]}" >> "$LOG" 2>&1 || die "第 1 步：安装软件失败" "等 1 分钟再粘贴同一条命令；还不行就截图"
    fi
    docker compose version > /dev/null 2>&1 || die "第 1 步：没有 docker compose" "截图发运维"
    # 只有这次刚装的 Docker 才写日志大小的设置并重启（那时机器上还没有别的容器）
    if [ -n "$fresh_docker" ] && [ ! -f /etc/docker/daemon.json ]; then
      echo '{ "log-driver": "json-file", "log-opts": { "max-size": "50m", "max-file": "3" } }' > /etc/docker/daemon.json
      systemctl restart docker >> "$LOG" 2>&1
    fi
    ok "第 1 步：软件（Docker $(docker --version | awk '{print $3}' | tr -d ,)${fresh_docker:+，这次新装}$([ -n "$gw" ] || echo '、certbot')、age、jq）"
  fi

  # 第 2 步：取部署工具包（镜像 <环境> 标签里的 /topup-kit）
  mkdir -p "$TOPUP_DIR"/{state,logs,backup,data/postgres,data/redis,data/blobs}
  chmod 700 "$TOPUP_DIR/state" "$TOPUP_DIR/backup"
  # web、worker 在镜像里用 node（uid 1000）运行，开户文件目录要能写
  chown 1000:1000 "$TOPUP_DIR/data/blobs"
  pull "$image:$track" || die "第 2 步：下载镜像 :$track 失败" "确认镜像已经公开（或已登录镜像仓库）$([ "$track" = production ] && echo '、并且已经有一次合并到 main 经管理员批准推出了 :production')，再粘贴同一条命令"
  sync_kit "$image:$track" || die "第 2 步：从镜像取部署工具包失败" "截图发运维"
  ok "第 2 步：部署工具包（$KIT，镜像标签 :$track${DRILL:+；演练模式}）"

  # 第 3 步：两个配置文件。已有的值不覆盖；内部口令随机生成、不显示
  for f in .env deploy.env; do [ -f "$TOPUP_DIR/$f" ] || { : > "$TOPUP_DIR/$f"; }; chmod 600 "$TOPUP_DIR/$f"; done
  while IFS= read -r line; do
    case "$line" in '#'* | '') continue ;; esac
    f=${line%%=*}
    # 这几项由部署决定（compose.yml 的 environment），不放进 .env；GIT_COMMIT 空着会盖掉镜像里的提交号
    case " $MANAGED_KEYS " in *" $f "*) continue ;; esac
    # 测试环境专用的变量不放进生产的 .env（空行也不放，免得以为能填）
    [ "$env" = production ] && case " $TEST_ONLY_KEYS " in *" $f "*) continue ;; esac
    grep -q "^$f=" "$TOPUP_DIR/.env" || echo "$f=" >> "$TOPUP_DIR/.env"
  done < "$KIT/kit/app.env.example"
  set_default() { [ -n "$(envval "$1" "$3")" ] || VAL="$2" env_write "$1" "$3"; }
  set_default TOPUP_DIR "$TOPUP_DIR" "$TOPUP_DIR/deploy.env"
  set_default TOPUP_IMAGE "$image" "$TOPUP_DIR/deploy.env"
  set_default TOPUP_ENV "$env" "$TOPUP_DIR/deploy.env"
  set_default DOMAIN "$domain" "$TOPUP_DIR/deploy.env"
  if [ -n "$gw" ]; then
    set_default TOPUP_GATEWAY "$gw" "$TOPUP_DIR/deploy.env"
    set_default TOPUP_HTTP_PORT "$port" "$TOPUP_DIR/deploy.env"
    # 真实 IP 默认关：实测平台网关带的是哪个请求头、从哪些地址来之后再开（deploy/README.md 第 7 节）
    set_default TOPUP_REAL_IP_HEADER off "$TOPUP_DIR/deploy.env"
    grep -q '^TOPUP_REAL_IP_FROM=' "$TOPUP_DIR/deploy.env" || echo "TOPUP_REAL_IP_FROM=" >> "$TOPUP_DIR/deploy.env"
  else
    set_default CERT_EMAIL "$email" "$TOPUP_DIR/deploy.env"
    set_default CERT_NAME "$CERT_NAME" "$TOPUP_DIR/deploy.env"
    set_default LE_DIR "$LE_DIR" "$TOPUP_DIR/deploy.env"
    set_default WEBROOT_DIR "$WEBROOT_DIR" "$TOPUP_DIR/deploy.env"
  fi
  set_default POSTGRES_PASSWORD "$(rand 24)" "$TOPUP_DIR/deploy.env"
  set_default REDIS_PASSWORD "$(rand 24)" "$TOPUP_DIR/deploy.env"
  set_default BACKUP_OFFSITE off "$TOPUP_DIR/deploy.env"
  for k in R2_ACCOUNT_ID R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY BACKUP_AGE_RECIPIENT; do grep -q "^$k=" "$TOPUP_DIR/deploy.env" || echo "$k=" >> "$TOPUP_DIR/deploy.env"; done
  backup_identity > /dev/null || die "第 3 步：生成本机备份的加密密钥失败" "截图发运维"
  set_default TRON_NETWORK "$([ "$env" = production ] && echo mainnet || echo nile)" "$TOPUP_DIR/.env"
  # 主密钥：派生全部加密、签名密钥，换了以后旧数据解不开。只生成一次，不显示（加密备份里有它）
  set_default APP_SECRET "$(rand 32)" "$TOPUP_DIR/.env"
  set_default ADMIN_SETUP_TOKEN "$(rand 16)" "$TOPUP_DIR/.env"
  [ "$(dval DOMAIN)" = "$domain" ] || die "第 3 步：这台服务器已经配过别的域名 $(dval DOMAIN)" "要换域名先截图发运维"
  [ "$(dval TOPUP_ENV)" = "$env" ] || die "第 3 步：deploy.env 里 TOPUP_ENV 不是 $env" "截图发运维"
  local why; why=$(env_refusal)
  [ -z "$why" ] || die "第 3 步：$why；TopUP 没有启动" "$(refusal_next "$why")"
  ok "第 3 步：配置文件（${name}，TRON_NETWORK=$(envval TRON_NETWORK)；内部口令、主密钥已随机生成，不显示；已有的值没有动）"

  # 第 4 步：别的项目。测试环境同一时间只运行一个项目（停掉别的）；生产从不停别的项目，只报出名字
  others=$(other_projects)
  if [ "$env" = production ]; then
    local running; running=$(others_running)
    if [ -n "$running" ]; then ok "第 4 步：这台机器上还有别的项目在运行：${running% }（生产不停别的项目，只提醒；第 5 步按实际剩下的内存检查）"
    else ok "第 4 步：没有别的项目在运行"; fi
  else
    for p in $others; do
      if project_running "$p"; then
        say "  … 第 4 步：停 $p（停定时器 → 停应用 → 它自己的备份 → 停数据库，数据都保留，约 1～2 分钟）"
        stop_other "$p"
        case $? in
          0) ok "第 4 步：已停 $p（要换回去：先 sudo topup stop，再按 $p 自己的方法启动）" ;;
          2) die "第 4 步：$p 的备份失败，已把 $p 恢复运行，TopUP 没有启动" "截图发运维" ;;
          *) die "第 4 步：停 $p 失败" "截图发运维" ;;
        esac
      fi
    done
    [ -z "$others" ] && ok "第 4 步：没有别的项目在这台服务器上"
  fi
  check_ports "第 4 步："

  # 第 5 步：内存和磁盘（容器上限之和 + 余量要低于可用内存）
  local avail free_gb limits
  limits=$(limits_mb)
  avail=$(avail_for_topup)
  [ "$avail" -ge $((limits + RESERVE_MB)) ] || die "第 5 步：内存不够：可用 ${avail} MB，TopUP 需要 $((limits + RESERVE_MB)) MB" "截图（含 free -m）发运维；可能要先停别的程序，或者加一台服务器（部署方案第 7 节）"
  free_gb=$(df -BG --output=avail "$TOPUP_DIR" | tail -1 | tr -dc 0-9)
  [ -n "${TOPUP_DRILL_DISK_GB:-}" ] && free_gb=$TOPUP_DRILL_DISK_GB
  [ "$free_gb" -ge 5 ] || die "第 5 步：磁盘只剩 ${free_gb} GB（至少要 5 GB）" "截图发运维"
  ok "第 5 步：内存可用 ${avail} MB（容器上限合计 ${limits} MB）、磁盘剩 ${free_gb} GB"

  # 第 6 步：证书（平台网关模式由平台做 TLS，这里不申请、不生成）
  if [ -n "$gw" ]; then
    ok "第 6 步：HTTPS 证书——平台网关负责（这台机器只开普通 HTTP 端口 $port，不申请证书）"
  elif [ -f "$LE_DIR/live/$CERT_NAME/fullchain.pem" ]; then
    ok "第 6 步：HTTPS 证书——已有，跳过"
  elif [ -n "$DRILL" ]; then
    mkdir -p "$LE_DIR/live/$CERT_NAME" "$WEBROOT_DIR"
    openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj "/CN=$domain" -addext "subjectAltName=DNS:$domain" \
      -keyout "$LE_DIR/live/$CERT_NAME/privkey.pem" -out "$LE_DIR/live/$CERT_NAME/fullchain.pem" >> "$LOG" 2>&1
    ok "第 6 步：HTTPS 证书——演练模式，自签名"
  else
    pub=$(curl -s -4 --max-time 5 https://api.ipify.org 2> /dev/null | grep -E '^[0-9.]+$' || true)
    resolved=$(getent ahostsv4 "$domain" 2> /dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' | sed 's/ $//')
    [ -n "$resolved" ] || die "第 6 步：$domain 查不到 IP" "在域名的 DNS 里加一条 A 记录指向这台服务器${pub:+（$pub）}，选'仅 DNS'（不开代理），等 1～5 分钟再粘贴同一条命令"
    [ -z "$pub" ] || [ "$resolved" = "$pub" ] || die "第 6 步：$domain 指向 $resolved，不是这台服务器（$pub）" "改 DNS 记录，并确认是'仅 DNS'（不开代理），再粘贴同一条命令"
    mkdir -p "$WEBROOT_DIR"
    certbot certonly --standalone -n --agree-tos -m "$email" --cert-name "$CERT_NAME" -d "$domain" >> "$LOG" 2>&1 \
      || die "第 6 步：证书申请失败（多半是云防火墙没开 80，或 DNS 刚改还没生效）" "确认控制台防火墙开了 80、443，等几分钟再粘贴同一条命令"
    ok "第 6 步：HTTPS 证书（Let's Encrypt，$domain）"
  fi

  # 第 7 步：启动 <环境> 标签指向的版本
  tag=$(cur_tag)
  new=$(revision "$image:$track")
  [ -n "$new" ] || die "第 7 步：镜像里没有版本号" "截图发运维"
  if [ "$tag" = "$new" ] && app_alive "$(health_json)" "$new"; then
    ok "第 7 步：启动——版本 ${new:0:7} 已经在运行，跳过"
  else
    say "  … 第 7 步：启动版本 ${new:0:7}（第一次要初始化数据库，约 1～3 分钟）"
    docker tag "$image:$track" "$image:$new" >> "$LOG" 2>&1
    switch_to "$new" || die "第 7 步：docker compose 启动失败" "截图发运维（日志 $LOG）"
    wait_alive "$new" || die "第 7 步：3 分钟内健康检查没有通过" "sudo topup status 截图发运维"
    ok "第 7 步：已启动版本 ${new:0:7}，健康检查通过"
  fi

  # 第 8 步：证书改为经 Nginx 续期（平台网关模式没有证书）；打开定时器
  if [ -z "$DRILL" ]; then
    if [ -z "$gw" ]; then
      certbot reconfigure -n --cert-name "$CERT_NAME" --webroot -w "$WEBROOT_DIR" \
        --deploy-hook "docker exec topup-nginx-1 nginx -s reload" >> "$LOG" 2>&1 || detail "提醒：证书续期方式没有改成功（不影响现在使用），截图发运维"
    fi
    cp "$KIT"/kit/systemd/topup-*.service "$KIT"/kit/systemd/topup-*.timer /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable --now topup-update.timer topup-backup.timer topup-watch.timer >> "$LOG" 2>&1 || die "第 8 步：打开定时器失败" "截图发运维"
    ok "第 8 步：自动更新（每分钟看 :$track）、每天备份、每 5 分钟检查已打开$([ -n "$gw" ] || echo '；证书自动续期')"
  else
    ok "第 8 步：定时器——演练模式，跳过"
  fi

  summary
}

# 给 TopUP 用的可用内存（MB）：TopUP 已经在运行时，把它自己正在用的也算进去（重复运行 install 不会因为自己占着而失败）
avail_for_topup() {
  local avail
  if project_running topup; then avail=$(( $(mem_avail_mb) + $(docker stats --no-stream --format '{{.MemUsage}}' $(docker ps -q --filter label=com.docker.compose.project=topup) 2> /dev/null | awk '{v=$1; if (v ~ /GiB/) {sub(/GiB/,"",v); s+=v*1024} else if (v ~ /MiB/) {sub(/MiB/,"",v); s+=v} else if (v ~ /KiB/) {sub(/KiB/,"",v); s+=v/1024}} END {print int(s)}') ))
  else avail=$(mem_avail_mb); fi
  [ -n "${TOPUP_DRILL_MEM_MB:-}" ] && avail=$TOPUP_DRILL_MEM_MB
  echo "$avail"
}

summary() {
  local body env
  env=$(topup_env)
  body=$(health_json)
  say ""
  say "======== 摘要（不含任何密钥，可以直接截图）========"
  say "地址：https://$(dval DOMAIN)/"
  say "版本：$(cur_tag | cut -c1-7)    环境：$(jq -r '.env // "?"' <<< "$body" 2> /dev/null)    镜像标签：:$(track)"
  say "健康检查：$(jq -c '{ok, db, storage, secret, blob, mail, mailMode, pay, worker}' <<< "$body" 2> /dev/null || echo 没有响应)"
  say "还没填的（只列名字）：$(missing_list)"
  say "默认关着的功能："
  say "  · 邮件：填好 MAIL_FROM、MAIL_TO 和 RESEND_API_KEY（或 SMTP）之前不发任何邮件，告警也发不出"
  if [ "$env" = production ]; then
    say "  · 收付款：config/wallets.json 的 production 一节合约地址全空，ETH、BSC、TRON 三条链都没开通（健康检查 not_enabled）——先搭起来，不算上线"
    say "  · 异地备份：关（备份只加密保存在这台机器上；整台机器丢了备份也跟着丢）"
    if gateway; then
      say "  · 真实 IP：$( [ "$(realip_mode)" = off ] && echo '关——应用看到的访客 IP 都是平台网关的地址：按 IP 限流大家共用一个额度，商户 IP 白名单在生产上未验证、不能用；实测网关后再开（deploy/README.md 第 7 节）' || echo "开（$(realip_mode)，只认 $(dval TOPUP_REAL_IP_FROM) 来的）")"
    fi
  else
    say "  · ETH、BSC：ETH_RPC_URL / BSC_RPC_URL 没填、合约地址没进 config/wallets.json 之前不开通"
    say "  · TRON 合约钱包：config/wallets.json 的 staging.tron 没填之前不开通；归集要 SWEEP_OPERATOR_KEY_TRON"
    say "  · 异地备份：测试环境不开（D6），备份只加密保存在这台服务器上；整台服务器丢了备份也跟着丢"
  fi
  say "下一步：按部署方案的清单用 sudo topup set-key 变量名 填密钥；sudo topup status 随时看状态。"
}

missing_list() {
  local k miss=""
  for k in MAIL_FROM MAIL_TO TRONGRID_API_KEY; do [ -n "$(envval "$k")" ] || miss="$miss $k"; done
  [ -n "$(envval RESEND_API_KEY)$(envval SMTP_HOST)" ] || miss="$miss RESEND_API_KEY(或SMTP)"
  for k in ETH_RPC_URL BSC_RPC_URL SWEEP_OPERATOR_KEY SWEEP_OPERATOR_KEY_TRON; do [ -n "$(envval "$k")" ] || miss="$miss $k"; done
  if offsite_on; then for k in R2_ACCOUNT_ID R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY BACKUP_AGE_RECIPIENT; do [ -n "$(dval "$k")" ] || miss="$miss $k"; done; fi
  echo "${miss:- 没有}"
}

# ---------- update：自动更新（定时器每分钟）----------
cmd_update() {
  start_log update
  exec 9> "$TOPUP_DIR/state/update.lock"
  flock -n 9 || exit 0
  local image new cur track why
  image=$(dval TOPUP_IMAGE); track=$(track)
  [ -f "$TOPUP_DIR/state/stopped" ] && { rm -f "$LOG"; exit 0; }
  # 恢复备份后 worker 暂停、等人核对：这期间不换版本
  worker_held && { rm -f "$LOG"; exit 0; }
  # 跟着本环境的标签（测试环境 :staging、生产 :production），不看别的环境
  pull "$image:$track" || { note "下载 $track 镜像失败"; exit 1; }
  new=$(revision "$image:$track"); cur=$(cur_tag)
  [ -n "$new" ] || { note "$track 镜像没有版本号"; exit 1; }
  # 没有新版本、或者这个版本失败过（state/skip）：什么都不做，也不留日志
  if [ "$new" = "$cur" ] || [ "$new" = "$(cat "$TOPUP_DIR/state/skip" 2> /dev/null)" ]; then rm -f "$LOG"; exit 0; fi
  note "发现新版本 $new（当前 ${cur:-无}）"
  # .env 和环境对不上（生产里有测试变量、TRON 网络不对）：新旧版本都起不来，不换版本，等人处理（watch 会发邮件）
  why=$(env_refusal)
  [ -z "$why" ] || { note "不更新：$why"; exit 1; }
  docker tag "$image:$track" "$image:$new" >> "$LOG" 2>&1
  sync_kit "$image:$new" || { note "取部署工具包失败"; exit 1; }
  [ -z "$cur" ] || bash "$KIT/kit/topup.sh" backup "before-${new:0:7}" >> "$LOG" 2>&1 || note "更新前备份失败（继续更新）"
  switch_to "$new"
  if wait_alive "$new"; then
    [ -n "$cur" ] && echo "$cur" > "$TOPUP_DIR/state/previous"
    note "更新成功：$new"
    prune_images
    exit 0
  fi
  note "更新失败：$new。web 最后 50 行日志："
  compose logs --no-color --tail 50 web worker >> "$LOG" 2>&1 || true
  echo "$new" > "$TOPUP_DIR/state/skip"
  if [ -n "$cur" ] && [ -n "$(env_refusal)" ]; then
    note "没有自动换回：$(env_refusal)"
  elif [ -n "$cur" ]; then
    sync_kit "$image:$cur" >> "$LOG" 2>&1 || true
    switch_to "$cur"
    if wait_alive "$cur"; then note "已自动换回 $cur"; else note "换回 $cur 后仍然没有通过健康检查，需要人工处理"; fi
  fi
  send_mail "TopUP 自动更新失败，已换回上一个版本" "新版本 ${new:0:7} 在 3 分钟内没有通过健康检查，已换回 ${cur:0:7}，并且不再自动重试这个版本。
修好后合并一个新提交会自动更新；要重试这个版本：sudo topup retry。
服务器日志：$LOG" || true
  exit 1
}

cmd_retry() {
  start_log retry
  if [ -f "$TOPUP_DIR/state/skip" ]; then
    ok "已清掉不再重试的版本 $(cut -c1-7 "$TOPUP_DIR/state/skip")，下一分钟自动更新会重新尝试"
    rm -f "$TOPUP_DIR/state/skip"
  else
    ok "没有被跳过的版本，什么都不用做"
  fi
}

cmd_rollback() {
  start_log rollback
  local cur prev
  cur=$(cur_tag); prev=$(cat "$TOPUP_DIR/state/previous" 2> /dev/null || true)
  [ -n "$prev" ] || die "没有上一个版本可以换回" "截图发运维"
  [ "$prev" != "$cur" ] || die "上一个版本就是现在这个" "截图发运维"
  env_guard "没有换回（.env 不对时哪个版本都起不来）"
  say "  … 换回 ${prev:0:7}（当前 ${cur:0:7}，换回后不再自动更新到 ${cur:0:7}）"
  echo "$cur" > "$TOPUP_DIR/state/skip"
  sync_kit "$(dval TOPUP_IMAGE):$prev" || die "取上一个版本的部署工具包失败" "截图发运维"
  switch_to "$prev"
  wait_alive "$prev" || die "换回后 3 分钟内健康检查没有通过" "sudo topup status 截图发运维"
  echo "$cur" > "$TOPUP_DIR/state/previous"
  ok "已换回 ${prev:0:7}。修好后合并新提交会自动更新；要重新用 ${cur:0:7}：sudo topup retry"
}

# ---------- backup ----------
# 本机备份的加密密钥：第一次用时由服务器生成（age），只存在 state/ 里（600），输出公钥
backup_identity() {
  local f="$TOPUP_DIR/$BACKUP_IDENTITY_REL"
  if [ ! -s "$f" ]; then
    ( umask 077; age-keygen -o "$f.new" 2> /dev/null ) && mv "$f.new" "$f" || { rm -f "$f.new"; return 1; }
  fi
  chmod 600 "$f"
  age-keygen -y "$f" 2> /dev/null
}
# 异地备份默认关；只有 BACKUP_OFFSITE=r2 才用 R2
offsite_on() { [ "$(dval BACKUP_OFFSITE)" = r2 ]; }

cmd_backup() {
  local label=${1:-daily} ts dir out pub recip offsite=off n=1
  start_log backup
  case "$label" in '' | *[!A-Za-z0-9._-]*) die "备份标签只能用字母、数字、点、横线、下划线" "例如：sudo topup backup manual" ;; esac
  exec 8> "$TOPUP_DIR/state/backup.lock"
  flock -w 600 8 || die "上一次备份还没结束"
  pub=$(backup_identity) && [ -n "$pub" ] || die "备份：本机加密密钥不可用" "截图发运维"
  ts=$(date -u +%Y%m%d-%H%M%S)
  dir=$(mktemp -d "$TOPUP_DIR/backup/.work-XXXXXX")
  chmod 700 "$dir"
  compose exec -T postgres pg_dump -U topup -d topup -Fc > "$dir/postgres.dump" 2>> "$LOG" || { rm -rf "$dir"; die "备份：导出数据库失败" "sudo topup status 截图发运维"; }
  compose exec -T redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning --rdb /data/backup.rdb > /dev/null' >> "$LOG" 2>&1 \
    && mv "$TOPUP_DIR/data/redis/backup.rdb" "$dir/redis.rdb" || { rm -rf "$dir"; die "备份：导出 Redis 失败" "sudo topup status 截图发运维"; }
  tar -C "$TOPUP_DIR/data" -cf "$dir/blobs.tar" blobs 2>> "$LOG" || { rm -rf "$dir"; die "备份：打包开户文件失败"; }
  # 两个配置文件也进备份（D7）：主密钥 APP_SECRET 丢了，开户资料就解不开了
  cp "$TOPUP_DIR/.env" "$dir/app.env"; cp "$TOPUP_DIR/deploy.env" "$dir/deploy.env"
  echo "{\"at\":\"$ts\",\"label\":\"$label\",\"version\":\"$(cur_tag)\"}" > "$dir/meta.json"
  # 加密：收件人 = 本机密钥；管理员生成过备份公钥（backup-key）的话也加上，他的私钥也能解
  recip=(-r "$pub"); [ -z "$(dval BACKUP_AGE_RECIPIENT)" ] || recip+=(-r "$(dval BACKUP_AGE_RECIPIENT)")
  # 文件名每次都不同：同一秒里已经有同名的（两次备份在同一秒里做完）就加序号；在备份锁里，不会有两个同时在挑名字
  out="$TOPUP_DIR/backup/topup-$ts-$label.tar.age"
  while [ -e "$out" ] || [ -e "$out.part" ]; do n=$((n + 1)); out="$TOPUP_DIR/backup/topup-$ts-$n-$label.tar.age"; done
  # 明文不落盘成一个整包：直接打包进 age
  if ! ( umask 077; tar -C "$dir" -cf - . | age "${recip[@]}" -o "$out.part" ) 2>> "$LOG"; then
    rm -rf "$dir" "$out.part"; die "备份：加密失败" "截图发运维"
  fi
  mv "$out.part" "$out"; chmod 600 "$out"
  rm -rf "$dir"
  ok "备份：本机已加密 $(basename "$out")（$(du -h "$out" | cut -f1)）"
  [ "$BACKUP_PRUNE" = 0 ] || backup_prune
  # 异地（R2）：默认关闭；打开了但没配好只提示、不算失败
  if offsite_on; then
    if [ -z "$(dval BACKUP_AGE_RECIPIENT)" ] || [ -z "$(dval R2_ACCOUNT_ID)" ] || [ -z "$(dval R2_BUCKET)" ] || [ -z "$(dval R2_ACCESS_KEY_ID)" ] || [ -z "$(dval R2_SECRET_ACCESS_KEY)" ]; then
      detail "异地备份打开了但没配好（R2_… 或备份公钥没填），这次只在本机"; offsite=not_configured
    elif ! command -v rclone > /dev/null; then
      detail "异地备份要 rclone：sudo apt-get install -y rclone，这次只在本机"; offsite=not_configured
    elif r2 copyto "$out" "r2:$(dval R2_BUCKET)/topup-$(topup_env)/$(basename "$out")" >> "$LOG" 2>&1; then
      ok "备份：已上传到 R2（只有密文）"; offsite=ok
    else
      offsite=failed
    fi
  else
    detail "异地备份：关（只在本机）"
  fi
  echo "{\"at\":\"$ts\",\"local\":\"encrypted\",\"r2\":\"$offsite\"}" > "$TOPUP_DIR/state/last-backup.json"
  [ "$offsite" != failed ] || die "备份：上传 R2 失败（本机那份已经做好）" "sudo topup status 截图发运维"
}

# 本机保留：7 天以上的删掉；合计超过 BACKUP_MAX_MB 时从最旧的删起；无论如何至少留最新 3 份
backup_prune() {
  local f total n=0 max
  max=${TOPUP_BACKUP_MAX_MB:-$(pval TOPUP_BACKUP_MAX_MB 2048)}
  total=$(du -ck "$TOPUP_DIR"/backup/topup-*.tar.age 2> /dev/null | tail -1 | cut -f1)
  while read -r f; do
    [ -n "$f" ] || continue
    n=$((n + 1)); [ "$n" -gt 3 ] || continue
    if [ -n "$(find "$f" -mtime +7)" ] || [ "${total:-0}" -gt $((max * 1024)) ]; then
      total=$(( total - $(du -k "$f" | cut -f1) )); rm -f "$f"
    fi
  done <<< "$(ls -1t "$TOPUP_DIR"/backup/topup-*.tar.age 2> /dev/null)"
  # 以前版本留下的明文备份（.tar）一并删掉
  rm -f "$TOPUP_DIR"/backup/topup-*.tar
}

# R2（S3 兼容）：配置只经环境变量交给 rclone，不写文件、不出现在命令行参数里
r2() {
  RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true \
  RCLONE_CONFIG_R2_ACCESS_KEY_ID="$(dval R2_ACCESS_KEY_ID)" RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$(dval R2_SECRET_ACCESS_KEY)" \
  RCLONE_CONFIG_R2_ENDPOINT="https://$(dval R2_ACCOUNT_ID).r2.cloudflarestorage.com" \
    rclone --config /dev/null "$@"
}

cmd_backup_key() {
  start_log backup-key
  [ -z "$(dval BACKUP_AGE_RECIPIENT)" ] || { ok "已经有备份公钥了，没有重新生成（要换请找运维）"; return 0; }
  [ -r /dev/tty ] || die "这里不能显示私钥（没有终端）" "在云控制台的'远程连接'终端里运行"
  local tmp pubkey
  tmp=$(mktemp -p /dev/shm 2> /dev/null || mktemp); chmod 600 "$tmp"
  age-keygen -o "$tmp" 2> /dev/null || { rm -f "$tmp"; die "生成密钥失败"; }
  pubkey=$(sed -n 's/^# public key: //p' "$tmp")
  VAL="$pubkey" env_write BACKUP_AGE_RECIPIENT "$TOPUP_DIR/deploy.env"
  {
    echo "下面这一行是备份私钥，只显示这一次，服务器上不保存。现在就把它存进你的密码管理器（不要截图、不要发给任何人或对话框）："
    echo
    grep '^AGE-SECRET-KEY-' "$tmp"
    echo
    echo "存好后按回车，屏幕会清掉。"
  } > /dev/tty
  shred -u "$tmp" 2> /dev/null || rm -f "$tmp"
  read -r _ < /dev/tty || true
  clear > /dev/tty 2> /dev/null || printf '\033c' > /dev/tty
  ok "备份公钥已写进 deploy.env（私钥没有保存在服务器上）"
}

# ---------- restore-drill：恢复演练（临时容器，不碰正在运行的数据）----------
cmd_restore_drill() {
  start_log restore-drill
  local src=${1:-} tar tmp key pg rd live restored ok_all=1 files
  tmp=$(mktemp -d "$TOPUP_DIR/backup/.drill-XXXXXX"); chmod 700 "$tmp"
  # 退出时删临时容器和临时目录（里面有解密出来的明文）；$tmp 在这里展开，函数返回后局部变量就没了
  # shellcheck disable=SC2064
  trap "docker rm -f topup-drill-pg topup-drill-redis > /dev/null 2>&1; rm -rf '$tmp'" EXIT
  if [ "$src" = "--from-r2" ]; then
    local name
    name=$(r2 lsf "r2:$(dval R2_BUCKET)/topup-$(topup_env)/" 2>> "$LOG" | sort | tail -1)
    [ -n "$name" ] || die "R2 里没有找到备份" "先 sudo topup backup，确认上传成功"
    r2 copyto "r2:$(dval R2_BUCKET)/topup-$(topup_env)/$name" "$tmp/b.tar.age" >> "$LOG" 2>&1 || die "从 R2 下载失败"
    [ -r /dev/tty ] || die "这里不能输入（没有终端）" "在云控制台的'远程连接'终端里运行"
    echo "请粘贴备份私钥（AGE-SECRET-KEY- 开头那一行），然后按回车（屏幕上不显示）：" > /dev/tty
    key=$(mktemp -p /dev/shm 2> /dev/null || mktemp); chmod 600 "$key"
    IFS= read -r -s line < /dev/tty; echo > /dev/tty
    printf '%s\n' "$line" > "$key"; unset line
    age -d -i "$key" -o "$tmp/b.tar" "$tmp/b.tar.age" 2>> "$LOG"; local rc=$?
    shred -u "$key" 2> /dev/null || rm -f "$key"
    [ $rc = 0 ] || die "解密失败（私钥不对？）"
    tar="$tmp/b.tar"; say "  用 R2 上的 $name"
  else
    local enc
    enc=$(ls -1t "$TOPUP_DIR"/backup/topup-*.tar.age 2> /dev/null | head -1)
    [ -n "$enc" ] || die "本机没有备份" "先 sudo topup backup"
    age -d -i "$TOPUP_DIR/$BACKUP_IDENTITY_REL" -o "$tmp/b.tar" "$enc" 2>> "$LOG" || die "本机备份解密失败（本机加密密钥不对或文件坏了）" "截图发运维"
    tar="$tmp/b.tar"; say "  用本机的 $(basename "$enc")（已解密到临时目录，用完删除）"
  fi
  tar -C "$tmp" -xf "$tar" || die "备份文件解不开"
  pg=$(compose config --images 2> /dev/null | grep -m1 postgres); [ -n "$pg" ] || pg=postgres:16
  rd=$(compose config --images 2> /dev/null | grep -m1 redis); [ -n "$rd" ] || rd=redis:7
  docker run -d --name topup-drill-pg --network none --memory 256m --memory-swap 256m -e POSTGRES_PASSWORD=drill -e POSTGRES_USER=topup -e POSTGRES_DB=topup "$pg" >> "$LOG" 2>&1 || die "起临时数据库失败"
  for _ in $(seq 1 60); do docker exec topup-drill-pg pg_isready -U topup -d topup > /dev/null 2>&1 && break; sleep 1; done
  sleep 2
  docker exec -i topup-drill-pg pg_restore -U topup -d topup --no-owner < "$tmp/postgres.dump" >> "$LOG" 2>&1 || { ok_all=0; say "✗ 数据库恢复有错误（看日志）"; }
  # 每张表的行数：恢复出来的 vs 正在运行的（备份之后有新数据时运行的会多，属于正常）
  local q="select string_agg(t || '=' || n, ' ' order by t) from (select table_name t, (xpath('/row/c/text()', query_to_xml(format('select count(*) c from %I', table_name), false, true, '')))[1]::text n from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE') x"
  restored=$(docker exec topup-drill-pg psql -U topup -d topup -Atc "$q" 2>> "$LOG")
  live=$(compose exec -T postgres psql -U topup -d topup -Atc "$q" 2>> "$LOG")
  [ -n "$restored" ] || { ok_all=0; say "✗ 恢复出来的数据库里没有表"; }
  if [ "$(tr ' ' '\n' <<< "$restored" | cut -d= -f1)" = "$(tr ' ' '\n' <<< "$live" | cut -d= -f1)" ]; then
    ok "数据库：恢复出 $(wc -w <<< "$restored") 张表，和正在运行的表一样"
  else
    ok_all=0; say "✗ 数据库：恢复出的表和正在运行的不一样"
  fi
  detail "行数（恢复 / 运行中）：$(paste -d' ' <(tr ' ' '\n' <<< "$restored") <(tr ' ' '\n' <<< "$live" | cut -d= -f2) | awk '{print $1 "/" $2}' | tr '\n' ' ')"
  mkdir -p "$tmp/rd" && cp "$tmp/redis.rdb" "$tmp/rd/dump.rdb"
  docker run -d --name topup-drill-redis --network none --memory 96m --memory-swap 96m -v "$tmp/rd:/data" "$rd" redis-server --appendonly no --dbfilename dump.rdb >> "$LOG" 2>&1 || true
  sleep 2
  if [ "$(docker exec topup-drill-redis redis-cli ping 2> /dev/null)" = PONG ]; then
    ok "Redis：恢复出 $(docker exec topup-drill-redis redis-cli dbsize) 个键"
  else
    ok_all=0; say "✗ Redis 的备份加载失败"
  fi
  files=$(tar -tf "$tmp/blobs.tar" 2> /dev/null | grep -vc '/$')
  ok "开户文件：$files 个"
  [ -n "$(sed -n 's/^APP_SECRET=//p' "$tmp/app.env")" ] && ok "主密钥：备份里有" || { ok_all=0; say "✗ 备份里没有主密钥"; }
  echo "{\"at\":\"$(date -u +%FT%TZ)\",\"ok\":$([ $ok_all = 1 ] && echo true || echo false),\"source\":\"${src:-local}\"}" > "$TOPUP_DIR/state/last-drill.json"
  [ $ok_all = 1 ] || die "恢复演练没有全部通过" "截图发运维"
  ok "恢复演练通过（临时容器已删除，正在运行的数据没有动）"
}

# ---------- restore：把本机的一份加密备份恢复进正在运行的系统（数据库、Redis、开户文件）----------
# 不写文件名用最新的一份；写了就用 backup/ 下的那一份。.env、deploy.env 不动（现在的口令、设置照旧），
# 所以备份里的主密钥 APP_SECRET 和现在的不一样时拒绝（恢复出来的开户资料、加密字段会解不开）。
# 顺序：查磁盘、解密核对（什么都不动）→ 先备份一次现在的（标签 pre-restore，解开核对一遍）→ 停 web、worker
#       → pg_restore --clean（一个事务，失败就什么都没变）→ Redis（备份里的数据作为 AOF 的基础文件放进 data/redis）→ 开户文件（data/blobs）
#       → 启动 web（worker 暂停，见 worker_held）→ 打印并发邮件"核对清单"，核对完 sudo topup start-worker --confirm
# 中途出错或被中断（Ctrl+C、终端断开）：restore_abort 按进行到哪一步收拾——数据库还没动就照常启动；数据库可能已经换了，
# 就把挪开的 Redis、开户文件放回去，worker 保持暂停，启动 web，并给出可以直接运行的命令（再恢复一次 / 回到恢复前）
RS_PHASE=none; RS_PID=""; RS_NAME=""; RS_PRE=""; RS_PROD=""; RS_HAD_HOLD=""
RS_RD_OLD=""; RS_BL_OLD=""
# 挪开的 Redis、开户文件目录放回原处（服务停着的时候做）
restore_put_back() {
  if [ -n "$RS_RD_OLD" ] && [ -d "$RS_RD_OLD" ]; then
    compose stop redis >> "$LOG" 2>&1 || true
    rm -rf "$TOPUP_DIR/data/redis" && mv "$RS_RD_OLD" "$TOPUP_DIR/data/redis" && note "Redis 的数据目录已放回恢复前的"
  fi
  if [ -n "$RS_BL_OLD" ] && [ -d "$RS_BL_OLD" ]; then
    rm -rf "$TOPUP_DIR/data/blobs" && mv "$RS_BL_OLD" "$TOPUP_DIR/data/blobs" && note "开户文件目录已放回恢复前的"
  fi
}
restore_abort() {
  local why=$1 again pre
  trap - INT HUP TERM
  again="sudo topup restore $RS_NAME --confirm${RS_PROD:+ --production}"
  pre="sudo topup restore ${RS_PRE:-<pre-restore 那份>} --confirm${RS_PROD:+ --production}"
  case "$RS_PHASE" in
    none | prep)
      die "$why；什么都没有改" "截图发运维" ;;
    stopped)
      # 数据库还没动：照常启动（原来暂停着的 worker 继续暂停）
      [ -n "$RS_HAD_HOLD" ] || rm -f "$TOPUP_DIR/$HOLD_REL"
      compose_up >> "$LOG" 2>&1 || true
      die "$why；数据没有动，已重新启动" "截图发运维；要再试：$again" ;;
  esac
  # 数据库可能已经换成备份里的了（导入中途被打断时一个事务会回滚，但也可能刚好已经提交）：
  # 先结束容器里可能还在跑的 pg_restore，再把 Redis、开户文件放回恢复前的，worker 保持暂停，启动 web
  if [ "$RS_PHASE" = db ]; then
    [ -z "$RS_PID" ] || kill "$RS_PID" 2> /dev/null || true
    compose exec -T postgres psql -U topup -d topup -Atc "select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'pg_restore' and pid <> pg_backend_pid()" >> "$LOG" 2>&1 || true
    [ -z "$RS_PID" ] || wait "$RS_PID" 2> /dev/null || true
  fi
  [ "$RS_PHASE" = start ] || restore_put_back
  touch "$TOPUP_DIR/$HOLD_REL"
  compose_up >> "$LOG" 2>&1 || true
  say "✗ $why"
  detail "现在的状态：数据库可能已经是备份时的样子$([ "$RS_PHASE" = start ] || echo '，Redis、开户文件是恢复前的')；worker 暂停着（不扫链、不打款、不归集），web 已尝试启动"
  detail "下一步（二选一，直接复制运行）："
  detail "  再恢复一次同一份：$again"
  detail "  回到恢复前的数据：$pre"
  detail "做完、按清单核对后再启动 worker：sudo topup start-worker --confirm"
  detail "详细日志：$LOG（截图发给运维前先遮住任何密钥）"
  exit 1
}
# 恢复之后的核对清单（屏幕、邮件、state/worker-hold 共用）
worker_checklist() {
  local at=$1
  cat << EOF
恢复用的备份做于 ${at}（UTC）。数据库回到了那个时候：之后在链上已经发生的打款、归集，系统里可能又变回"已审核 / 待签名 / 待归集"，再签名就会重复付款。
worker 已暂停（不扫链、不广播、不归集），运营后台照常能打开。启动 worker 之前请逐项核对：
1. 打款（提币、批量打款）：在区块浏览器查热钱包、打款合约在 ${at} 之后的转出，和后台"已审核 / 待签名 / 已凑批"的单逐笔对照；链上已经付过的不要再签名，截图发运维处理。
2. 归集：查归集发起账户、批量归集合约在 ${at} 之后的交易，和后台待归集的对照。
3. 充值：worker 启动后从备份时的扫链位置重新扫，之后到账的会补记；启动后核对余额。
核对完再运行：sudo topup start-worker --confirm
EOF
}
cmd_restore() {
  local a name="" confirm="" prod="" enc tmp who at need avail list
  start_log restore
  for a in "$@"; do
    case "$a" in
      --confirm) confirm=1 ;;
      --production) prod=1 ;;
      -*) die "不认识的参数：$a" "sudo topup restore [备份文件名] --confirm" ;;
      *) [ -z "$name" ] || die "只能写一个备份文件名" "sudo topup restore [备份文件名] --confirm"; name=$a ;;
    esac
  done
  [ -s "$TOPUP_DIR/state/image.env" ] || die "还没有部署过，没有可以恢复进去的系统" "先粘贴第一次部署的那条命令"
  if [ -n "$name" ]; then
    # 只认 backup/ 下的文件名（不认路径）
    name=$(basename -- "$name")
    case "$name" in topup-*.tar.age) ;; *) die "备份文件名应该是 topup-….tar.age（backup/ 下的文件名）；什么都没有改" "ls $TOPUP_DIR/backup 看有哪些" ;; esac
    enc="$TOPUP_DIR/backup/$name"
    [ -f "$enc" ] || die "本机没有这份备份：$name；什么都没有改" "ls $TOPUP_DIR/backup 看有哪些；不写文件名就用最新的一份"
  else
    enc=$(ls -1t "$TOPUP_DIR"/backup/topup-*.tar.age 2> /dev/null | head -1)
    [ -n "$enc" ] || die "本机没有备份，没有可以恢复的；什么都没有改" "备份在别处（例如 R2）的，截图发运维"
    name=$(basename "$enc")
  fi
  RS_NAME=$name; RS_PROD=$( [ "$(topup_env)" = production ] && echo 1 || true)
  say "要恢复的备份：$name（$(date -r "$enc" '+%F %T %Z' 2> /dev/null)）"
  if [ -z "$confirm" ]; then
    say "✗ 还没有确认，什么都没有做。恢复会："
    detail "1. 先把现在的数据备份一次（topup-<时间>-pre-restore.tar.age）"
    detail "2. 停 web、worker（期间收银台和后台打不开，约 1～3 分钟）"
    detail "3. 数据库、Redis（管理员账号、会话）、开户文件换成这份备份里的——备份之后新产生的数据都没有了"
    detail "4. 只启动 web，worker 暂停：核对完备份之后链上已发生的打款、归集，再 sudo topup start-worker --confirm。.env、deploy.env 不动"
    detail "确认要做：sudo topup restore $name --confirm$([ -n "$RS_PROD" ] && echo ' --production')"
    exit 1
  fi
  if [ -n "$RS_PROD" ] && [ -z "$prod" ]; then
    die "这台是生产：恢复会丢掉备份之后的全部数据，还要再加 --production；什么都没有改" "确认要做：sudo topup restore $name --confirm --production"
  fi
  [ ! -f "$TOPUP_DIR/state/stopped" ] || die "TopUP 现在停着（sudo topup stop 停的）；什么都没有改" "先 sudo topup start，再运行同一条命令"
  env_guard "什么都没有改（恢复后要重建 web、worker，带着这样的 .env 起不来）"
  # 磁盘：解密出的明文包 + 解开的文件 + 恢复前的备份 + 新的 Redis、开户文件，按备份大小的 4 倍再加 200 MB 估
  need=$(( $(du -k "$enc" | cut -f1) * 4 + 204800 ))
  avail=$(df -Pk "$TOPUP_DIR" | awk 'NR == 2 { print $4 }')
  [ "${avail:-0}" -ge "$need" ] || die "磁盘不够：剩 $((avail / 1024)) MB，恢复大约要 $((need / 1024)) MB；什么都没有改" "先清理磁盘（sudo topup status 看占用），再运行同一条命令"
  # 自动更新不要在恢复途中换版本
  exec 9> "$TOPUP_DIR/state/update.lock"
  flock -w 900 9 || die "自动更新一直没有结束；什么都没有改" "等几分钟再运行同一条命令"
  worker_held && RS_HAD_HOLD=1
  RS_PHASE=prep
  trap 'restore_abort "恢复被中断（收到停止信号：Ctrl+C 或终端断开）"' INT HUP TERM

  # 1. 解密到临时目录（里面有明文，退出时删掉）并核对；这一步什么都不动
  tmp=$(mktemp -d "$TOPUP_DIR/backup/.restore-XXXXXX") || die "建不了临时目录；什么都没有改" "截图发运维"
  chmod 700 "$tmp"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT
  age -d -i "$TOPUP_DIR/$BACKUP_IDENTITY_REL" -o "$tmp/b.tar" "$enc" 2>> "$LOG" || die "解密失败（本机加密密钥不对或文件坏了）；什么都没有改" "截图发运维"
  { tar -C "$tmp" -xf "$tmp/b.tar" 2>> "$LOG" && rm -f "$tmp/b.tar"; } || die "备份文件解不开；什么都没有改" "截图发运维"
  for a in postgres.dump redis.rdb blobs.tar app.env deploy.env; do
    [ -f "$tmp/$a" ] || die "备份里缺 $a，不完整；什么都没有改" "换一份备份（不写文件名用最新的）或截图发运维"
  done
  [ "$(envval TOPUP_ENV "$tmp/deploy.env")" = "$(topup_env)" ] \
    || die "这份备份是 $(envval TOPUP_ENV "$tmp/deploy.env") 的，这台是 $(topup_env)；什么都没有改" "测试环境和生产的备份不能混用"
  # 只比较、不显示主密钥的值
  if [ -z "$(envval APP_SECRET "$tmp/app.env")" ] || [ "$(envval APP_SECRET "$tmp/app.env")" != "$(envval APP_SECRET)" ]; then
    die "备份里的主密钥 APP_SECRET 和现在 .env 里的不一样（恢复出来的开户资料、加密字段会解不开）；什么都没有改" "截图发运维（不要自己改 APP_SECRET）"
  fi
  at=$(jq -r '.at // empty' "$tmp/meta.json" 2> /dev/null | sed -E 's/^(....)(..)(..)-(..)(..)(..)$/\1-\2-\3 \4:\5:\6/')
  [ -n "$at" ] || at="$(date -u -r "$enc" '+%F %T')"
  ok "第 1 步：已解密核对（环境、主密钥 APP_SECRET 和现在的一致；不显示值；备份做于 $at UTC）"

  # 2. 先备份一次现在的数据（万一恢复错了还能换回来），并解开核对一遍
  ( BACKUP_PRUNE=0; cmd_backup pre-restore ) >> "$LOG" 2>&1 || die "第 2 步：恢复前的备份失败；什么都没有改" "sudo topup status 截图发运维"
  RS_PRE=$(basename "$(ls -1t "$TOPUP_DIR"/backup/topup-*-pre-restore.tar.age 2> /dev/null | head -1)")
  list="$tmp/pre-restore.list"
  { age -d -i "$TOPUP_DIR/$BACKUP_IDENTITY_REL" "$TOPUP_DIR/backup/$RS_PRE" | tar -t > "$list"; } 2>> "$LOG" \
    && grep -qx './postgres.dump' "$list" && grep -qx './redis.rdb' "$list" && grep -qx './blobs.tar' "$list" \
    || die "第 2 步：恢复前的备份 $RS_PRE 解不开或不完整；什么都没有改" "截图发运维"
  ok "第 2 步：已先备份现在的数据并解开核对：$RS_PRE"

  # 3. 停 web、worker，导入数据库（--clean：先删掉备份里有的对象再建；一个事务，失败就什么都没变）
  say "  … 第 3 步：停 web、worker，导入数据库"
  RS_PHASE=stopped
  compose stop web worker >> "$LOG" 2>&1 || restore_abort "第 3 步：停 web、worker 失败"
  # 从这里起数据库可能被换掉：worker 暂停（之后的启动都不建 worker），直到核对完 start-worker
  printf 'backup=%s\nat=%s UTC\nby=%s\n' "$name" "$at" "${SUDO_USER:-$(id -un 2> /dev/null || echo root)}" > "$TOPUP_DIR/$HOLD_REL" \
    || restore_abort "第 3 步：写不了 $HOLD_REL"
  RS_PHASE=db
  # 放到后台再 wait：收到停止信号时能马上处理（restore_abort 会结束容器里的 pg_restore）
  compose exec -T postgres pg_restore -U topup -d topup --clean --if-exists --no-owner --single-transaction < "$tmp/postgres.dump" >> "$LOG" 2>&1 &
  RS_PID=$!
  if ! wait "$RS_PID"; then
    RS_PID=""; RS_PHASE=stopped
    restore_abort "第 3 步：导入数据库失败（一个事务，数据库没有变）"
  fi
  RS_PID=""
  ok "第 3 步：数据库已恢复"

  # 4. Redis：停下，原来的数据目录挪开，备份里的数据作为 AOF 的基础文件放进去（Redis 开着 AOF，只放 dump.rdb 不会被读）
  RS_PHASE=redis
  compose stop redis >> "$LOG" 2>&1 || restore_abort "第 4 步：停 Redis 失败"
  rm -rf "$TOPUP_DIR/data/redis.pre-restore"
  if [ -d "$TOPUP_DIR/data/redis" ]; then
    mv "$TOPUP_DIR/data/redis" "$TOPUP_DIR/data/redis.pre-restore" || restore_abort "第 4 步：挪不开原来的 Redis 数据目录"
    RS_RD_OLD="$TOPUP_DIR/data/redis.pre-restore"
  fi
  { mkdir -p "$TOPUP_DIR/data/redis/appendonlydir" \
    && cp "$tmp/redis.rdb" "$TOPUP_DIR/data/redis/appendonlydir/appendonly.aof.1.base.rdb" \
    && : > "$TOPUP_DIR/data/redis/appendonlydir/appendonly.aof.1.incr.aof" \
    && printf 'file appendonly.aof.1.base.rdb seq 1 type b\nfile appendonly.aof.1.incr.aof seq 1 type i\n' > "$TOPUP_DIR/data/redis/appendonlydir/appendonly.aof.manifest"; } 2>> "$LOG" \
    || restore_abort "第 4 步：写 Redis 的数据失败（磁盘满？）"
  [ -z "$RS_RD_OLD" ] || chown -R --reference="$RS_RD_OLD" "$TOPUP_DIR/data/redis" 2> /dev/null || true
  ok "第 4 步：Redis 的数据已换成备份里的"

  # 5. 开户文件：原来的目录挪开，解开备份里的
  RS_PHASE=blobs
  rm -rf "$TOPUP_DIR/data/blobs.pre-restore"
  if [ -d "$TOPUP_DIR/data/blobs" ]; then
    mv "$TOPUP_DIR/data/blobs" "$TOPUP_DIR/data/blobs.pre-restore" || restore_abort "第 5 步：挪不开原来的开户文件目录"
    RS_BL_OLD="$TOPUP_DIR/data/blobs.pre-restore"
  fi
  tar -C "$TOPUP_DIR/data" -xf "$tmp/blobs.tar" 2>> "$LOG" && [ -d "$TOPUP_DIR/data/blobs" ] || restore_abort "第 5 步：解开开户文件失败（磁盘满？）"
  if [ "$(id -u)" = 0 ]; then chown -R 1000:1000 "$TOPUP_DIR/data/blobs" || restore_abort "第 5 步：改开户文件的属主失败"; fi
  ok "第 5 步：开户文件已恢复（$(find "$TOPUP_DIR/data/blobs" -type f | wc -l) 个）"
  rm -rf "$tmp"

  # 6. 启动（worker 暂停着，只起 web 等）；.env 没有变，上面已经过了环境检查
  RS_PHASE=start
  ! gateway || write_realip
  compose_up >> "$LOG" 2>&1 || restore_abort "第 6 步：启动失败"
  wait_alive "$(cur_tag)" || restore_abort "第 6 步：3 分钟内 web 的健康检查没有通过"
  trap - INT HUP TERM
  rm -rf "$RS_RD_OLD" "$RS_BL_OLD"
  who=${SUDO_USER:-$(id -un 2> /dev/null || echo root)}
  note "恢复完成：$name（备份做于 $at UTC），操作人 $who；worker 暂停等核对"
  ok "已从 $name 恢复，web 已启动（版本 $(cur_tag | cut -c1-7)）；恢复前的数据另存了一份：$RS_PRE"
  say ""
  say "======== worker 暂停中：核对清单 ========"
  worker_checklist "$at" | tee -a "$LOG"
  send_mail "TopUP 已从备份恢复，worker 暂停等核对" "服务器上运行了 sudo topup restore：$(date -u '+%F %T UTC')，操作人 $who，用的备份 $name。
备份之后产生的数据已经不在系统里；恢复前的数据另存了一份加密备份：$RS_PRE。不是你们安排的操作，马上联系运维。

$(worker_checklist "$at")" || true
}

# ---------- start-worker：restore 之后核对完再启动 worker ----------
cmd_start_worker() {
  local a confirm="" who
  start_log start-worker
  for a in "$@"; do
    case "$a" in --confirm) confirm=1 ;; *) die "不认识的参数：$a" "sudo topup start-worker --confirm" ;; esac
  done
  [ -s "$TOPUP_DIR/state/image.env" ] || die "还没有部署过" "先粘贴第一次部署的那条命令"
  worker_held || { ok "worker 没有暂停，什么都不用做"; return 0; }
  if [ -z "$confirm" ]; then
    say "✗ 还没有确认，worker 还暂停着。暂停原因：$(tr '\n' ' ' < "$TOPUP_DIR/$HOLD_REL")"
    worker_checklist "$(sed -n 's/^at=//p' "$TOPUP_DIR/$HOLD_REL" | sed 's/ UTC$//')" | sed 's/^/    /' | tee -a "$LOG"
    exit 1
  fi
  [ ! -f "$TOPUP_DIR/state/stopped" ] || die "TopUP 现在停着（sudo topup stop 停的）" "先 sudo topup start（worker 仍然暂停），再运行同一条命令"
  env_guard "worker 没有启动"
  exec 9> "$TOPUP_DIR/state/update.lock"
  flock -w 900 9 || die "自动更新一直没有结束；worker 没有启动" "等几分钟再运行同一条命令"
  who=${SUDO_USER:-$(id -un 2> /dev/null || echo root)}
  note "核对完、启动 worker：操作人 $who；暂停原因：$(tr '\n' ' ' < "$TOPUP_DIR/$HOLD_REL")"
  mv "$TOPUP_DIR/$HOLD_REL" "$TOPUP_DIR/$HOLD_REL.done" || die "改不了 $HOLD_REL" "截图发运维"
  compose up -d worker >> "$LOG" 2>&1 || { mv "$TOPUP_DIR/$HOLD_REL.done" "$TOPUP_DIR/$HOLD_REL"; die "启动 worker 失败（仍然暂停）" "截图发运维"; }
  wait_alive "$(cur_tag)" || die "worker 启动后 3 分钟内健康检查没有通过" "sudo topup status 截图发运维"
  rm -f "$TOPUP_DIR/$HOLD_REL.done"
  ok "worker 已启动（扫链、打款、归集恢复）"
  send_mail "TopUP 的 worker 已在恢复备份后重新启动" "服务器上运行了 sudo topup start-worker --confirm：$(date -u '+%F %T UTC')，操作人 $who。" || true
}

# ---------- admin-reset：管理员密码 / 验证器丢了时重置运营后台的管理员账号 ----------
# 换一个新的初始化口令（写进 .env，旧口令作废）→ 重建 web（新口令生效）→ 删掉 Redis 里的管理员凭据（topup:admin、
# 半途的初始化、登录锁定、失败计数、动态码记录），再查一遍确实没了。先换口令再删账号：账号删掉的那一刻起，只有新口令能重新初始化。
# 新旧口令都不显示、不进日志（看新口令：sudo topup admin-token）；日志记下是谁、什么时候做的，并尝试发一封提醒邮件。
cmd_admin_reset() {
  local a confirm="" who
  start_log admin-reset
  for a in "$@"; do
    case "$a" in --confirm) confirm=1 ;; *) die "不认识的参数：$a" "sudo topup admin-reset --confirm" ;; esac
  done
  [ -s "$TOPUP_DIR/state/image.env" ] && [ -n "$(envval ADMIN_SETUP_TOKEN)" ] || die "还没有部署过" "先粘贴第一次部署的那条命令"
  if [ -z "$confirm" ]; then
    say "✗ 还没有确认，什么都没有做。重置会："
    detail "1. 删掉运营后台现在的管理员账号（密码、验证器、登录锁定）"
    detail "2. 换一个新的初始化口令（旧的作废），重建 web（约 1 分钟）"
    detail "3. 之后用 sudo topup admin-token 看新口令，打开后台按页面提示重新设置密码和验证器"
    detail "确认要做：sudo topup admin-reset --confirm"
    exit 1
  fi
  [ ! -f "$TOPUP_DIR/state/stopped" ] || die "TopUP 现在停着（sudo topup stop 停的）；什么都没有改" "先 sudo topup start，再运行同一条命令"
  env_guard "什么都没有改（重置要重建 web，带着这样的 .env 起不来）"
  exec 9> "$TOPUP_DIR/state/update.lock"
  flock -w 900 9 || die "自动更新一直没有结束；什么都没有改" "等几分钟再运行同一条命令"
  who=${SUDO_USER:-$(id -un 2> /dev/null || echo root)}
  note "管理员重置开始：操作人 $who"

  VAL="$(rand 24)" env_write ADMIN_SETUP_TOKEN "$TOPUP_DIR/.env"
  ok "第 1 步：已换新的初始化口令（旧的作废；不显示）"
  compose up -d web >> "$LOG" 2>&1 || die "第 2 步：重建 web 失败（管理员账号还没删，原来的还能登录）" "截图发运维"
  wait_alive "$(cur_tag)" || die "第 2 步：重建 web 后 3 分钟内健康检查没有通过（管理员账号还没删）" "sudo topup status 截图发运维"
  ok "第 2 步：web 已重建，新口令生效"
  # redis-cli 遇到错误回复（例如密码不对）退出码也是 0：删完再查一遍，几个键都不在了才算成功
  # shellcheck disable=SC2016
  compose exec -T redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning del topup:admin topup:admin:pending topup:admin:lock topup:admin:fails topup:admin:totp-last > /dev/null; n=$(redis-cli -a "$REDIS_PASSWORD" --no-auth-warning exists topup:admin topup:admin:pending topup:admin:lock topup:admin:fails topup:admin:totp-last); echo "exists=$n"; [ "$n" = 0 ]' >> "$LOG" 2>&1 \
    || die "第 3 步：删除 Redis 里的管理员账号失败（删完查到还在，或者连不上 Redis）；新口令已生效，原来的账号可能还在" "截图发运维；可以再运行一次 sudo topup admin-reset --confirm"
  ok "第 3 步：已删掉原来的管理员账号（密码、验证器、登录锁定），查过确实没有了"
  note "管理员重置完成：操作人 $who（口令不记日志）"
  detail "下一步：sudo topup admin-token 看新口令，打开 https://$(dval DOMAIN)/admin/ 按页面提示重新设置密码和验证器"
  send_mail "TopUP 运营后台的管理员账号已重置" "服务器上运行了 sudo topup admin-reset：$(date -u '+%F %T UTC')，操作人 $who。
原来的管理员密码和验证器已作废，要用新的初始化口令（sudo topup admin-token）重新设置。不是你们安排的操作，马上联系运维。" || true
}

# ---------- watch：每 5 分钟检查一次，状态变化时发邮件（问题不变不重复发）----------
watch_problems() {
  local body p=() used avail age free_gb why
  body=$(health_json)
  if [ -z "$body" ]; then p+=("web 没有响应")
  else
    jq -e '.ok == true' <<< "$body" > /dev/null 2>&1 || p+=("健康检查 ok=false：$(jq -r '[to_entries[] | select(.value == false) | .key] | join(",")' <<< "$body" 2> /dev/null)")
    jq -e '.worker.ok == true' <<< "$body" > /dev/null 2>&1 || p+=("worker 超过 5 分钟没有运行")
  fi
  used=$(df --output=pcent "$TOPUP_DIR" | tail -1 | tr -dc 0-9)
  [ "${used:-0}" -lt 85 ] || p+=("磁盘已用 ${used}%")
  # 小磁盘（生产 16 GB）：按百分比还没到 85% 时剩余空间可能已经放不下一次更新（新镜像 + 更新前备份）
  free_gb=$(df -BG --output=avail "$TOPUP_DIR" | tail -1 | tr -dc 0-9)
  [ "${free_gb:-99}" -ge 2 ] || p+=("磁盘只剩 ${free_gb} GB（不够下一次更新）")
  avail=$(mem_avail_mb)
  [ "$avail" -ge 100 ] || p+=("可用内存只剩 ${avail} MB")
  if [ -f "$TOPUP_DIR/state/last-backup.json" ]; then
    age=$(( ( $(date -u +%s) - $(date -u -d "$(jq -r .at "$TOPUP_DIR/state/last-backup.json" | sed -E 's/^(....)(..)(..)-(..)(..)(..)$/\1-\2-\3 \4:\5:\6/')" +%s 2> /dev/null || echo 0) ) / 3600 ))
    [ "$age" -le 26 ] || p+=("超过 ${age} 小时没有备份")
    [ "$(jq -r .r2 "$TOPUP_DIR/state/last-backup.json")" != failed ] || p+=("上一次上传 R2 失败")
    [ "$(jq -r .local "$TOPUP_DIR/state/last-backup.json")" = encrypted ] || p+=("上一次备份没有加密（旧版本留下的，sudo topup backup 重做一次）")
  fi
  # 环境和 .env 对不上（例如生产的 TRON_NETWORK 被改成了 nile）
  why=$(env_refusal); [ -z "$why" ] || case "$why" in *TEST_*) ;; *) p+=("$why") ;; esac
  # 测试管理员只在测试环境：不是测试环境的服务器 .env 里有它（应用会拒绝启动）

  [ "$(dval TOPUP_ENV)" = staging ] || [ -z "$(envval TEST_ADMIN_TOKEN_SHA256)" ] || p+=(".env 里有 TEST_ADMIN_TOKEN_SHA256，但这台不是测试环境（应用会拒绝启动）：sudo topup test-admin-off")
  [ "$(dval TOPUP_ENV)" = staging ] || [ -z "$(envval TEST_MERCHANT_IP_BYPASS)" ] || p+=(".env 里有 TEST_MERCHANT_IP_BYPASS，但这台不是测试环境（应用会拒绝启动）：sudo topup test-merchant-ip-off")
  ! worker_held || p+=("worker 暂停中（恢复备份后等核对打款、归集）：核对完 sudo topup start-worker --confirm")
  [ ! -f "$TOPUP_DIR/state/skip" ] || p+=("版本 $(cut -c1-7 "$TOPUP_DIR/state/skip") 更新失败、不再重试（sudo topup retry）")
  if [ -f "$LE_DIR/live/$CERT_NAME/fullchain.pem" ] && ! openssl x509 -checkend $((14 * 86400)) -noout -in "$LE_DIR/live/$CERT_NAME/fullchain.pem" > /dev/null 2>&1; then p+=("HTTPS 证书 14 天内过期"); fi
  printf '%s\n' "${p[@]}"
}

cmd_watch() {
  start_log watch
  [ -f "$TOPUP_DIR/state/stopped" ] && { rm -f "$LOG"; exit 0; }
  local now prev
  now=$(watch_problems)
  prev=$(cat "$TOPUP_DIR/state/watch" 2> /dev/null || true)
  if [ "$now" = "$prev" ]; then rm -f "$LOG"; exit 0; fi
  printf '%s' "$now" > "$TOPUP_DIR/state/watch"
  note "状态变化：${now:-正常}"
  if [ -n "$now" ]; then
    send_mail "TopUP 服务器需要处理" "每 5 分钟的检查发现：
$now

看状态：在云控制台远程连接里运行 sudo topup status。问题不变不会重复发；恢复正常时再发一封。" || true
  else
    send_mail "TopUP 服务器已恢复正常" "之前的问题都已恢复。" || true
  fi
}

# ---------- status / keys ----------
cmd_status() {
  start_log status
  local body
  say "== TopUP（$TOPUP_DIR）：$( [ "$(topup_env)" = production ] && echo 生产 || echo 测试环境)，镜像标签 :$(track)$(gateway && echo "，平台网关模式（本机端口 $(dval TOPUP_HTTP_PORT)）")"
  detail "版本：$(cur_tag | cut -c1-7)    上一个：$(cut -c1-7 "$TOPUP_DIR/state/previous" 2> /dev/null || echo 无)    不再重试：$(cut -c1-7 "$TOPUP_DIR/state/skip" 2> /dev/null || echo 无)"
  [ ! -f "$TOPUP_DIR/state/stopped" ] || detail "已用 sudo topup stop 停下（sudo topup start 重新启动）"
  ! worker_held || detail "worker 暂停中（恢复备份后等核对）：$(tr '\n' ' ' < "$TOPUP_DIR/$HOLD_REL")；核对完 sudo topup start-worker --confirm"
  docker ps -a --filter label=com.docker.compose.project=topup --format '    {{.Names}}  {{.Status}}' | tee -a "$LOG"
  body=$(health_json)
  detail "健康检查：$(jq -c '{ok, env, commit, db, storage, secret, blob, mail, mailMode, pay, worker}' <<< "$body" 2> /dev/null || echo 没有响应)"
  detail "钱包：$(jq -c '.wallet // {}' <<< "$body" 2> /dev/null)"
  [ "$(dval TOPUP_ENV)" != staging ] || detail "测试管理员：$(jq -r 'if .test_admin == true then "开着（sudo topup test-admin-off 关）" else "关着（sudo topup gen-test-admin 开）" end' <<< "$body" 2> /dev/null)"
  [ "$(dval TOPUP_ENV)" != staging ] || detail "测试商户免 IP 白名单：$(jq -r 'if .test_merchant_ip_bypass == true then "开着（sudo topup test-merchant-ip-off 关）" else "关着（sudo topup set TEST_MERCHANT_IP_BYPASS 商户编号 开）" end' <<< "$body" 2> /dev/null)"
  ! gateway || detail "真实 IP：$( [ "$(realip_mode)" = off ] && echo '关（访客 IP 都是平台网关的地址；按 IP 限流共用一个额度，商户 IP 白名单在生产上未验证、不能用）' || echo "开（$(realip_mode)，只认 $(dval TOPUP_REAL_IP_FROM) 来的）")"
  detail "还没填的：$(missing_list)"
  detail "备份：$(cat "$TOPUP_DIR/state/last-backup.json" 2> /dev/null || echo 还没有)    恢复演练：$(cat "$TOPUP_DIR/state/last-drill.json" 2> /dev/null || echo 还没有)"
  [ -f "$LE_DIR/live/$CERT_NAME/fullchain.pem" ] && detail "证书到期：$(openssl x509 -enddate -noout -in "$LE_DIR/live/$CERT_NAME/fullchain.pem" | cut -d= -f2)"
  [ -n "$DRILL" ] || detail "定时器：$(for t in topup-update topup-backup topup-watch; do printf '%s=%s ' "$t" "$(systemctl is-active "$t.timer" 2> /dev/null)"; done)"
  detail "别的项目：$(for p in $(other_projects); do printf '%s(%s) ' "$p" "$(project_running "$p" && echo 运行中 || echo 已停)"; done)"
  docker stats --no-stream --format '    {{.Name}} {{.MemUsage}}' $(docker ps -q --filter label=com.docker.compose.project=topup) 2> /dev/null | tee -a "$LOG"
  free -m | sed 's/^/    /' | tee -a "$LOG"
  df -h "$TOPUP_DIR" | tail -1 | sed 's/^/    磁盘 /' | tee -a "$LOG"
  detail "检查发现的问题：$(watch_problems | tr '\n' ';' | sed 's/;$//')"
}

cmd_keys() {
  start_log keys
  local k
  say "密钥（sudo topup set-key 变量名，只显示有没有填）："
  for k in $SECRET_KEYS; do
    if [ -n "$(key_value "$k")" ]; then detail "已填  $k"; else detail "未填  $k"; fi
  done
  say "普通设置（sudo topup set 变量名 值）："
  for k in $PLAIN_KEYS; do detail "$(printf '%-24s' "$k") $(key_value "$k")"; done
  detail "BACKUP_AGE_RECIPIENT     $([ -n "$(dval BACKUP_AGE_RECIPIENT)" ] && echo 已生成 || echo '未生成（只有打开异地备份才要：sudo topup backup-key）')"
  detail "TEST_ADMIN_TOKEN_SHA256  $([ -n "$(envval TEST_ADMIN_TOKEN_SHA256)" ] && echo '已生成（测试管理员开着；sudo topup test-admin-off 关）' || echo '未生成（只在测试环境用：sudo topup gen-test-admin）')"
}
# 改了要重建 web、worker 的设置（写进 .env 的）：.env 现在就和环境对不上时什么都不改（改了也起不来）
guard_before_change() {
  case "$DEPLOY_KEYS" in *" $1 "*) return 0 ;; esac
  env_guard "什么都没有改（这一项要重建 web、worker 才生效，带着这样的 .env 起不来）"
}
key_file() { case "$DEPLOY_KEYS" in *" $1 "*) echo "$TOPUP_DIR/deploy.env" ;; *) echo "$TOPUP_DIR/.env" ;; esac; }
key_value() { envval "$1" "$(key_file "$1")"; }

# 填写后：应用正在运行就重建 web、worker 让它生效，再看健康检查
apply_env() {
  local key=$1 body
  case "$key" in
    TOPUP_REAL_IP_HEADER | TOPUP_REAL_IP_FROM)
      apply_realip "$key" "${2:-}"
      return 0 ;;
  esac
  case "$DEPLOY_KEYS" in *" $key "*) ok "下一次备份开始使用（可以 sudo topup backup 立刻试一次）"; return 0 ;; esac
  if [ -f "$TOPUP_DIR/state/stopped" ] || [ ! -s "$TOPUP_DIR/state/image.env" ]; then ok "TopUP 现在没有在运行，下次启动时生效"; return 0; fi
  env_guard "已经写进 .env，但没有重建 web、worker"
  say "  … 让它生效（重建 web、worker，数据不动，约 1 分钟）"
  if worker_held; then compose up -d web >> "$LOG" 2>&1; else compose up -d web worker >> "$LOG" 2>&1; fi || die "重建容器失败" "截图发运维"
  wait_alive "$(cur_tag)" || die "改了以后 3 分钟内健康检查没有通过" "截图发运维；也可以再运行一次 set-key 换回原来的值"
  body=$(health_json)
  ok "已生效。健康检查：$(jq -c '{ok, mail, mailMode, pay, worker: .worker.ok}' <<< "$body" 2> /dev/null)"
  case "$key" in
    RESEND_API_KEY | SMTP_PASS | MAIL_TO | MAIL_FROM) detail "确认邮件：sudo topup test-mail（发一封测试邮件到 MAIL_TO）" ;;
    ETH_RPC_URL | BSC_RPC_URL) detail "钱包：$(jq -c '[.wallet.chains[]? | {chain, rpc: .rpcConfigured}]' <<< "$body" 2> /dev/null)" ;;
    SWEEP_OPERATOR_KEY) detail "发起账户（ETH、BSC）：$(jq -r '.wallet.operator' <<< "$body")" ;;
    SWEEP_OPERATOR_KEY_TRON) detail "发起账户（TRON）：$(jq -r '.wallet.operator_tron' <<< "$body")" ;;
    TEST_ADMIN_TOKEN_SHA256) detail "测试管理员：$(jq -r 'if .test_admin == true then "开着" else "关着" end' <<< "$body")" ;;
    TEST_MERCHANT_IP_BYPASS) detail "测试商户免 IP 白名单：$(jq -r 'if .test_merchant_ip_bypass == true then "开着" else "关着" end' <<< "$body")" ;;
  esac
}

check_name() {
  local key=$1 allowed=$2 up
  case " $allowed " in *" $key "*) return 0 ;; esac
  up=$(echo "$key" | tr '[:lower:]-' '[:upper:]_')
  case " $allowed " in *" $up "*) die "变量名要全部大写：$up" "运行 sudo topup ${3} $up" ;; esac
  case " $SECRET_KEYS $PLAIN_KEYS " in *" $up "*) die "$up 不是用这个命令填的" "密钥用 sudo topup set-key，普通设置用 sudo topup set" ;; esac
  say "✗ 不认识变量名：$key"
  detail "密钥（set-key）：$SECRET_KEYS"
  detail "普通设置（set）：$PLAIN_KEYS"
  exit 1
}

check_value() {
  local key=$1 val=$2
  case "$val" in *[[:space:]\"\'\`\$\\]*) die "值里有空格、引号、\$、反引号或反斜杠，配置文件里不能这样写；什么都没有改" "确认复制的是完整的值（不要带引号），再运行一次" ;; esac
  case "$key" in
    SWEEP_OPERATOR_KEY | SWEEP_OPERATOR_KEY_TRON)
      printf '%s' "$val" | grep -Eq '^(0x)?[0-9a-fA-F]{64}$' || die "$key 应该是 64 位十六进制的私钥（可以带 0x）；什么都没有改" "确认复制的是私钥，不是地址或助记词" ;;
    ETH_RPC_URL | BSC_RPC_URL | TRON_NODE_URL)
      printf '%s' "$val" | grep -Eq '^https://' || die "$key 应该是 https:// 开头的节点地址；什么都没有改" ;;
    MAIL_FROM | MAIL_TO)
      printf '%s' "$val" | grep -Eq '^[^@]+@[^@]+\.[^@]+$' || die "$key 应该是一个邮箱地址；什么都没有改" ;;
    TRON_NODE_QPS)
      printf '%s' "$val" | grep -Eq '^[1-9][0-9]{0,3}$' || die "TRON_NODE_QPS 应该是正整数（每秒最多发给 TRON 节点的请求数，例如 10）；什么都没有改" ;;
    BACKUP_OFFSITE)
      case "$val" in off | r2) ;; *) die "BACKUP_OFFSITE 只能是 off（默认，只在本机）或 r2；什么都没有改" ;; esac ;;
    TOPUP_REAL_IP_HEADER)
      gateway || die "只在平台网关模式用（这台不是）；什么都没有改"
      case "$val" in off | X-Forwarded-For | X-Real-IP) ;; *) die "TOPUP_REAL_IP_HEADER 只能是 off、X-Forwarded-For、X-Real-IP（按实测网关带的那个填）；什么都没有改" ;; esac ;;
    TOPUP_REAL_IP_FROM)
      gateway || die "只在平台网关模式用（这台不是）；什么都没有改"
      realip_from_ok "$val" \
        || die "TOPUP_REAL_IP_FROM 不合格；什么都没有改" "填网关的地址或地址段，多个用逗号隔开（不要空格、结尾不要逗号）；IPv4 前缀 16～32、IPv6 前缀 48～128；不能和 Docker 默认网段 172.17.0.0～172.31.255.255 重叠" ;;
    TEST_MERCHANT_IP_BYPASS)
      [ "$(dval TOPUP_ENV)" = staging ] || die "只用于测试环境；生产不能有这一项（应用会拒绝启动），什么都没有改"
      printf '%s' "$val" | grep -Eq '^[A-Za-z0-9_-]{1,64}$' || die "TEST_MERCHANT_IP_BYPASS 应该是一个商户编号（例如运营后台商户列表里 m_ 开头的那一列）；什么都没有改" ;;
  esac
}

cmd_set_key() {
  local key=${1:-} val file
  start_log set-key
  [ -n "$key" ] || die "要写变量名，例如：sudo topup set-key TRONGRID_API_KEY" "可以填的：$SECRET_KEYS"
  check_name "$key" "$SECRET_KEYS" set-key
  [ -f "$TOPUP_DIR/.env" ] || die "还没有部署过" "先粘贴第一次部署的那条命令"
  if [ -n "$DRILL" ] && [ -n "${TOPUP_DRILL_INPUT+x}" ]; then val=$TOPUP_DRILL_INPUT
  else
    [ -r /dev/tty ] || die "这里不能输入（没有终端）" "在云控制台的'远程连接'终端里运行，不要用控制台的 AI 助手"
    echo "请粘贴 $key 的值，然后按回车（屏幕上不会显示，这是正常的；不要用控制台的 AI 助手，不要把它发给任何对话框）："
    IFS= read -r -s val < /dev/tty
    echo
  fi
  val=$(printf '%s' "$val" | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
  [ -n "$val" ] || { say "没有输入，什么都没有改。"; exit 0; }
  check_value "$key" "$val"
  guard_before_change "$key"
  file=$(key_file "$key")
  if [ "$(envval "$key" "$file")" = "$val" ]; then unset val; say "和原来的值一样，没有改。"; exit 0; fi
  VAL="$val" env_write "$key" "$file"
  unset val
  ok "已设置 $key（不显示值）"
  apply_env "$key"
}

cmd_set() {
  local key=${1:-} val=${2:-} file
  start_log set
  [ -n "$key" ] || die "要写变量名和值，例如：sudo topup set MAIL_TO 收件人邮箱" "可以填的：$PLAIN_KEYS"
  check_name "$key" "$PLAIN_KEYS" set
  [ -f "$TOPUP_DIR/.env" ] || die "还没有部署过" "先粘贴第一次部署的那条命令"
  [ -n "$val" ] || die "要写值，例如：sudo topup set $key 值"
  check_value "$key" "$val"
  guard_before_change "$key"
  file=$(key_file "$key")
  local old; old=$(envval "$key" "$file")
  [ "$old" != "$val" ] || { say "和原来的值一样，没有改。"; exit 0; }
  VAL="$val" env_write "$key" "$file"
  ok "已设置 $key=$val"
  apply_env "$key" "$old"

}

# 第一次进运营后台要的初始化口令：只显示在终端上（不进日志）；初始化完成后它就没用了（后台会拒绝再次初始化）
cmd_admin_token() {
  start_log admin-token
  local t; t=$(envval ADMIN_SETUP_TOKEN)
  [ -n "$t" ] || die "还没有部署过" "先粘贴第一次部署的那条命令"
  if [ -n "$DRILL" ]; then echo "$t"; return 0; fi
  [ -w /dev/tty ] || die "这里不能显示（没有终端）" "在云控制台的'远程连接'终端里运行"
  echo "运营后台初始化口令（只用一次；打开 https://$(dval DOMAIN)/admin/ 按页面提示填，初始化完成后它就作废了。不要截图、不要发给任何对话框）：" > /dev/tty
  echo "$t" > /dev/tty
  note "显示了一次初始化口令（值不记日志）"
}

cmd_test_mail() {
  start_log test-mail
  send_mail "TopUP 测试邮件" "这是一封测试邮件：收到就说明测试环境的发信设置是好的。" \
    && ok "已发出测试邮件到 MAIL_TO，去收件箱看（可能在垃圾邮件里）" \
    || die "没有发出去（邮件设置没填全，或者 Key 没有这个发信域名的权限）" "sudo topup keys 看哪项没填；日志 $LOG"
}

# ---------- gen-operator：测试环境的两个归集发起账户（私钥在服务器上随机生成，谁都看不到，只显示地址）----------
# 用应用自己的地址算法（server/wallet/evm-tx.js、server/pay/tron.js）。已经有的不重新生成，只显示它的地址。
# 只用于测试环境（TOPUP_ENV=staging）；生产的发起账户怎么来由管理员决定。
operator_js='
const { randomBytes } = await import("node:crypto");
const { secp256k1 } = await import("/app/node_modules/@noble/curves/secp256k1.js");
const { addressOfKey } = await import("/app/server/wallet/evm-tx.js");
const { addressFromPublicKey } = await import("/app/server/pay/tron.js");
let k = (process.env.OP_KEY || "").replace(/^0x/, "");
const fresh = !k;
if (fresh) { let b; do { b = randomBytes(32); } while (!secp256k1.utils.isValidPrivateKey(b)); k = b.toString("hex"); }
const addr = process.env.OP_CHAIN === "tron" ? addressFromPublicKey(secp256k1.getPublicKey(Buffer.from(k, "hex"), false)) : addressOfKey("0x" + k);
console.log((fresh ? "0x" + k : "-") + " " + addr);'
cmd_gen_operator() {
  start_log gen-operator
  [ -s "$TOPUP_DIR/state/image.env" ] || die "还没有部署过" "先粘贴第一次部署的那条命令"
  [ "$(dval TOPUP_ENV)" = staging ] || die "只用于测试环境" "生产的发起账户按部署方案另定"
  local key chain out k addr changed=0
  for pair in SWEEP_OPERATOR_KEY:evm SWEEP_OPERATOR_KEY_TRON:tron; do
    key=${pair%%:*}; chain=${pair#*:}
    out=$(OP_KEY="$(envval "$key")" OP_CHAIN="$chain" compose run --rm --no-deps -T -e OP_KEY -e OP_CHAIN web node --input-type=module -e "$operator_js" 2>> "$LOG")
    k=${out%% *}; addr=${out#* }
    [ -n "$addr" ] && [ "$addr" != "$out" ] || die "生成 $key 失败" "截图发运维"
    if [ "$k" != "-" ]; then VAL="$k" env_write "$key" "$TOPUP_DIR/.env"; changed=1; ok "已生成 $key（私钥只在服务器的 .env 里，不显示）"; else ok "$key 已经有了，没有重新生成"; fi
    unset k out
    detail "$([ "$chain" = tron ] && echo 'TRON Nile 发起账户地址' || echo 'ETH Sepolia / BSC 测试网发起账户地址')：$addr"
  done
  detail "这两个地址要领测试币付手续费（部署方案里的水龙头），部署合约时把它们登记为发起账户。"
  [ "$changed" = 0 ] || apply_env SWEEP_OPERATOR_KEY
}

# ---------- gen-test-admin / test-admin-off：测试环境的测试管理员（server/pay/test-admin.js）----------
# 令牌在服务器上随机生成（tta_ + 64 位十六进制），.env 里只写它的 SHA-256（TEST_ADMIN_TOKEN_SHA256）；令牌原文只显示在终端上一次、不进日志。
# 管理员把它填进 GitHub 环境 staging-e2e 的密钥 STAGING_TEST_ADMIN_TOKEN。再运行一次就换新令牌（旧的立刻作废）。
# 只用于测试环境（TOPUP_ENV=staging）；生产的应用看到这个变量会拒绝启动。
env_del() {
  local key=$1 file=$2 tmp
  tmp=$(mktemp "$file.XXXXXX")
  chmod 600 "$tmp"
  KEY="$key" awk 'index($0, ENVIRON["KEY"] "=") != 1' "$file" > "$tmp" && mv "$tmp" "$file"
  chmod 600 "$file"
}
cmd_gen_test_admin() {
  start_log gen-test-admin
  [ -s "$TOPUP_DIR/state/image.env" ] || die "还没有部署过" "先粘贴第一次部署的那条命令"
  [ "$(dval TOPUP_ENV)" = staging ] || die "只用于测试环境；生产不能有测试管理员（什么都没有改）"
  [ -n "$DRILL" ] || [ -w /dev/tty ] || die "这里不能显示令牌（没有终端）" "在云控制台的'远程连接'终端里运行，不要用控制台的 AI 助手"
  local tok hash
  tok="tta_$(rand 32)"
  hash=$(printf '%s' "$tok" | sha256sum | cut -d' ' -f1)
  printf '%s' "$hash" | grep -Eq '^[0-9a-f]{64}$' || die "生成失败" "截图发运维"
  VAL="$hash" env_write TEST_ADMIN_TOKEN_SHA256 "$TOPUP_DIR/.env"
  unset hash
  ok "已生成新的测试令牌（服务器只存它的哈希；以前的令牌已作废）"
  apply_env TEST_ADMIN_TOKEN_SHA256
  note "生成了一次测试令牌（值不记日志）"
  if [ -n "$DRILL" ]; then echo "$tok"; unset tok; return 0; fi
  {
    echo
    echo "测试令牌（只显示这一次；整行复制，不要带空格和换行）："
    echo "$tok"
    echo
    echo "填到：GitHub 仓库 → Settings → Environments → staging-e2e → Environment secrets → STAGING_TEST_ADMIN_TOKEN。"
    echo "填好后清屏（clear），不要截图、不要发给任何对话框。丢了就再运行一次 sudo topup gen-test-admin（换新令牌）。"
  } > /dev/tty
  unset tok
}
cmd_test_admin_off() {
  start_log test-admin-off
  [ -f "$TOPUP_DIR/.env" ] || die "还没有部署过" "先粘贴第一次部署的那条命令"
  [ -n "$(envval TEST_ADMIN_TOKEN_SHA256)" ] || { ok "测试管理员本来就是关着的，没有改"; return 0; }
  env_del TEST_ADMIN_TOKEN_SHA256 "$TOPUP_DIR/.env"
  ok "已删掉 TEST_ADMIN_TOKEN_SHA256（测试令牌作废）"
  apply_env TEST_ADMIN_TOKEN_SHA256
  detail "GitHub 环境 staging-e2e 里的 STAGING_TEST_ADMIN_TOKEN 也可以删掉（不删也用不了）"
}

# ---------- test-merchant-ip-off：关掉测试商户免 IP 白名单（server/pay/test-admin.js 的 testMerchantIpBypass）----------
# 开：sudo topup set TEST_MERCHANT_IP_BYPASS 商户编号（只在测试环境）。关：删掉这一行。
cmd_test_merchant_ip_off() {
  start_log test-merchant-ip-off
  [ -f "$TOPUP_DIR/.env" ] || die "还没有部署过" "先粘贴第一次部署的那条命令"
  [ -n "$(envval TEST_MERCHANT_IP_BYPASS)" ] || { ok "测试商户免 IP 白名单本来就是关着的，没有改"; return 0; }
  env_del TEST_MERCHANT_IP_BYPASS "$TOPUP_DIR/.env"
  ok "已删掉 TEST_MERCHANT_IP_BYPASS（这个商户调提币、批量打款又要查 IP 白名单）"
  apply_env TEST_MERCHANT_IP_BYPASS
}

# ---------- stop / start（停：定时器 → 应用 → 备份 → 数据库）----------
cmd_stop() {
  start_log stop
  [ -n "$DRILL" ] || systemctl disable --now topup-update.timer topup-backup.timer topup-watch.timer >> "$LOG" 2>&1 || true
  touch "$TOPUP_DIR/state/stopped"
  exec 9> "$TOPUP_DIR/state/update.lock"; flock -w 900 9 || true
  compose stop nginx web worker >> "$LOG" 2>&1 || die "停应用失败" "截图发运维"
  ok "第 1 步：定时器已停、应用已停"
  if ! bash "$KIT/kit/topup.sh" backup before-stop >> "$LOG" 2>&1; then
    if worker_held; then compose start web nginx; else compose start web worker nginx; fi >> "$LOG" 2>&1 || true
    rm -f "$TOPUP_DIR/state/stopped"
    [ -n "$DRILL" ] || systemctl enable --now topup-update.timer topup-backup.timer topup-watch.timer >> "$LOG" 2>&1 || true
    die "第 2 步：备份失败，已把 TopUP 恢复运行" "截图发运维"
  fi
  ok "第 2 步：已备份"
  compose stop >> "$LOG" 2>&1 || die "停数据库失败" "截图发运维"
  ok "第 3 步：数据库和 Redis 已停。数据都保留；端口 $(public_ports | sed 's/ /、/g') 已空出。重新启动：sudo topup start"
}

cmd_start() {
  start_log start
  local p avail limits running
  [ -s "$TOPUP_DIR/state/image.env" ] || die "还没有部署过" "先粘贴第一次部署的那条命令"
  env_guard "TopUP 没有启动"

  if [ "$(topup_env)" = production ]; then
    # 生产从不停别的项目
    running=$(others_running)
    [ -z "$running" ] || ok "这台机器上还有别的项目在运行：${running% }（生产不停别的项目，只提醒）"
  else
    for p in $(other_projects); do
      if project_running "$p"; then
        say "  … 先停 $p（定时器 → 应用 → 它的备份 → 数据库）"
        stop_other "$p" || die "停 $p 失败或它的备份失败（已恢复它）" "截图发运维"
        ok "已停 $p"
      fi
    done
  fi
  check_ports ""
  limits=$(limits_mb); avail=$(avail_for_topup)
  [ "$avail" -ge $((limits + RESERVE_MB)) ] || die "内存不够：可用 ${avail} MB，需要 $((limits + RESERVE_MB)) MB" "截图发运维"
  rm -f "$TOPUP_DIR/state/stopped"
  ! gateway || write_realip
  compose_up >> "$LOG" 2>&1 || die "启动失败" "截图发运维"
  wait_alive "$(cur_tag)" || die "3 分钟内健康检查没有通过" "sudo topup status 截图发运维"
  [ -n "$DRILL" ] || systemctl enable --now topup-update.timer topup-backup.timer topup-watch.timer >> "$LOG" 2>&1 || true
  ok "TopUP 已启动（版本 $(cur_tag | cut -c1-7)），自动更新、备份、检查已打开"
  ! worker_held || detail "worker 还暂停着（恢复备份后等核对）：核对完再 sudo topup start-worker --confirm"
}

usage() {
  echo "用法（都要 sudo）："; sed -n 's/^#   \(sudo topup .*\)/  \1/p' "$0"
}

# 要 root（服务器上部署目录在 /opt 下）。只有部署目录（还没有时看它的上一级）当前用户本来就能写时才不要求——开发机、CI 上的测试用临时目录
if [ "$(id -u)" != 0 ]; then
  if [ -d "$TOPUP_DIR" ]; then [ -w "$TOPUP_DIR" ]; else [ -w "$(dirname "$TOPUP_DIR")" ]; fi \
    || { echo "✗ 请用 sudo 运行，例如：sudo topup status"; exit 1; }
fi
# 环境写进 deploy.env 以后就固定了：命令行带的 TOPUP_ENV 和它不一样就停下（install 自己核对，还会核对网关模式和端口）
if [ "${1:-}" != install ] && [ -n "$ENV_ARG" ] && [ -n "$(dval TOPUP_ENV)" ] && [ "$ENV_ARG" != "$(dval TOPUP_ENV)" ]; then
  echo "✗ 这台机器是按 $(dval TOPUP_ENV) 部署的，命令里却写了 TOPUP_ENV=$ENV_ARG；什么都没有做"; exit 1
fi

command -v jq > /dev/null || [ "${1:-}" = install ] || { echo "✗ 没有 jq，先重新粘贴第一次部署的那条命令"; exit 1; }
cmd=${1:-help}; shift || true
case "$cmd" in
  install) cmd_install "$@" ;;
  update) cmd_update ;;
  retry) cmd_retry ;;
  rollback) cmd_rollback ;;
  backup) cmd_backup "$@" ;;
  backup-key) cmd_backup_key ;;
  restore-drill) cmd_restore_drill "$@" ;;
  restore) cmd_restore "$@" ;;
  start-worker) cmd_start_worker "$@" ;;
  watch) cmd_watch ;;
  status) cmd_status ;;
  keys) cmd_keys ;;
  set-key) cmd_set_key "$@" ;;
  set) cmd_set "$@" ;;
  test-mail) cmd_test_mail ;;
  gen-operator) cmd_gen_operator ;;
  admin-token) cmd_admin_token ;;
  admin-reset) cmd_admin_reset "$@" ;;
  gen-test-admin) cmd_gen_test_admin ;;
  test-admin-off) cmd_test_admin_off ;;
  test-merchant-ip-off) cmd_test_merchant_ip_off ;;
  stop) cmd_stop ;;
  start) cmd_start ;;
  help | -h | --help) usage ;;
  *) echo "✗ 不认识 $cmd"; usage; exit 1 ;;
esac
