#!/usr/bin/env bash
# P7：对 .app 做 Developer ID 签名（hardened runtime + 可信时间戳）。
# 本机 security find-identity 为 0 个身份时不伪造成功：直接 exit 2 并打印阻塞原因。
#
# 用法：APPLE_SIGNING_IDENTITY="Developer ID Application: ..." ./scripts/release/sign.sh path/to/Ember.app
set -euo pipefail

APP="${1:-}"
if [[ -z "$APP" || ! -d "$APP" ]]; then
  echo "用法：$0 path/to/Ember.app" >&2
  exit 64
fi

IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/"/{print $2; exit}')"
fi
if [[ -z "$IDENTITY" ]]; then
  echo "阻塞：本机没有可用的代码签名身份（security find-identity 为 0 个）。" >&2
  echo "需先安装 Developer ID Application 证书，或设置 APPLE_SIGNING_IDENTITY。" >&2
  exit 2
fi

echo "签名身份：$IDENTITY"
codesign --force --deep --options runtime --timestamp --sign "$IDENTITY" "$APP"
codesign --verify --strict --verbose=2 "$APP"
echo "签名完成：$APP"
