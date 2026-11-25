#!/usr/bin/env bash
# P7：产物校验。逐项执行并汇总，任一失败以非零退出；未签名产物属预期失败（exit 1）。
#
# 用法：./scripts/release/verify-artifact.sh path/to/Ember.app|Ember.dmg
set -uo pipefail

ARTIFACT="${1:-}"
if [[ -z "$ARTIFACT" || ! -e "$ARTIFACT" ]]; then
  echo "用法：$0 path/to/Ember.app|Ember.dmg" >&2
  exit 64
fi

FAILURES=0
run() {
  local label="$1"
  shift
  echo "—— $label"
  if "$@"; then
    echo "   通过"
  else
    echo "   失败（exit $?）"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "产物：$ARTIFACT"
shasum -a 256 "$ARTIFACT"

case "$ARTIFACT" in
  *.app)
    run "codesign 严格校验" codesign --verify --strict --verbose=2 "$ARTIFACT"
    run "Gatekeeper 评估" spctl -a -vv "$ARTIFACT"
    run "公证票据校验" xcrun stapler validate "$ARTIFACT"
    ;;
  *.dmg)
    run "DMG 完整性" hdiutil verify "$ARTIFACT"
    run "codesign 严格校验" codesign --verify --strict --verbose=2 "$ARTIFACT"
    run "Gatekeeper 评估" spctl -a -vv "$ARTIFACT"
    ;;
  *)
    echo "未知产物类型：仅支持 .app / .dmg" >&2
    exit 64
    ;;
esac

if [[ "$FAILURES" -gt 0 ]]; then
  echo
  echo "校验失败项：${FAILURES}（未签名/未公证产物属预期结果，见 docs/release-checklist-1.0.0.md）"
  exit 1
fi

echo "全部校验通过"
