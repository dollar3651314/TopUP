#!/usr/bin/env bash
# 旧入口（保留给还在用它的人）：测试环境的冒烟检查，等同于 bash e2e/smoke.sh <地址> <提交前 7 位> staging。
#   bash e2e/smoke-staging.sh <测试环境地址> [期望的提交前 7 位]
exec bash "$(dirname "$0")/smoke.sh" "${1:?需要测试环境地址}" "${2:--}" staging
