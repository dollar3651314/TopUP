#!/usr/bin/env bash
# 核对 lib/ 下原样保存的 BitGo 和 OpenZeppelin 源码没有被改过（原样部署，不改一行）。
#   bash script/check-vendor.sh             只按 lib/SHA256SUMS 核对（CI 每次跑）
#   bash script/check-vendor.sh --upstream  另外从 GitHub 拉固定提交号的上游仓库，逐个文件比较（需要能访问 GitHub）
set -euo pipefail
cd "$(dirname "$0")/.."

BITGO_REPO=https://github.com/BitGo/eth-multisig-v4.git
BITGO_COMMIT=9566bcd47663a9ad7b71cf4c75466ccaa19fc7d7
OZ_REPO=https://github.com/OpenZeppelin/openzeppelin-contracts.git
OZ_TAG=v5.0.0
OZ_COMMIT=932fddf69a699a9a80fd2396fd1a2ab91cdda123

(cd lib && sha256sum --quiet -c SHA256SUMS)
# 清单以外不能多出文件
listed=$(awk '{print $2}' lib/SHA256SUMS | sort)
actual=$(cd lib && find eth-multisig-v4 openzeppelin-contracts -type f | sort)
if [ "$listed" != "$actual" ]; then
  echo "lib/ 下的文件和 SHA256SUMS 清单不一致" >&2
  diff <(echo "$listed") <(echo "$actual") >&2 || true
  exit 1
fi
echo "lib/ 原样源码：sha256 全部一致"

if [ "${1:-}" = "--upstream" ]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  git clone -q "$BITGO_REPO" "$tmp/bitgo"
  git -C "$tmp/bitgo" checkout -q "$BITGO_COMMIT"
  git clone -q --depth 1 --branch "$OZ_TAG" "$OZ_REPO" "$tmp/oz"
  test "$(git -C "$tmp/oz" rev-parse HEAD)" = "$OZ_COMMIT"
  for f in $(cd lib/eth-multisig-v4 && find . -type f); do cmp "lib/eth-multisig-v4/$f" "$tmp/bitgo/$f"; done
  for f in $(cd lib/openzeppelin-contracts && find . -type f); do cmp "lib/openzeppelin-contracts/$f" "$tmp/oz/$f"; done
  echo "和上游 BitGo $BITGO_COMMIT、OpenZeppelin $OZ_TAG（$OZ_COMMIT）逐字节一致"
fi
