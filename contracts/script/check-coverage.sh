#!/usr/bin/env bash
# 合约覆盖率关卡（技术方案：行、语句、分支、函数 100%）。用法：FOUNDRY_PROFILE=payout bash script/check-coverage.sh src/BatchPayout.sol [更多文件]
# 跑 forge coverage 出 lcov，逐个文件核对 LF=LH（行）、FNF=FNH（函数）、BRF=BRH（分支）；语句覆盖 forge 只在摘要里给，一并核对摘要那一行是 100.00%。
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$#" -ge 1 ] || { echo "用法：$0 <合约源文件>..." >&2; exit 2; }
out="lcov-${FOUNDRY_PROFILE:-default}.info"
# 不变量测试跑覆盖率很慢，覆盖率只用单元和模糊测试
summary=$(forge coverage --report lcov --report summary --report-file "$out" --no-match-test 'invariant_' --ir-minimum 2>/dev/null || forge coverage --report lcov --report summary --report-file "$out" --no-match-test 'invariant_')
[ -f "$out" ] || { [ -f lcov.info ] && mv lcov.info "$out"; }
fail=0
for f in "$@"; do
  block=$(awk -v f="SF:$f" '$0==f{on=1} on{print} on&&/^end_of_record/{exit}' "$out")
  [ -n "$block" ] || { echo "覆盖率报告里没有 $f" >&2; fail=1; continue; }
  for pair in "LF LH 行" "FNF FNH 函数" "BRF BRH 分支"; do
    set -- $pair
    total=$(printf '%s\n' "$block" | awk -F: -v k="$1" '$1==k{print $2}')
    hit=$(printf '%s\n' "$block" | awk -F: -v k="$2" '$1==k{print $2}')
    if [ "${total:-0}" != "${hit:-0}" ]; then echo "$f：$3覆盖 $hit / $total，不是 100%" >&2; fail=1; else echo "$f：$3 $hit / $total"; fi
  done
  line=$(printf '%s\n' "$summary" | grep -F "$f" || true)
  if [ -z "$line" ] || [ "$(printf '%s' "$line" | grep -o '100.00%' | wc -l)" -lt 4 ]; then echo "$f：摘要不是四项 100%：$line" >&2; fail=1; fi
done
exit $fail
