# macOS 构建 / 签名 / 公证 / 校验（P7）

本目录只含发布流水线脚本，不参与应用运行时。

## 前置条件

- macOS 13+，Node ≥ 22.18，pnpm 12.x，Rust 1.85+。
- 发布 universal 包需要安装双架构 target：

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

- 签名需要钥匙串中存在 `Developer ID Application` 证书；公证需要 Apple ID、Team ID 与 App 专用密码。

## 脚本

| 脚本 | 作用 | 关键环境变量 |
|---|---|---|
| `build-macos.sh` | 构建 `.app` / `.dmg`；默认 universal，缺 x86_64 target 时回退宿主架构 | `EMBER_BUILD_TARGET`、`EMBER_WITH_UPDATER`、`TAURI_SIGNING_PRIVATE_KEY` |
| `sign.sh` | hardened runtime + timestamp 签名 | `APPLE_SIGNING_IDENTITY`（缺省取钥匙串第一个身份） |
| `notarize.sh` | notarytool 提交、等待、stapler 装订 | `APPLE_ID`、`APPLE_TEAM_ID`、`APPLE_APP_PASSWORD` |
| `verify-artifact.sh` | codesign / spctl / stapler / hdiutil / sha256 | — |

## 标准发布顺序

```bash
./scripts/release/build-macos.sh
./scripts/release/sign.sh "src-tauri/target/universal-apple-darwin/release/bundle/macos/Ember.app"
APPLE_ID=... APPLE_TEAM_ID=... APPLE_APP_PASSWORD=... \
  ./scripts/release/notarize.sh "src-tauri/target/universal-apple-darwin/release/bundle/macos/Ember.app"
./scripts/release/verify-artifact.sh "src-tauri/target/universal-apple-darwin/release/bundle/macos/Ember.app"
```

## 自动更新产物

`tauri.conf.json` 的 `bundle.createUpdaterArtifacts` 默认 `false`：本机没有签名身份，
打开它会让普通 `pnpm tauri build` 因缺少 `TAURI_SIGNING_PRIVATE_KEY` 失败。
发布流水线用：

```bash
EMBER_WITH_UPDATER=1 TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/ember.key)" \
  ./scripts/release/build-macos.sh
```

脚本会追加 `--config '{"bundle":{"createUpdaterArtifacts":true}}'`，生成
`.app.tar.gz` 与 `.sig`。私钥与 pubkey 管理见 `src-tauri/tauri.conf.json` 的 `plugins.updater`。

## 已知阻塞（2026-11-20）

- `security find-identity -v -p codesigning` 返回 **0 valid identities**：本机无法完成
  签名/公证，`sign.sh` 以 exit 2 明确失败，未签名产物在 `verify-artifact.sh` 中同样失败，
  这是预期结果而非脚本缺陷。
- 仓库没有 git remote：不做真实更新发布，updater endpoint/pubkey 保持占位。
