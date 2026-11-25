#!/usr/bin/env bash
# P7：公证 .app（需先完成 sign.sh）并 stapling。
# 凭据只从环境变量读取，不写入仓库。
#
# 用法：
#   APPLE_ID=... APPLE_TEAM_ID=... APPLE_APP_PASSWORD=... ./scripts/release/notarize.sh path/to/Ember.app
set -euo pipefail

APP="${1:-}"
if [[ -z "$APP" || ! -d "$APP" ]]; then
  echo "用法：$0 path/to/Ember.app" >&2
  exit 64
fi

: "${APPLE_ID:?需要 APPLE_ID}"
: "${APPLE_TEAM_ID:?需要 APPLE_TEAM_ID}"
: "${APPLE_APP_PASSWORD:?需要 APPLE_APP_PASSWORD（App 专用密码）}"

codesign --verify --strict "$APP" >/dev/null 2>&1 || {
  echo "错误：$APP 未签名或签名无效，先运行 scripts/release/sign.sh" >&2
  exit 2
}

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
ZIP="$WORK_DIR/$(basename "$APP").zip"

echo "打包公证材料…"
ditto -c -k --keepParent "$APP" "$ZIP"

echo "提交公证（等待结果）…"
xcrun notarytool submit "$ZIP" \
  --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_PASSWORD" \
  --wait

echo "装订公证票据…"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
echo "公证完成：$APP"
