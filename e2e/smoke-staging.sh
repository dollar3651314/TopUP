#!/usr/bin/env bash
# 测试环境（staging）的自动检查。由 GitHub Actions 执行（.github/workflows/staging-check.yml），也可以手动运行：
#   bash e2e/smoke-staging.sh <测试环境地址> [期望的提交前 7 位]
# 地址只从参数来（仓库密钥 STAGING_URL），脚本里不写、也不输出任何环境的地址。
set -uo pipefail
BASE="${1:?需要测试环境地址}"
WANT="${2:-}"
fail=0
check() { if eval "$2"; then echo "  ✅ $1"; else echo "  ❌ $1"; fail=1; fi; }
# 每个请求最多重试 2 次（只重试连接失败，不重试 HTTP 错误）
req() { curl -s --retry 2 --retry-connrefused --retry-all-errors --max-time 15 "$@"; }
code() { req -o /dev/null -w '%{http_code}' "$@"; }

if [ -n "$WANT" ]; then
  echo "等待测试环境部署提交 $WANT ……"
  for i in $(seq 1 60); do
    got=$(req "$BASE/api/health/" | sed -n 's/.*"commit":"\([0-9a-f]*\)".*/\1/p')
    [ "$got" = "$WANT" ] && break
    sleep 10
  done
  check "测试环境已部署提交 $WANT（当前：${got:-未知}）" "[ \"$got\" = \"$WANT\" ]"
fi

echo "测试环境检查（地址不输出）"
# 健康检查未通过时返回 503，curl 的重试会把几次的内容拼在一起，所以这里不重试 HTTP 错误，只重试连接失败
health=""; for i in 1 2 3; do health=$(curl -s --max-time 15 "$BASE/api/health/"); [ -n "$health" ] && break; sleep 2; done
echo "  健康检查的返回（只有是 / 否，不含配置值）：$health"
check "健康检查：ok 为 true" "echo '$health' | grep -q '\"ok\":true'"
check "健康检查：env 是 staging（不是生产）" "echo '$health' | grep -q '\"env\":\"staging\"'"
for p in / /docs/ /onboarding/ /merchant/ /admin/; do
  check "EN $p 返回 200" "[ \"\$(code '$BASE$p')\" = 200 ]"
done
for p in / /docs/ /onboarding/ /merchant/; do check "ZH /zh$p 返回 200" "[ \"\$(code '$BASE/zh$p')\" = 200 ]"; done
home=$(req "$BASE/")
check "页面有测试环境标识" "echo \"\$home\" | grep -q 'data-staging-banner'"
check "页面没有原型标识" "! echo \"\$home\" | grep -q 'data-prototype-banner'"
check "页面 noindex" "echo \"\$home\" | grep -q 'noindex'"
check "开户页是真实模式（不是原型）" "req '$BASE/onboarding/' | grep -q '&quot;prototype&quot;:false'"
check "响应头包含 CSP" "req -I '$BASE/' | grep -qi '^content-security-policy'"
check "未登录访问后台数据返回 401" "[ \"\$(code '$BASE/api/kyb/?g=admin&a=apps')\" = 401 ]"
check "无效的开户链接返回 404" "[ \"\$(code -H 'x-kyb-token: invalid' '$BASE/api/kyb/?g=onboarding&a=state')\" = 404 ]"
check "跨站请求返回 403" "[ \"\$(code -X POST -H 'content-type: application/json' -H 'origin: https://evil.example' -d '{}' '$BASE/api/kyb/?g=admin&a=invite')\" = 403 ]"
check "未知接口分组返回 404" "[ \"\$(code '$BASE/api/kyb/?g=nope&a=me')\" = 404 ]"
check "不存在的接口地址返回 404" "[ \"\$(code '$BASE/api/admin/me/')\" = 404 ]"
# 收付款
check "健康检查：收付款的数据库已配置" "echo '$health' | grep -q '\"db\":true'"
check "健康检查：连的是 Nile 测试网（不是主网）" "echo '$health' | grep -q '\"tron\":\"nile\"'"
check "健康检查：worker 5 分钟内运行过" "echo '$health' | grep -q '\"worker\":{\"age_s\":[0-9]*,\"ok\":true'"
check "付款页面 /pay/<订单号>/ 返回 200（改写规则生效）" "[ \"\$(code '$BASE/pay/ORD-20260101-00000000/')\" = 200 ]"
# 收付款接口初始化失败时返回 503 和原因代码（不含配置值），输出出来方便排查
echo "  收付款接口的返回：$(curl -s --max-time 15 "$BASE/api/merchant/?a=overview")"
check "开放 API：没有签名返回 401" "[ \"\$(code '$BASE/api/v1/balance/')\" = 401 ]"
check "商户后台接口：未登录返回 401" "[ \"\$(code '$BASE/api/merchant/?a=overview')\" = 401 ]"
check "运营后台收付款接口：未登录返回 401" "[ \"\$(code '$BASE/api/wallet/?a=status')\" = 401 ]"
check "定时任务没有对外的接口（由 worker 执行）" "[ \"\$(code '$BASE/api/tick/')\" = 404 ]"
check "付款查询：不存在的订单返回 404" "[ \"\$(code '$BASE/api/pay/?o=ORD-20260101-00000000')\" = 404 ]"
exit $fail
