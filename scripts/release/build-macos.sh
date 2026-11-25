#!/usr/bin/env bash
# P7：macOS 本地/发布构建入口。
#
# 默认构建 universal（arm64 + x86_64）；若本机未安装 x86_64-apple-darwin，
# 自动回退到宿主架构并打印警告，保证本地未签名产物可复现。
#
# 打开 updater 产物签名（发布流水线）：
#   EMBER_WITH_UPDATER=1 TAURI_SIGNING_PRIVATE_KEY=... ./scripts/release/build-macos.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TARGET="${EMBER_BUILD_TARGET:-universal-apple-darwin}"
if [[ "$TARGET" == "universal-apple-darwin" ]]; then
  if ! rustup target list --installed 2>/dev/null | grep -qx 'x86_64-apple-darwin'; then
    HOST="$(rustc -vV | awk '/^host:/{print $2}')"
    echo "警告：未安装 x86_64-apple-darwin，回退到宿主架构 $HOST" >&2
    TARGET="$HOST"
  fi
fi

ARGS=(build --target "$TARGET")

if [[ "${EMBER_WITH_UPDATER:-0}" == "1" ]]; then
  if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
    echo "错误：EMBER_WITH_UPDATER=1 需要设置 TAURI_SIGNING_PRIVATE_KEY" >&2
    exit 2
  fi
  ARGS+=(--config '{"bundle":{"createUpdaterArtifacts":true}}')
  echo "已启用 updater 产物签名（createUpdaterArtifacts=true）"
fi

echo "构建目标：$TARGET"
pnpm tauri "${ARGS[@]}"

BUNDLE_DIR="${CARGO_TARGET_DIR:-src-tauri/target}/$TARGET/release/bundle"
echo
echo "产物目录：$BUNDLE_DIR"
if [[ -d "$BUNDLE_DIR" ]]; then
  find "$BUNDLE_DIR" -maxdepth 3 -type f \
    \( -name '*.app' -o -name '*.dmg' -o -name '*.tar.gz' -o -name '*.sig' \) -print
else
  echo "警告：未找到产物目录，请检查构建日志" >&2
  exit 1
fi
