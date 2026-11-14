#!/usr/bin/env bash
# 部署工具（deploy/kit/topup.sh）的演练：在开发机上用真实镜像、真实 Postgres / Redis / Nginx 把各种场景跑一遍。
# 用法（root，机器上有 Docker，80、443、18080 端口空着）：
#   docker build --build-arg APP_ENV=staging -t topup-drill-base .
#   sudo bash e2e/deploy-drill.sh topup-drill-base
# 和服务器的区别（演练模式 TOPUP_DRILL=1）：不装软件、不碰 topup 自己的 systemd 定时器、证书用自签名、镜像只用本机的；
# "别的项目"用一个假的 demo 项目（假 systemctl + 两个容器）代替，并放上 Ubuntu 自带的定时器（不能被当成别的项目）。
# 全部数据在一个临时目录里，结束后删除；不连任何外部服务，不需要任何密钥。
set -uo pipefail
BASE=${1:?需要基础镜像名（先 docker build）}
WORK=$(mktemp -d /tmp/topup-drill-XXXXXX)
REPO=${TOPUP_REPO:-$(cd "$(dirname "$0")/.." && pwd)}
IMG=topup-drill-local/topup
DOMAIN=topup.test
# 开发机的磁盘可能不到 5 GB 空闲：演练时只跳过磁盘这一项检查
export TOPUP_DRILL=1 TOPUP_DRILL_DISK_GB=${TOPUP_DRILL_DISK_GB:-20} TOPUP_DIR="$WORK/opt/topup" LE_DIR="$WORK/le" WEBROOT_DIR="$WORK/www" TOPUP_OTHERS_ROOT="$WORK/opt" TOPUP_IMAGE="$IMG"
# 开发机的出网代理不能用于访问本机（curl 会把 https 请求也交给代理）
export NO_PROXY='*' no_proxy='*'
pass=0; fail=0
check() { if eval "$2"; then echo "  ✅ $1"; pass=$((pass + 1)); else echo "  ❌ $1"; fail=$((fail + 1)); return 1; fi; }
T() { bash "$REPO/deploy/kit/topup.sh" "$@"; }
cleanup() {
  docker compose -p topup down -v --remove-orphans > /dev/null 2>&1
  docker rm -f demo-app demo-db topup-drill-pg topup-drill-redis > /dev/null 2>&1
  docker image rm -f $(docker image ls "$IMG" -q) > /dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "== 准备：三个版本的镜像（v1、v2 正常；v3 起不来），假的 systemctl 和 demo 项目"
v1=$(printf '1%.0s' $(seq 40)); v2=$(printf '2%.0s' $(seq 40)); v3=$(printf '3%.0s' $(seq 40))
mk() { printf 'FROM %s\nENV GIT_COMMIT=%s\nLABEL org.opencontainers.image.revision=%s\n%s\n' "$BASE" "$1" "$1" "${2:-}" | docker build -q -t "$IMG:build-$1" - > /dev/null; }
# 演练镜像里的部署工具包换成当前工作区的（不用重新构建基础镜像）
kitimg() { printf 'FROM %s\nUSER root\nRUN rm -rf /topup-kit\nCOPY deploy /topup-kit\nCOPY .env.example /topup-kit/kit/app.env.example\nUSER node\n' "$IMG:build-$1" | docker build -q -t "$IMG:kit-$1" -f - "$REPO" > /dev/null; }
mk "$v1"; mk "$v2"; mk "$v3" 'CMD ["node", "-e", "process.exit(1)"]'
for v in "$v1" "$v2" "$v3"; do kitimg "$v"; done
stage() { docker tag "$IMG:kit-$1" "$IMG:staging"; }

mkdir -p "$WORK/bin" "$WORK/units" "$WORK/opt/demo"
cat > "$WORK/bin/systemctl" << 'EOF'
#!/usr/bin/env bash
# 假的 systemctl：单元在 $DRILL_UNITS 下（名字 → ExecStart），调用记进 calls.log
echo "$*" >> "$DRILL_UNITS/calls.log"
case "$1" in
  list-unit-files) for f in "$DRILL_UNITS"/*.timer; do echo "$(basename "$f") enabled enabled"; done ;;
  show) cat "$DRILL_UNITS/${@: -1}" 2> /dev/null ;;
  is-active) exit 3 ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$WORK/bin/systemctl"
export PATH="$WORK/bin:$PATH" DRILL_UNITS="$WORK/units"
# Ubuntu 自带的定时器（不能被当成别的项目）
for u in dpkg-db-backup apt-daily logrotate; do : > "$WORK/units/$u.timer"; echo "/usr/lib/$u" > "$WORK/units/$u.service"; done
: > "$WORK/units/demo-deploy.timer"; echo "{ path=$WORK/opt/demo/deploy.sh ; argv[]=$WORK/opt/demo/deploy.sh }" > "$WORK/units/demo-deploy.service"
cat > "$WORK/opt/demo/backup.sh" << EOF
# demo 项目的备份：记下备份时哪些容器在运行（应该只有数据库）
docker ps --format '{{.Names}}' --filter label=com.docker.compose.project=demo | sort | tr '\n' ' ' > "$WORK/opt/demo/backup-saw"
EOF
docker run -d --name demo-db --label com.docker.compose.project=demo redis:7 > /dev/null
docker run -d --name demo-app --label com.docker.compose.project=demo -p 80:80 -p 443:443 nginx:1.27-alpine > /dev/null

echo "== 场景 1：第一次部署（demo 项目占着 80、443）"
stage "$v1"
T install "$DOMAIN" ops@example.com > "$WORK/s1.txt" 2>&1; rc=$?
cat "$WORK/s1.txt"
check "一条命令完成（退出码 0）" "[ $rc = 0 ]" || { echo "第一次部署失败，后面的场景不跑了"; exit 1; }
check "每步都有 ✓（8 步）" "[ \$(grep -c '^✓ 第' '$WORK/s1.txt') = 8 ]"
check "只把 demo 当成别的项目，没碰系统自带的定时器" "! grep -qE 'dpkg-db-backup|apt-daily|logrotate' '$WORK/units/calls.log' && grep -q 'disable --now demo-deploy.timer' '$WORK/units/calls.log'"
check "demo 先停应用、再备份（备份时只剩数据库在运行）、最后停数据库" "[ \"\$(cat '$WORK/opt/demo/backup-saw')\" = 'demo-db ' ] && [ -z \"\$(docker ps -q --filter label=com.docker.compose.project=demo)\" ]"
check "健康检查：提交号 = v1、env = staging" "curl -s http://127.0.0.1:18080/api/health/ | jq -e '.commit == \"${v1:0:7}\" and .env == \"staging\"' > /dev/null"
check "摘要不含任何口令和主密钥" "! grep -qE \"\$(sed -n 's/^\\(POSTGRES_PASSWORD\\|REDIS_PASSWORD\\)=//p' '$TOPUP_DIR/deploy.env' | paste -sd'|')|\$(sed -n 's/^APP_SECRET=//p' '$TOPUP_DIR/.env')\" '$WORK/s1.txt' $TOPUP_DIR/logs/*.log"
check ".env、deploy.env 权限 600" "[ \$(stat -c %a '$TOPUP_DIR/.env') = 600 ] && [ \$(stat -c %a '$TOPUP_DIR/deploy.env') = 600 ]"
check ".env 里没有 GIT_COMMIT、DATABASE_URL 等由部署决定的变量" "! grep -qE '^(GIT_COMMIT|DATABASE_URL|REDIS_URL|TRUST_PROXY|PUBLIC_URL)=' '$TOPUP_DIR/.env'"
check "容器内存上限 = 交换上限（不用交换分区）" "for c in postgres redis web worker nginx; do [ \"\$(docker inspect -f '{{.HostConfig.Memory}}' topup-\$c-1)\" = \"\$(docker inspect -f '{{.HostConfig.MemorySwap}}' topup-\$c-1)\" ] || exit 1; done"
check "nginx -t（nginx:1.27-alpine，替换后的配置）" "docker exec topup-nginx-1 nginx -t > /dev/null 2>&1"

echo "== 场景 2：同一条命令再运行一次（全部跳过）"
T install "$DOMAIN" ops@example.com > "$WORK/s2.txt" 2>&1; rc=$?
check "退出码 0，证书和启动都跳过" "[ $rc = 0 ] && grep -q '第 6 步：HTTPS 证书——已有，跳过' '$WORK/s2.txt' && grep -q '已经在运行，跳过' '$WORK/s2.txt'"
check "口令没有被重新生成" "[ \$(grep -c '^POSTGRES_PASSWORD=' '$TOPUP_DIR/deploy.env') = 1 ]"

echo "== 场景 3：经 Nginx 访问；真实 IP（访客伪造 X-Real-IP / X-Forwarded-For 不起作用）"
H() { curl -sk --resolve "$DOMAIN:443:127.0.0.1" --resolve "$DOMAIN:80:127.0.0.1" "$@"; }
check "http 跳 https" "[ \"\$(H -o /dev/null -w '%{http_code} %{redirect_url}' http://$DOMAIN/x/)\" = '301 https://$DOMAIN/x/' ]"
check "https 首页 200、有测试环境标识" "H https://$DOMAIN/ | grep -q data-staging-banner"
check "用 IP 直接访问 443 被断开（不暴露证书）" "! curl -sk --max-time 5 https://127.0.0.1/ -o /dev/null"
check "/__fake/ 在服务器上 404" "[ \"\$(H -o /dev/null -w '%{http_code}' https://$DOMAIN/__fake/tick/)\" = 404 ]"
check "HSTS 响应头" "H -I https://$DOMAIN/ | grep -qi '^strict-transport-security'"
spoof() { # $1 = 地址；40 个并发请求，每个带不同的伪造 IP；输出应用返回 rate_limited 的个数
  for i in $(seq 1 40); do curl -sk --resolve "$DOMAIN:443:127.0.0.1" -H "X-Real-IP: 10.9.$i.1" -H "X-Forwarded-For: 10.8.$i.1" "$1/api/pay/?o=ORD-20260101-00000000" & done | grep -o rate_limited | wc -l
}
sleep 1; n=$(spoof "https://$DOMAIN"); echo "    经 Nginx：40 个请求里 $n 个被应用按 IP 限流"
check "经 Nginx：伪造的 IP 不起作用，同一个真实 IP 超过每秒 20 次被限流" "[ $n -gt 0 ]"
sleep 2; n=$(spoof "http://127.0.0.1:18080"); echo "    对照（绕过 Nginx 直连本机 18080）：$n 个被限流"
check "对照：绕过 Nginx 时应用会相信请求头（所以 web 端口只能绑在 127.0.0.1）" "[ $n = 0 ] && docker port topup-web-1 | grep -q '^8080/tcp -> 127.0.0.1:18080$'"

echo "== 场景 4：填密钥（名字写错、值不对、正确）"
out=$(TOPUP_DRILL_INPUT=x T set-key sweep_operator_key 2>&1); check "小写变量名：提示正确写法" "grep -q '要全部大写：SWEEP_OPERATOR_KEY' <<< \"\$out\""
out=$(TOPUP_DRILL_INPUT=x T set-key NOPE 2>&1); check "不认识的变量名：列出能填的" "grep -q '不认识变量名' <<< \"\$out\""
out=$(TOPUP_DRILL_INPUT='0xabc' T set-key SWEEP_OPERATOR_KEY 2>&1); check "私钥格式不对：拒绝、什么都没改" "grep -q '64 位十六进制' <<< \"\$out\" && [ -z \"\$(sed -n 's/^SWEEP_OPERATOR_KEY=//p' '$TOPUP_DIR/.env')\" ]"
out=$(TOPUP_DRILL_INPUT='a b' T set-key TRONGRID_API_KEY 2>&1); check "值里有空格：拒绝" "grep -q '空格' <<< \"\$out\""
k=$(openssl rand -hex 32)
out=$(TOPUP_DRILL_INPUT="$k" T set-key SWEEP_OPERATOR_KEY 2>&1); echo "$out" | sed 's/^/    /'
check "正确的私钥：写入、自动生效、健康检查 wallet.operator = true；屏幕和日志里没有这个值" "grep -q '已设置 SWEEP_OPERATOR_KEY' <<< \"\$out\" && curl -s http://127.0.0.1:18080/api/health/ | jq -e '.wallet.operator == true' > /dev/null && ! grep -rq '$k' <<< \"\$out\" && ! grep -rq '$k' '$TOPUP_DIR/logs'"
out=$(T set MAIL_TO ops@example.com 2>&1); check "普通设置 set MAIL_TO" "grep -q '已设置 MAIL_TO=ops@example.com' <<< \"\$out\""
tok=$(T admin-token 2>/dev/null); check "admin-token 显示的是 .env 里的初始化口令，日志里没有它" "[ -n \"\$tok\" ] && [ \"\$tok\" = \"\$(sed -n 's/^ADMIN_SETUP_TOKEN=//p' '$TOPUP_DIR/.env')\" ] && ! grep -rq \"\$tok\" '$TOPUP_DIR/logs'"
out=$(T keys 2>&1); check "keys 只显示名字和有没有填" "grep -q '已填  SWEEP_OPERATOR_KEY' <<< \"\$out\" && ! grep -q '$k' <<< \"\$out\""

out=$(T gen-operator 2>&1); echo "$out" | sed 's/^/    /'
tk=$(sed -n 's/^SWEEP_OPERATOR_KEY_TRON=//p' "$TOPUP_DIR/.env")
check "gen-operator：ETH/BSC 的已有、不重新生成；TRON 的新生成（64 位十六进制），只显示地址；健康检查 operator_tron = true" "grep -q 'SWEEP_OPERATOR_KEY 已经有了' <<< \"\$out\" && grep -qE '发起账户地址：0x[0-9a-fA-F]{40}$' <<< \"\$out\" && grep -qE '发起账户地址：T[1-9A-HJ-NP-Za-km-z]{33}$' <<< \"\$out\" && grep -qE '^0x[0-9a-f]{64}$' <<< '$tk' && ! grep -q '${tk#0x}' <<< \"\$out\" && ! grep -rq '${tk#0x}' '$TOPUP_DIR/logs' && curl -s http://127.0.0.1:18080/api/health/ | jq -e '.wallet.operator_tron == true' > /dev/null"
out2=$(T gen-operator 2>&1); check "gen-operator 再运行：两把都不重新生成、地址不变" "[ \"\$(grep -c '已经有了' <<< \"\$out2\")\" = 2 ] && [ \"\$(grep 地址 <<< \"\$out\")\" = \"\$(grep 地址 <<< \"\$out2\")\" ]"

echo "== 场景 5：自动更新到 v2（成功）"
stage "$v2"; T update; rc=$?
check "更新成功，健康检查提交号 = v2，上一个版本记为 v1" "[ $rc = 0 ] && curl -s http://127.0.0.1:18080/api/health/ | jq -e '.commit == \"${v2:0:7}\"' > /dev/null && [ \"\$(cat '$TOPUP_DIR/state/previous')\" = '$v1' ]"
check "更新前自动备份了一份（加密）" "ls '$TOPUP_DIR'/backup/topup-*-before-${v2:0:7}.tar.age > /dev/null 2>&1"
check "数据还在（更新前填的发起账户私钥）" "curl -s http://127.0.0.1:18080/api/health/ | jq -e '.wallet.operator == true' > /dev/null"

echo "== 场景 6：自动更新到 v3（起不来 → 自动换回 v2、记下不再重试）"
stage "$v3"; T update; rc=$?
check "退出码非 0，已换回 v2" "[ $rc != 0 ] && curl -s http://127.0.0.1:18080/api/health/ | jq -e '.commit == \"${v2:0:7}\"' > /dev/null"
check "v3 记进 state/skip（不再自动重试）" "[ \"\$(cat '$TOPUP_DIR/state/skip')\" = '$v3' ]"
T update; check "再运行 update：跳过 v3，什么都不做" "[ \$? = 0 ] && curl -s http://127.0.0.1:18080/api/health/ | jq -e '.commit == \"${v2:0:7}\"' > /dev/null"
out=$(T status 2>&1); check "status 报出被跳过的版本，每 5 分钟检查也算一个问题" "grep -q '不再重试：${v3:0:7}' <<< \"\$out\" && grep -q '更新失败、不再重试' <<< \"\$out\""
out=$(T retry 2>&1); check "retry 清掉记录" "grep -q '已清掉' <<< \"\$out\" && [ ! -f '$TOPUP_DIR/state/skip' ]"
stage "$v2"

echo "== 场景 7：手动回滚到 v1，再 retry 回到 v2"
out=$(T rollback 2>&1); echo "$out" | sed 's/^/    /'
check "回滚到 v1，v2 不再自动重试" "curl -s http://127.0.0.1:18080/api/health/ | jq -e '.commit == \"${v1:0:7}\"' > /dev/null && [ \"\$(cat '$TOPUP_DIR/state/skip')\" = '$v2' ]"
T retry > /dev/null; T update
check "retry 后自动更新回 v2" "curl -s http://127.0.0.1:18080/api/health/ | jq -e '.commit == \"${v2:0:7}\"' > /dev/null"

echo "== 场景 8：备份和恢复演练（默认只在本机、加密；异地默认关）"
docker exec topup-redis-1 sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning set drill:key 1' > /dev/null
echo hello > "$TOPUP_DIR/data/blobs/drill.txt"
out=$(T backup 2>&1); rc=$?; echo "$out" | sed 's/^/    /'
check "备份成功；只在本机、加密；异地默认关、不报错" "[ $rc = 0 ] && grep -q '✓ 备份：本机已加密' <<< \"\$out\" && grep -q '异地备份：关' <<< \"\$out\" && jq -e '.local == \"encrypted\" and .r2 == \"off\"' '$TOPUP_DIR/state/last-backup.json' > /dev/null"
f=$(ls -1t "$TOPUP_DIR"/backup/topup-*.tar.age | head -1)
check "备份文件是 age 密文、权限 600；目录 700；本机密钥 600；没有明文 .tar 留在磁盘上" "head -c 21 '$f' | grep -q 'age-encryption.org/v1' && [ \$(stat -c %a '$f') = 600 ] && [ \$(stat -c %a '$TOPUP_DIR/backup') = 700 ] && [ \$(stat -c %a '$TOPUP_DIR/state/backup-identity') = 600 ] && [ -z \"\$(find '$TOPUP_DIR/backup' -name '*.tar' -o -name '.work-*')\" ]"
check "密文里没有主密钥的明文" "! grep -aq \"\$(sed -n 's/^APP_SECRET=//p' '$TOPUP_DIR/.env')\" '$f'"
out=$(T restore-drill 2>&1); echo "$out" | sed 's/^/    /'
check "恢复演练（本机解密）通过（表一样、Redis 有键、开户文件、主密钥）" "grep -q '恢复演练通过' <<< \"\$out\" && grep -q '开户文件：1 个' <<< \"\$out\" && grep -q '已解密到临时目录' <<< \"\$out\""
check "演练的临时容器、解密出的临时文件已删除，正在运行的没动" "[ -z \"\$(docker ps -aq --filter name=topup-drill-)\" ] && [ -z \"\$(find '$TOPUP_DIR/backup' -name '.drill-*')\" ] && curl -s http://127.0.0.1:18080/api/health/ | jq -e '.db == true' > /dev/null"
# 管理员生成过备份公钥（异地备份用）时：同一份密文他的私钥也能解
age-keygen -o "$WORK/age.key" 2> /dev/null
VAL=$(sed -n 's/^# public key: //p' "$WORK/age.key"); sed -i "s/^BACKUP_AGE_RECIPIENT=.*/BACKUP_AGE_RECIPIENT=$VAL/" "$TOPUP_DIR/deploy.env"
T backup > /dev/null 2>&1; f=$(ls -1t "$TOPUP_DIR"/backup/topup-*.tar.age | head -1)
check "填了管理员公钥后：管理员私钥和本机密钥都能解开同一份，内容一致，里面有两个配置文件" "age -d -i '$WORK/age.key' '$f' > '$WORK/a.tar' && age -d -i '$TOPUP_DIR/state/backup-identity' '$f' | cmp -s - '$WORK/a.tar' && tar -tf '$WORK/a.tar' | grep -q '^./app.env$' && tar -tf '$WORK/a.tar' | grep -q '^./deploy.env$'"
out=$(T set BACKUP_OFFSITE yes 2>&1); check "BACKUP_OFFSITE 只认 off / r2" "grep -q '只能是 off' <<< \"\$out\" && grep -q '^BACKUP_OFFSITE=off$' '$TOPUP_DIR/deploy.env'"
T set BACKUP_OFFSITE r2 > /dev/null 2>&1
out=$(T backup 2>&1); rc=$?
check "打开异地但 R2 没配：本机照样备份、不报错，只提示" "[ $rc = 0 ] && grep -q '打开了但没配好' <<< \"\$out\" && jq -e '.r2 == \"not_configured\"' '$TOPUP_DIR/state/last-backup.json' > /dev/null"
T set BACKUP_OFFSITE off > /dev/null 2>&1
# 保留：7 天以上的删；合计超上限从最旧删；至少留 3 份；旧版本的明文 .tar 删掉
for i in 1 2 3; do head -c 1024 /dev/urandom > "$TOPUP_DIR/backup/topup-20000101-00000$i-old.tar.age"; touch -d '10 days ago' "$TOPUP_DIR/backup/topup-20000101-00000$i-old.tar.age"; done
: > "$TOPUP_DIR/backup/topup-20000101-000000-plain.tar"
T backup > /dev/null 2>&1
check "超过 7 天的删掉、旧的明文 .tar 删掉，新的都在" "[ -z \"\$(ls '$TOPUP_DIR'/backup/topup-20000101-* 2> /dev/null)\" ] && [ \$(ls '$TOPUP_DIR'/backup/topup-*.tar.age | wc -l) -ge 3 ]"
TOPUP_BACKUP_MAX_MB=0 T backup > /dev/null 2>&1
check "合计超过上限：从最旧的删，至少留最新 3 份" "[ \$(ls '$TOPUP_DIR'/backup/topup-*.tar.age | wc -l) = 3 ]"
echo "    本机备份大小：$(ls -l "$TOPUP_DIR"/backup/topup-*.tar.age | awk '{print $5}' | tr '\n' ' ')字节"

echo "== 场景 9：每 5 分钟检查（状态变化才发邮件）"
rm -f "$TOPUP_DIR/state/watch"
T watch; first=$(cat "$TOPUP_DIR/state/watch" 2> /dev/null)
echo "    第一次检查发现：$(tr '\n' ';' <<< "$first")"
check "第一次：发现问题（邮件、节点 Key 没配），尝试发邮件（没配邮件时只记日志）" "[ -n \"\$first\" ] && grep -rq 'mail_not_configured' '$TOPUP_DIR/logs'"
n1=$(ls "$TOPUP_DIR"/logs/watch-*.log | wc -l); T watch; n2=$(ls "$TOPUP_DIR"/logs/watch-*.log | wc -l)
check "第二次：问题没变，不再发（不留日志）" "[ $n1 = $n2 ]"

echo "== 场景 10：内存不够时不启动；stop / start"
out=$(T stop 2>&1); echo "$out" | sed 's/^/    /'
check "stop：定时器 → 应用 → 备份 → 数据库，80、443 空出" "grep -q '第 3 步' <<< \"\$out\" && [ -z \"\$(docker ps -q --filter label=com.docker.compose.project=topup)\" ] && ls '$TOPUP_DIR'/backup/topup-*-before-stop.tar.age > /dev/null"
T update; check "停下后自动更新不会把它拉起来" "[ -z \"\$(docker ps -q --filter label=com.docker.compose.project=topup)\" ]"
out=$(TOPUP_DRILL_MEM_MB=900 T start 2>&1); check "可用内存 900 MB：不启动，说明需要多少" "grep -q '内存不够：可用 900 MB，需要 980 MB' <<< \"\$out\" && [ -z \"\$(docker ps -q --filter label=com.docker.compose.project=topup)\" ]"
out=$(T start 2>&1); check "start：健康检查通过，版本 = v2" "grep -q 'TopUP 已启动' <<< \"\$out\" && curl -s http://127.0.0.1:18080/api/health/ | jq -e '.commit == \"${v2:0:7}\"' > /dev/null"
docker stats --no-stream --format '    {{.Name}} {{.MemUsage}}' $(docker ps -q --filter label=com.docker.compose.project=topup)

echo "== 场景 11：新版本\"没活\"也要换回（web 初始化失败；新 worker 不扫链但旧 worker 的扫链时间还新鲜）"
# vA：web 的数据库地址指向不存在的端口（db / storage / secret 照样是 true，健康检查里没有 wallet），worker 正常
# vB：worker 容器在运行但不启动 worker（旧 worker 留下的扫链时间还在 5 分钟内）
vA=$(printf 'a%.0s' $(seq 40)); vB=$(printf 'b%.0s' $(seq 40))
mk "$vA" 'CMD ["sh", "-c", "DATABASE_URL=postgres://topup:x@127.0.0.1:1/topup exec node server/web.js"]'
mk "$vB" 'ENTRYPOINT ["sh", "-c", "case \"$*\" in *worker.js*) echo worker-disabled; exec sleep 3600;; esac; exec \"$@\"", "sh"]
CMD ["node", "server/web.js"]'
kitimg "$vA"; kitimg "$vB"
h() { curl -s http://127.0.0.1:18080/api/health/; }
fresh() { for i in $(seq 1 30); do h | jq -e '.worker.ok == true and .worker.age_s <= 20' > /dev/null && return 0; sleep 2; done; return 1; }
fresh; stage "$vB"; TOPUP_WAIT_S=90 T update > "$WORK/s11b.txt" 2>&1; rc=$?
check "vB（新 worker 不扫链）：判为没活，换回 v2，记进 state/skip" "[ $rc != 0 ] && h | jq -e '.commit == \"${v2:0:7}\"' > /dev/null && [ \"\$(cat '$TOPUP_DIR/state/skip')\" = '$vB' ]"
T retry > /dev/null 2>&1; fresh; stage "$vA"; TOPUP_WAIT_S=90 T update > "$WORK/s11a.txt" 2>&1; rc=$?
check "vA（web 收付款初始化失败）：判为没活，换回 v2，记进 state/skip" "[ $rc != 0 ] && h | jq -e '.commit == \"${v2:0:7}\"' > /dev/null && [ \"\$(cat '$TOPUP_DIR/state/skip')\" = '$vA' ]"
T retry > /dev/null 2>&1; stage "$v2"

echo
echo "演练结果：通过 $pass，失败 $fail"
[ "$fail" = 0 ]
