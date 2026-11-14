#!/usr/bin/env bash
# TopUP 服务器上的部署命令（测试环境；生产换服务器后沿用）。说明见 deploy/README.md。
# 第一次：管理员在云控制台"远程连接"终端里粘贴一条命令（下载本文件并运行 install）；之后用 sudo topup <子命令>：
#   sudo topup status            版本、容器、健康检查、内存、磁盘、备份、证书（不显示任何密钥）
#   sudo topup keys              哪些变量已填、哪些没填（只显示名字）
#   sudo topup set-key 变量名     填一个密钥（粘贴时屏幕上不显示），写进 .env 并自动生效
#   sudo topup set 变量名 值      填一个不是密钥的设置（例如收件人邮箱），自动生效
#   sudo topup gen-operator      测试环境：在服务器上生成两个归集发起账户（ETH/BSC 一个、TRON 一个），只显示地址
#   sudo topup admin-token       显示一次运营后台的初始化口令（第一次进后台用，初始化后作废）
#   sudo topup test-mail         发一封测试邮件到 MAIL_TO
#   sudo topup backup            立刻备份一次（每天的定时备份也是它）：本机加密保存，默认不传到别处
#   sudo topup restore-drill     恢复演练：把本机最近一份备份解密、恢复进临时容器并核对，不碰正在运行的数据
#   sudo topup backup-key        （异地备份用，默认用不到）生成管理员的备份密钥对：公钥写进 deploy.env，私钥只在屏幕上显示一次
#                                异地备份默认关闭；生产要开时 set BACKUP_OFFSITE r2 并填 R2_…，restore-drill --from-r2 从 R2 下载演练
#   sudo topup rollback          换回上一个版本，并且不再自动更新到当前这个版本
#   sudo topup retry             清掉"不再重试"的记录，下一分钟重新尝试最新版本
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
# 所有容器内存上限之和（MB），和 compose.yml 一致：postgres 320 + redis 96 + web 288 + worker 288 + nginx 48
LIMITS_MB=1040
# 系统和 Docker 自己要留的（MB，推断）；启动前要求可用内存 ≥ 上限之和 + 这个数
RESERVE_MB=100
HEALTH=http://127.0.0.1:18080/api/health/
# 备份：本机保留 7 天、至少 3 份；本机备份合计超过这个大小时从最旧的删起（至少留 3 份）
BACKUP_MAX_MB=${TOPUP_BACKUP_MAX_MB:-2048}
# 本机备份的加密密钥（服务器自己生成，只在本机，600）
BACKUP_IDENTITY_REL=state/backup-identity
# 可以用 set-key 填的密钥（屏幕上不显示）；R2_ 开头的写进 deploy.env，其余写进 .env
SECRET_KEYS="RESEND_API_KEY SMTP_PASS TRONGRID_API_KEY ETH_RPC_URL BSC_RPC_URL TRON_NODE_URL SWEEP_OPERATOR_KEY SWEEP_OPERATOR_KEY_TRON TRONSAVE_API_KEY R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY"
# 可以用 set 填的普通设置（不是密钥，会显示）
PLAIN_KEYS="MAIL_FROM MAIL_TO SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USER ETH_CONFIRMATIONS BSC_CONFIRMATIONS TRON_CONFIRMATIONS TRONSAVE_MAX_PRICE_SUN TRON_RENT_MAX_ENERGY USDT_CONTRACT BACKUP_OFFSITE R2_ACCOUNT_ID R2_BUCKET"
# 由部署决定的变量（compose.yml 的 environment 或镜像），不写进 .env
MANAGED_KEYS="APP_ENV PUBLIC_URL HOST PORT TRUST_PROXY GIT_COMMIT DATABASE_URL REDIS_URL BLOB_DIR"
DEPLOY_KEYS=" BACKUP_OFFSITE R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_ACCOUNT_ID R2_BUCKET BACKUP_AGE_RECIPIENT "

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
  mkdir -p "$TOPUP_DIR/logs"
  LOG="$TOPUP_DIR/logs/$1-$(date -u +%Y%m%d-%H%M%S).log"
  : > "$LOG"
  chmod 600 "$LOG"
  # 日志只留 30 天
  find "$TOPUP_DIR/logs" -name '*.log' -mtime +30 -delete 2> /dev/null || true
}
# 只追加到日志，不显示（自动运行的子命令用）
note() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }

envval() { sed -n "s/^$1=//p" "${2:-$TOPUP_DIR/.env}" 2> /dev/null | tail -1; }
dval() { envval "$1" "$TOPUP_DIR/deploy.env"; }
cur_tag() { sed -n 's/^IMAGE_TAG=//p' "$TOPUP_DIR/state/image.env" 2> /dev/null || true; }

compose() {
  docker compose --project-name topup --project-directory "$TOPUP_DIR" -f "$KIT/compose.yml" \
    --env-file "$TOPUP_DIR/deploy.env" --env-file "$TOPUP_DIR/state/image.env" "$@"
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
# 应用活着：提交号对得上、数据库、Redis、主密钥都配好，worker 5 分钟内跑过。
# 邮件、节点 Key 没配不算失败（那是要填的设置，换回旧版本也解决不了），在 status 和 watch 里显示
app_alive() {
  local body=$1 want=${2:-}
  [ -n "$body" ] || return 1
  [ -z "$want" ] || [ "$(jq -r '.commit // empty' <<< "$body" 2> /dev/null)" = "${want:0:7}" ] || return 1
  jq -e '.db == true and .storage == true and .secret == true and .worker.ok == true' <<< "$body" > /dev/null 2>&1
}
wait_alive() {
  local want=$1 body end=$((SECONDS + ${TOPUP_WAIT_S:-180}))
  while [ "$SECONDS" -lt "$end" ]; do
    body=$(health_json)
    app_alive "$body" "$want" && return 0
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

port_busy_by_others() {
  docker ps --format '{{.Names}} {{.Ports}}' | grep -E '(0\.0\.0\.0|\[::\]):(80|443)->' | grep -v '^topup-' || true
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
  compose up -d --remove-orphans >> "$LOG" 2>&1
}

# 本机只留最近 5 个版本的镜像（正在用的和上一个不删）
prune_images() {
  local image cur prev n=0 tag
  image=$(dval TOPUP_IMAGE); cur=$(cur_tag); prev=$(cat "$TOPUP_DIR/state/previous" 2> /dev/null || true)
  for tag in $(docker image ls "$image" --format '{{.Tag}}'); do
    [ "$tag" = staging ] && continue
    n=$((n + 1))
    if [ "$n" -gt 5 ] && [ "$tag" != "$cur" ] && [ "$tag" != "$prev" ]; then docker image rm "$image:$tag" > /dev/null 2>&1 || true; fi
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
  local domain=${1:-} email=${2:-} image=${TOPUP_IMAGE:-} f pub resolved others p tag new
  start_log install
  say "TopUP 测试环境第一次部署（$(date '+%F %T %Z')）"
  [ -n "$domain" ] && [ -n "$email" ] || die "要写域名和证书提醒邮箱：sudo topup install <域名> <邮箱>"
  printf '%s' "$domain" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' \
    || die "域名写法不对（只写域名，不要 https:// 和斜杠）"
  [ -n "$image" ] || image=$(dval TOPUP_IMAGE)
  [ -n "$image" ] || die "不知道镜像在哪里（TOPUP_IMAGE）" "用部署方案里给的那条完整命令"

  # 第 1 步：软件
  if [ -n "$DRILL" ]; then
    ok "第 1 步：软件——演练模式，跳过"
  else
    . /etc/os-release
    [ "${VERSION_ID:-}" = "24.04" ] || detail "提醒：本脚本按 Ubuntu 24.04 编写，这台是 ${PRETTY_NAME:-未知}"
    local need=()
    command -v docker > /dev/null || need+=(docker.io docker-compose-v2)
    # rclone 只有打开异地备份时才要（backup 会提示安装），默认不装
    for p in certbot age jq curl openssl; do command -v "$p" > /dev/null || need+=("$p"); done
    if [ "${#need[@]}" -gt 0 ]; then
      say "  … 第 1 步：安装 ${need[*]}（约 1～3 分钟）"
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -q >> "$LOG" 2>&1 && apt-get install -y -q "${need[@]}" >> "$LOG" 2>&1 || die "第 1 步：安装软件失败" "等 1 分钟再粘贴同一条命令；还不行就截图"
    fi
    docker compose version > /dev/null 2>&1 || die "第 1 步：没有 docker compose" "截图发运维"
    if [ ! -f /etc/docker/daemon.json ]; then
      echo '{ "log-driver": "json-file", "log-opts": { "max-size": "50m", "max-file": "3" } }' > /etc/docker/daemon.json
      systemctl restart docker >> "$LOG" 2>&1
    fi
    ok "第 1 步：软件（Docker $(docker --version | awk '{print $3}' | tr -d ,)、certbot、age、jq）"
  fi

  # 第 2 步：取部署工具包（镜像 staging 标签里的 /topup-kit）
  mkdir -p "$TOPUP_DIR"/{state,logs,backup,data/postgres,data/redis,data/blobs}
  chmod 700 "$TOPUP_DIR/state" "$TOPUP_DIR/backup"
  # web、worker 在镜像里用 node（uid 1000）运行，开户文件目录要能写
  chown 1000:1000 "$TOPUP_DIR/data/blobs"
  pull "$image:staging" || die "第 2 步：下载镜像失败" "确认镜像已经公开（或已登录镜像仓库），再粘贴同一条命令"
  sync_kit "$image:staging" || die "第 2 步：从镜像取部署工具包失败" "截图发运维"
  ok "第 2 步：部署工具包（$KIT${DRILL:+；演练模式}）"

  # 第 3 步：两个配置文件。已有的值不覆盖；内部口令随机生成、不显示
  for f in .env deploy.env; do [ -f "$TOPUP_DIR/$f" ] || { : > "$TOPUP_DIR/$f"; }; chmod 600 "$TOPUP_DIR/$f"; done
  while IFS= read -r line; do
    case "$line" in '#'* | '') continue ;; esac
    f=${line%%=*}
    # 这几项由部署决定（compose.yml 的 environment），不放进 .env；GIT_COMMIT 空着会盖掉镜像里的提交号
    case " $MANAGED_KEYS " in *" $f "*) continue ;; esac
    grep -q "^$f=" "$TOPUP_DIR/.env" || echo "$f=" >> "$TOPUP_DIR/.env"
  done < "$KIT/kit/app.env.example"
  set_default() { [ -n "$(envval "$1" "$3")" ] || VAL="$2" env_write "$1" "$3"; }
  set_default TOPUP_DIR "$TOPUP_DIR" "$TOPUP_DIR/deploy.env"
  set_default TOPUP_IMAGE "$image" "$TOPUP_DIR/deploy.env"
  set_default TOPUP_ENV staging "$TOPUP_DIR/deploy.env"
  set_default DOMAIN "$domain" "$TOPUP_DIR/deploy.env"
  set_default CERT_EMAIL "$email" "$TOPUP_DIR/deploy.env"
  set_default CERT_NAME "$CERT_NAME" "$TOPUP_DIR/deploy.env"
  set_default LE_DIR "$LE_DIR" "$TOPUP_DIR/deploy.env"
  set_default WEBROOT_DIR "$WEBROOT_DIR" "$TOPUP_DIR/deploy.env"
  set_default POSTGRES_PASSWORD "$(rand 24)" "$TOPUP_DIR/deploy.env"
  set_default REDIS_PASSWORD "$(rand 24)" "$TOPUP_DIR/deploy.env"
  set_default BACKUP_OFFSITE off "$TOPUP_DIR/deploy.env"
  for k in R2_ACCOUNT_ID R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY BACKUP_AGE_RECIPIENT; do grep -q "^$k=" "$TOPUP_DIR/deploy.env" || echo "$k=" >> "$TOPUP_DIR/deploy.env"; done
  backup_identity > /dev/null || die "第 3 步：生成本机备份的加密密钥失败" "截图发运维"
  set_default TRON_NETWORK nile "$TOPUP_DIR/.env"
  # 主密钥：派生全部加密、签名密钥，换了以后旧数据解不开。只生成一次，不显示（加密备份里有它）
  set_default APP_SECRET "$(rand 32)" "$TOPUP_DIR/.env"
  set_default ADMIN_SETUP_TOKEN "$(rand 16)" "$TOPUP_DIR/.env"
  [ "$(dval DOMAIN)" = "$domain" ] || die "第 3 步：这台服务器已经配过别的域名 $(dval DOMAIN)" "要换域名先截图发运维"
  [ "$(dval TOPUP_ENV)" = staging ] && [ "$(envval TRON_NETWORK)" = nile ] || die "第 3 步：deploy.env 里 TOPUP_ENV 不是 staging 或 .env 里 TRON_NETWORK 不是 nile" "测试环境只能连测试网；截图发运维"
  ok "第 3 步：配置文件（内部口令、主密钥已随机生成，不显示；已有的值没有动）"

  # 第 4 步：别的项目（同一时间只运行一个项目）
  others=$(other_projects)
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
  local busy; busy=$(port_busy_by_others)
  [ -z "$busy" ] || die "第 4 步：80 / 443 端口被别的容器占着：$(echo "$busy" | awk '{print $1}' | tr '\n' ' ')" "截图发运维"

  # 第 5 步：内存和磁盘（容器上限之和 + 余量要低于可用内存）
  local avail free_gb
  if project_running topup; then avail=$(( $(mem_avail_mb) + $(docker stats --no-stream --format '{{.MemUsage}}' $(docker ps -q --filter label=com.docker.compose.project=topup) 2> /dev/null | awk '{v=$1; if (v ~ /GiB/) {sub(/GiB/,"",v); s+=v*1024} else if (v ~ /MiB/) {sub(/MiB/,"",v); s+=v} else if (v ~ /KiB/) {sub(/KiB/,"",v); s+=v/1024}} END {print int(s)}') ))
  else avail=$(mem_avail_mb); fi
  [ -n "${TOPUP_DRILL_MEM_MB:-}" ] && avail=$TOPUP_DRILL_MEM_MB
  [ "$avail" -ge $((LIMITS_MB + RESERVE_MB)) ] || die "第 5 步：内存不够：可用 ${avail} MB，TopUP 需要 $((LIMITS_MB + RESERVE_MB)) MB" "截图（含 free -m）发运维；可能要先停别的程序，或者加一台服务器（部署方案第 7 节）"
  free_gb=$(df -BG --output=avail "$TOPUP_DIR" | tail -1 | tr -dc 0-9)
  [ -n "${TOPUP_DRILL_DISK_GB:-}" ] && free_gb=$TOPUP_DRILL_DISK_GB
  [ "$free_gb" -ge 5 ] || die "第 5 步：磁盘只剩 ${free_gb} GB（至少要 5 GB）" "截图发运维"
  ok "第 5 步：内存可用 ${avail} MB（容器上限合计 ${LIMITS_MB} MB）、磁盘剩 ${free_gb} GB"

  # 第 6 步：证书
  if [ -f "$LE_DIR/live/$CERT_NAME/fullchain.pem" ]; then
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

  # 第 7 步：启动 staging 最新版本
  tag=$(cur_tag)
  new=$(revision "$image:staging")
  [ -n "$new" ] || die "第 7 步：镜像里没有版本号" "截图发运维"
  if [ "$tag" = "$new" ] && app_alive "$(health_json)" "$new"; then
    ok "第 7 步：启动——版本 ${new:0:7} 已经在运行，跳过"
  else
    say "  … 第 7 步：启动版本 ${new:0:7}（第一次要初始化数据库，约 1～3 分钟）"
    docker tag "$image:staging" "$image:$new" >> "$LOG" 2>&1
    switch_to "$new" || die "第 7 步：docker compose 启动失败" "截图发运维（日志 $LOG）"
    wait_alive "$new" || die "第 7 步：3 分钟内健康检查没有通过" "sudo topup status 截图发运维"
    ok "第 7 步：已启动版本 ${new:0:7}，健康检查通过"
  fi

  # 第 8 步：证书改为经 Nginx 续期；打开定时器
  if [ -z "$DRILL" ]; then
    certbot reconfigure -n --cert-name "$CERT_NAME" --webroot -w "$WEBROOT_DIR" \
      --deploy-hook "docker exec topup-nginx-1 nginx -s reload" >> "$LOG" 2>&1 || detail "提醒：证书续期方式没有改成功（不影响现在使用），截图发运维"
    cp "$KIT"/kit/systemd/topup-*.service "$KIT"/kit/systemd/topup-*.timer /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable --now topup-update.timer topup-backup.timer topup-watch.timer >> "$LOG" 2>&1 || die "第 8 步：打开定时器失败" "截图发运维"
    ok "第 8 步：自动更新（每分钟）、每天备份、每 5 分钟检查已打开；证书自动续期"
  else
    ok "第 8 步：定时器——演练模式，跳过"
  fi

  summary
}

summary() {
  local body
  body=$(health_json)
  say ""
  say "======== 摘要（不含任何密钥，可以直接截图）========"
  say "地址：https://$(dval DOMAIN)/"
  say "版本：$(cur_tag | cut -c1-7)    环境：$(jq -r '.env // "?"' <<< "$body" 2> /dev/null)"
  say "健康检查：$(jq -c '{ok, db, storage, secret, blob, mail, mailMode, pay, worker}' <<< "$body" 2> /dev/null || echo 没有响应)"
  say "还没填的（只列名字）：$(missing_list)"
  say "默认关着的功能："
  say "  · 邮件：填好 MAIL_FROM、MAIL_TO 和 RESEND_API_KEY（或 SMTP）之前不发任何邮件，告警也发不出"
  say "  · ETH、BSC：ETH_RPC_URL / BSC_RPC_URL 没填、合约地址没进 config/wallets.json 之前不开通"
  say "  · TRON 合约钱包：config/wallets.json 的 staging.tron 没填之前不开通；归集要 SWEEP_OPERATOR_KEY_TRON"
  say "  · 异地备份：测试环境不开（D6），备份只加密保存在这台服务器上；整台服务器丢了备份也跟着丢"
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
  local image new cur
  image=$(dval TOPUP_IMAGE)
  [ -f "$TOPUP_DIR/state/stopped" ] && { rm -f "$LOG"; exit 0; }
  pull "$image:staging" || { note "下载 staging 镜像失败"; exit 1; }
  new=$(revision "$image:staging"); cur=$(cur_tag)
  [ -n "$new" ] || { note "staging 镜像没有版本号"; exit 1; }
  # 没有新版本、或者这个版本失败过（state/skip）：什么都不做，也不留日志
  if [ "$new" = "$cur" ] || [ "$new" = "$(cat "$TOPUP_DIR/state/skip" 2> /dev/null)" ]; then rm -f "$LOG"; exit 0; fi
  note "发现新版本 $new（当前 ${cur:-无}）"
  docker tag "$image:staging" "$image:$new" >> "$LOG" 2>&1
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
  if [ -n "$cur" ]; then
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
  local label=${1:-daily} ts dir out pub recip offsite=off
  start_log backup
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
  out="$TOPUP_DIR/backup/topup-$ts-$label.tar.age"
  # 明文不落盘成一个整包：直接打包进 age
  if ! ( umask 077; tar -C "$dir" -cf - . | age "${recip[@]}" -o "$out.part" ) 2>> "$LOG"; then
    rm -rf "$dir" "$out.part"; die "备份：加密失败" "截图发运维"
  fi
  mv "$out.part" "$out"; chmod 600 "$out"
  rm -rf "$dir"
  ok "备份：本机已加密 $(basename "$out")（$(du -h "$out" | cut -f1)）"
  backup_prune
  # 异地（R2）：默认关闭；打开了但没配好只提示、不算失败
  if offsite_on; then
    if [ -z "$(dval BACKUP_AGE_RECIPIENT)" ] || [ -z "$(dval R2_ACCOUNT_ID)" ] || [ -z "$(dval R2_BUCKET)" ] || [ -z "$(dval R2_ACCESS_KEY_ID)" ] || [ -z "$(dval R2_SECRET_ACCESS_KEY)" ]; then
      detail "异地备份打开了但没配好（R2_… 或备份公钥没填），这次只在本机"; offsite=not_configured
    elif ! command -v rclone > /dev/null; then
      detail "异地备份要 rclone：sudo apt-get install -y rclone，这次只在本机"; offsite=not_configured
    elif r2 copyto "$out" "r2:$(dval R2_BUCKET)/topup-staging/$(basename "$out")" >> "$LOG" 2>&1; then
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
  local f total n=0
  total=$(du -ck "$TOPUP_DIR"/backup/topup-*.tar.age 2> /dev/null | tail -1 | cut -f1)
  while read -r f; do
    [ -n "$f" ] || continue
    n=$((n + 1)); [ "$n" -gt 3 ] || continue
    if [ -n "$(find "$f" -mtime +7)" ] || [ "${total:-0}" -gt $((BACKUP_MAX_MB * 1024)) ]; then
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
    name=$(r2 lsf "r2:$(dval R2_BUCKET)/topup-staging/" 2>> "$LOG" | sort | tail -1)
    [ -n "$name" ] || die "R2 里没有找到备份" "先 sudo topup backup，确认上传成功"
    r2 copyto "r2:$(dval R2_BUCKET)/topup-staging/$name" "$tmp/b.tar.age" >> "$LOG" 2>&1 || die "从 R2 下载失败"
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

# ---------- watch：每 5 分钟检查一次，状态变化时发邮件（问题不变不重复发）----------
watch_problems() {
  local body p=() used avail age
  body=$(health_json)
  if [ -z "$body" ]; then p+=("web 没有响应")
  else
    jq -e '.ok == true' <<< "$body" > /dev/null 2>&1 || p+=("健康检查 ok=false：$(jq -r '[to_entries[] | select(.value == false) | .key] | join(",")' <<< "$body" 2> /dev/null)")
    jq -e '.worker.ok == true' <<< "$body" > /dev/null 2>&1 || p+=("worker 超过 5 分钟没有运行")
  fi
  used=$(df --output=pcent "$TOPUP_DIR" | tail -1 | tr -dc 0-9)
  [ "${used:-0}" -lt 85 ] || p+=("磁盘已用 ${used}%")
  avail=$(mem_avail_mb)
  [ "$avail" -ge 100 ] || p+=("可用内存只剩 ${avail} MB")
  if [ -f "$TOPUP_DIR/state/last-backup.json" ]; then
    age=$(( ( $(date -u +%s) - $(date -u -d "$(jq -r .at "$TOPUP_DIR/state/last-backup.json" | sed -E 's/^(....)(..)(..)-(..)(..)(..)$/\1-\2-\3 \4:\5:\6/')" +%s 2> /dev/null || echo 0) ) / 3600 ))
    [ "$age" -le 26 ] || p+=("超过 ${age} 小时没有备份")
    [ "$(jq -r .r2 "$TOPUP_DIR/state/last-backup.json")" != failed ] || p+=("上一次上传 R2 失败")
    [ "$(jq -r .local "$TOPUP_DIR/state/last-backup.json")" = encrypted ] || p+=("上一次备份没有加密（旧版本留下的，sudo topup backup 重做一次）")
  fi
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
  say "== TopUP（$TOPUP_DIR）"
  detail "版本：$(cur_tag | cut -c1-7)    上一个：$(cut -c1-7 "$TOPUP_DIR/state/previous" 2> /dev/null || echo 无)    不再重试：$(cut -c1-7 "$TOPUP_DIR/state/skip" 2> /dev/null || echo 无)"
  [ ! -f "$TOPUP_DIR/state/stopped" ] || detail "已用 sudo topup stop 停下（sudo topup start 重新启动）"
  docker ps -a --filter label=com.docker.compose.project=topup --format '    {{.Names}}  {{.Status}}' | tee -a "$LOG"
  body=$(health_json)
  detail "健康检查：$(jq -c '{ok, env, commit, db, storage, secret, blob, mail, mailMode, pay, worker}' <<< "$body" 2> /dev/null || echo 没有响应)"
  detail "钱包：$(jq -c '.wallet // {}' <<< "$body" 2> /dev/null)"
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
}
key_file() { case "$DEPLOY_KEYS" in *" $1 "*) echo "$TOPUP_DIR/deploy.env" ;; *) echo "$TOPUP_DIR/.env" ;; esac; }
key_value() { envval "$1" "$(key_file "$1")"; }

# 填写后：应用正在运行就重建 web、worker 让它生效，再看健康检查
apply_env() {
  local key=$1 body
  case "$DEPLOY_KEYS" in *" $key "*) ok "下一次备份开始使用（可以 sudo topup backup 立刻试一次）"; return 0 ;; esac
  if [ -f "$TOPUP_DIR/state/stopped" ] || [ ! -s "$TOPUP_DIR/state/image.env" ]; then ok "TopUP 现在没有在运行，下次启动时生效"; return 0; fi
  say "  … 让它生效（重建 web、worker，数据不动，约 1 分钟）"
  compose up -d web worker >> "$LOG" 2>&1 || die "重建容器失败" "截图发运维"
  wait_alive "$(cur_tag)" || die "改了以后 3 分钟内健康检查没有通过" "截图发运维；也可以再运行一次 set-key 换回原来的值"
  body=$(health_json)
  ok "已生效。健康检查：$(jq -c '{ok, mail, mailMode, pay, worker: .worker.ok}' <<< "$body" 2> /dev/null)"
  case "$key" in
    RESEND_API_KEY | SMTP_PASS | MAIL_TO | MAIL_FROM) detail "确认邮件：sudo topup test-mail（发一封测试邮件到 MAIL_TO）" ;;
    ETH_RPC_URL | BSC_RPC_URL) detail "钱包：$(jq -c '[.wallet.chains[]? | {chain, rpc: .rpcConfigured}]' <<< "$body" 2> /dev/null)" ;;
    SWEEP_OPERATOR_KEY) detail "发起账户（ETH、BSC）：$(jq -r '.wallet.operator' <<< "$body")" ;;
    SWEEP_OPERATOR_KEY_TRON) detail "发起账户（TRON）：$(jq -r '.wallet.operator_tron' <<< "$body")" ;;
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
    BACKUP_OFFSITE)
      case "$val" in off | r2) ;; *) die "BACKUP_OFFSITE 只能是 off（默认，只在本机）或 r2；什么都没有改" ;; esac ;;
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
  file=$(key_file "$key")
  [ "$(envval "$key" "$file")" != "$val" ] || { say "和原来的值一样，没有改。"; exit 0; }
  VAL="$val" env_write "$key" "$file"
  ok "已设置 $key=$val"
  apply_env "$key"
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

# ---------- stop / start（停：定时器 → 应用 → 备份 → 数据库）----------
cmd_stop() {
  start_log stop
  [ -n "$DRILL" ] || systemctl disable --now topup-update.timer topup-backup.timer topup-watch.timer >> "$LOG" 2>&1 || true
  touch "$TOPUP_DIR/state/stopped"
  exec 9> "$TOPUP_DIR/state/update.lock"; flock -w 900 9 || true
  compose stop nginx web worker >> "$LOG" 2>&1 || die "停应用失败" "截图发运维"
  ok "第 1 步：定时器已停、应用已停"
  if ! bash "$KIT/kit/topup.sh" backup before-stop >> "$LOG" 2>&1; then
    compose start web worker nginx >> "$LOG" 2>&1 || true
    rm -f "$TOPUP_DIR/state/stopped"
    [ -n "$DRILL" ] || systemctl enable --now topup-update.timer topup-backup.timer topup-watch.timer >> "$LOG" 2>&1 || true
    die "第 2 步：备份失败，已把 TopUP 恢复运行" "截图发运维"
  fi
  ok "第 2 步：已备份"
  compose stop >> "$LOG" 2>&1 || die "停数据库失败" "截图发运维"
  ok "第 3 步：数据库和 Redis 已停。数据都保留；80、443 端口已空出。重新启动：sudo topup start"
}

cmd_start() {
  start_log start
  local p busy avail
  for p in $(other_projects); do
    if project_running "$p"; then
      say "  … 先停 $p（定时器 → 应用 → 它的备份 → 数据库）"
      stop_other "$p" || die "停 $p 失败或它的备份失败（已恢复它）" "截图发运维"
      ok "已停 $p"
    fi
  done
  busy=$(port_busy_by_others); [ -z "$busy" ] || die "80 / 443 被占着：$(echo "$busy" | awk '{print $1}' | tr '\n' ' ')" "截图发运维"
  avail=$(mem_avail_mb); [ -n "${TOPUP_DRILL_MEM_MB:-}" ] && avail=$TOPUP_DRILL_MEM_MB
  [ "$avail" -ge $((LIMITS_MB + RESERVE_MB)) ] || die "内存不够：可用 ${avail} MB，需要 $((LIMITS_MB + RESERVE_MB)) MB" "截图发运维"
  rm -f "$TOPUP_DIR/state/stopped"
  compose up -d >> "$LOG" 2>&1 || die "启动失败" "截图发运维"
  wait_alive "$(cur_tag)" || die "3 分钟内健康检查没有通过" "sudo topup status 截图发运维"
  [ -n "$DRILL" ] || systemctl enable --now topup-update.timer topup-backup.timer topup-watch.timer >> "$LOG" 2>&1 || true
  ok "TopUP 已启动（版本 $(cur_tag | cut -c1-7)），自动更新、备份、检查已打开"
}

usage() {
  echo "用法（都要 sudo）："; sed -n 's/^#   \(sudo topup .*\)/  \1/p' "$0"
}

[ "$(id -u)" = 0 ] || { echo "✗ 请用 sudo 运行，例如：sudo topup status"; exit 1; }
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
  watch) cmd_watch ;;
  status) cmd_status ;;
  keys) cmd_keys ;;
  set-key) cmd_set_key "$@" ;;
  set) cmd_set "$@" ;;
  test-mail) cmd_test_mail ;;
  gen-operator) cmd_gen_operator ;;
  admin-token) cmd_admin_token ;;
  stop) cmd_stop ;;
  start) cmd_start ;;
  help | -h | --help) usage ;;
  *) echo "✗ 不认识 $cmd"; usage; exit 1 ;;
esac
