#!/usr/bin/env bash
# 服务器的冒烟检查（测试环境和生产共用）。由 GitHub Actions 执行（ci.yml 的 staging-smoke、production-smoke，手动的 staging-check.yml），也可以手动运行：
#   bash e2e/smoke.sh <地址> <期望的提交前 7 位，写 - 不等版本> <环境 production|staging>
# 先等服务器换成这个提交（健康检查返回的 commit；最多等 SMOKE_WAIT_S 秒，默认 600），再逐项检查，每项一行 ✅ / ❌，有 ❌ 退出码 1。
# 地址只从参数来（仓库密钥），脚本里不写、也不输出任何环境的地址。
set -uo pipefail
BASE="${1:-}"
WANT="${2:-}"
ENV="${3:-}"
[ -n "$BASE" ] && [ -n "$WANT" ] || { echo "用法：bash e2e/smoke.sh <地址> <提交前 7 位或 -> <production|staging>"; exit 2; }
case "$ENV" in
  production) NAME=生产; NET=mainnet ;;
  staging) NAME=测试环境; NET=nile ;;
  *) echo "第三个参数（环境）只能是 production 或 staging"; exit 2 ;;
esac
[ "$WANT" = - ] && WANT=""
WAIT_S=${SMOKE_WAIT_S:-600}
BASE=${BASE%/}
fail=0
# 每项一行：check "说明" 命令…（命令成功 = ✅）
check() { local d=$1; shift; if "$@"; then echo "  ✅ $d"; else echo "  ❌ $d"; fail=1; fi; }
has() { grep -q -- "$2" <<< "$1"; }
lacks() { ! grep -q -- "$2" <<< "$1"; }
eq() { [ "$1" = "$2" ]; }
# 每个请求最多重试 2 次（只重试连接失败，不重试 HTTP 错误）
req() { curl -s --retry 2 --retry-connrefused --retry-all-errors --max-time 15 "$@"; }
code() { req -o /dev/null -w '%{http_code}' "$@"; }
commit_of() { sed -n 's/.*"commit":"\([0-9a-f]*\)".*/\1/p' <<< "$1"; }

if [ -n "$WANT" ]; then
  echo "等待${NAME}部署提交 $WANT（最多 ${WAIT_S} 秒）……"
  end=$((SECONDS + WAIT_S)); got=""
  while :; do
    got=$(commit_of "$(curl -s --max-time 15 "$BASE/api/health/")")
    [ "$got" = "$WANT" ] && break
    [ "$SECONDS" -lt "$end" ] || break
    sleep "$(( WAIT_S < 10 ? 1 : 10 ))"
  done
  check "${NAME}已部署提交 $WANT（当前：${got:-未知}）" eq "$got" "$WANT"
fi

echo "${NAME}检查（地址不输出）"
# 健康检查未通过时返回 503，curl 的重试会把几次的内容拼在一起，所以这里不重试 HTTP 错误，只重试连接失败
health=""; for i in 1 2 3; do health=$(curl -s --max-time 15 "$BASE/api/health/"); [ -n "$health" ] && break; sleep 2; done
echo "  健康检查的返回（只有是 / 否，不含配置值）：$health"
check "健康检查：ok 为 true" has "$health" '"ok":true'
check "健康检查：env 是 $ENV" has "$health" "\"env\":\"$ENV\""
for p in / /docs/ /onboarding/ /merchant/ /admin/; do check "EN $p 返回 200" eq "$(code "$BASE$p")" 200; done
for p in / /docs/ /onboarding/ /merchant/; do check "ZH /zh$p 返回 200" eq "$(code "$BASE/zh$p")" 200; done
home=$(req "$BASE/")
if [ "$ENV" = staging ]; then
  check "页面有测试环境标识" has "$home" 'data-staging-banner'
  check "页面 noindex" has "$home" 'noindex'
else
  check "页面没有测试环境标识" lacks "$home" 'data-staging-banner'
  for p in /docs/ /zh/; do check "页面 $p 没有测试环境标识" lacks "$(req "$BASE$p")" 'data-staging-banner'; done
  check "健康检查里没有测试环境才有的两项（test_admin、test_merchant_ip_bypass）" lacks "$health" '"test_'
fi
check "页面没有原型标识" lacks "$home" 'data-prototype-banner'
check "开户页是真实模式（不是原型）" has "$(req "$BASE/onboarding/")" '&quot;prototype&quot;:false'
check "响应头包含 CSP（真正生效的 Content-Security-Policy，不算 Report-Only）" grep -Eiq '^content-security-policy:' <<< "$(req -I "$BASE/")"
check "未登录访问后台数据返回 401" eq "$(code "$BASE/api/kyb/?g=admin&a=apps")" 401
check "无效的开户链接返回 404" eq "$(code -H 'x-kyb-token: invalid' "$BASE/api/kyb/?g=onboarding&a=state")" 404
check "跨站请求返回 403" eq "$(code -X POST -H 'content-type: application/json' -H 'origin: https://evil.example' -d '{}' "$BASE/api/kyb/?g=admin&a=invite")" 403
check "未知接口分组返回 404" eq "$(code "$BASE/api/kyb/?g=nope&a=me")" 404
check "不存在的接口地址返回 404" eq "$(code "$BASE/api/admin/me/")" 404
# 收付款
check "健康检查：收付款的数据库已配置" has "$health" '"db":true'
check "健康检查：TRON 连的是 $NET" has "$health" "\"tron\":\"$NET\""
check "健康检查：worker 5 分钟内运行过" grep -Eq '"worker":\{"age_s":[0-9]+,"ok":true' <<< "$health"
check "付款页面 /pay/<订单号>/ 返回 200（改写规则生效）" eq "$(code "$BASE/pay/ORD-20260101-00000000/")" 200
# 收付款接口初始化失败时返回 503 和原因代码（不含配置值），输出出来方便排查
echo "  收付款接口的返回：$(curl -s --max-time 15 "$BASE/api/merchant/?a=overview")"
check "开放 API：没有签名返回 401" eq "$(code "$BASE/api/v1/balance/")" 401
check "商户后台接口：未登录返回 401" eq "$(code "$BASE/api/merchant/?a=overview")" 401
check "运营后台收付款接口：未登录返回 401" eq "$(code "$BASE/api/wallet/?a=status")" 401
check "定时任务没有对外的接口（由 worker 执行）" eq "$(code "$BASE/api/tick/")" 404
check "付款查询：不存在的订单返回 404" eq "$(code "$BASE/api/pay/?o=ORD-20260101-00000000")" 404
exit $fail
