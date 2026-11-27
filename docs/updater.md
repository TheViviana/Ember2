# 自动更新（P7）

> 状态：代码与配置已接入；自 v1.1.0 起 endpoint 指向本仓库 GitHub Releases，
> pubkey 为 2026-11-25 生成的发布密钥（私钥 `~/.tauri/ember.key`，不入库）。
> 更换密钥或仓库地址时必须同步替换 `plugins.updater`。

## 1. 现状

| 层 | 落点 | 说明 |
|---|---|---|
| Rust | `src-tauri/Cargo.toml`、`src-tauri/src/lib.rs` | `tauri-plugin-updater = 2.14.1`，`Builder::new().build()` |
| 权限 | `src-tauri/capabilities/default.json` | `updater:default` |
| 配置 | `src-tauri/tauri.conf.json` → `plugins.updater` | endpoint `https://github.com/TheViviana/Ember2/releases/latest/download/latest.json`、真实 pubkey |
| 产物 | `bundle.createUpdaterArtifacts` | 默认 `false`；发布时由脚本覆盖为 `true` |
| 数据端口 | `src/data/updater-port.ts` | 唯一 `@tauri-apps/plugin-updater` 引用点（gate:layers） |
| UI | `src/features/updater/UpdatePanel.tsx` | 设置 →「检查更新」 |
| 偏好 | `localStorage['ember.updater.autoCheck']` | 缺省开启；`'0'` 关闭启动静默检查 |
| 启动检查 | `AppShell.tsx` | 启动 2s 后静默检查；发现更新只推 notice，不自动安装 |

`createUpdaterArtifacts` 默认关闭的原因：本机没有签名身份，打开后普通
`pnpm tauri build` 会因缺少 `TAURI_SIGNING_PRIVATE_KEY` 直接失败。
发布流水线通过 `scripts/release/build-macos.sh` 的 `EMBER_WITH_UPDATER=1` 打开。

## 2. 发布前替换

### 2.1 生成签名密钥（一次性，已完成）

> 已生成：私钥 `~/.tauri/ember.key`，公钥已写入 `plugins.updater.pubkey`。
> 丢失私钥即无法再签发更新，需重新生成并让旧版本无法升级。

```bash
pnpm tauri signer generate -w ~/.tauri/ember.key
```

- 私钥：`~/.tauri/ember.key`（离线保管，绝不入库）。
- 公钥：命令输出或 `~/.tauri/ember.key.pub` 的内容，替换 `tauri.conf.json`
  的 `plugins.updater.pubkey`。

### 2.2 替换 endpoint（已完成）

`plugins.updater.endpoints` 已指向
`https://github.com/TheViviana/Ember2/releases/latest/download/latest.json`
（GitHub Release 资产名必须固定为 `latest.json`）。格式（Tauri v2）：

```json
{
  "version": "1.0.1",
  "notes": "修复播放控件",
  "pub_date": "2026-12-01T00:00:00Z",
  "platforms": {
    "darwin-aarch64": { "signature": "<.sig 内容>", "url": "https://.../Ember_1.0.1_universal.app.tar.gz" },
    "darwin-x86_64": { "signature": "<.sig 内容>", "url": "https://.../Ember_1.0.1_universal.app.tar.gz" },
    "windows-x86_64": { "signature": "<.exe.sig 内容>", "url": "https://.../Ember_1.0.1_x64-setup.exe" }
  }
}
```

> 清单会被整体校验：每个已写出的平台条目都必须同时含 `signature` 与 `url`。
> 缺少 `windows-x86_64` 时，Windows 端在「远端版本更高」时会报 `TargetNotFound`；
> 版本相同时仍正常返回「已是最新」。

### 2.3 构建带签名的更新产物

macOS（本地脚本）：

```bash
EMBER_WITH_UPDATER=1 TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/ember.key)" \
  ./scripts/release/build-macos.sh
```

产物包含 `.app.tar.gz` 与 `.sig`；`.sig` 内容写入上面 JSON 的 `signature`。

Windows（CI）：[`release-windows.yml`](../.github/workflows/release-windows.yml)
用仓库 secret `TAURI_SIGNING_PRIVATE_KEY` 给 NSIS 安装包签名，产出
`Ember_<version>_x64-setup.exe` 与同名 `.exe.sig`；`.exe` 本身即更新包（Tauri v2
不再产出 `.nsis.zip`）。CI 构建失败即说明 secret 缺失或私钥损坏。

### 2.4 发布

0. **1.2.3 起双平台必须同时发布**。把 draft 转正前先跑发布门禁：

   ```bash
   node scripts/release/verify-release.mjs --tag v1.2.3 --repository TheViviana/Ember2
   ```

   或在 Actions 手动触发 `release-publish`（它会先跑同一门禁，通过后才执行
   `gh release edit --draft=false`）。门禁要求 Windows 与 macOS 资产、`latest.json`
   的 `windows-x86_64` / `darwin-aarch64` / `darwin-x86_64` 条目齐全，且所有 url
   指向本次 tag；不满足就不要 publish。1.2.2 只有 Windows，属历史例外，不再补 macOS。
1. Windows 带 tag 的 CI 构建会自动生成并合并 `latest.json`（保留其它平台条目）；
   macOS 仍按下文手工上传。发布后必须确认 Release 资产里的 `latest.json` 存在，
   且 `url`/`signature` 与本次安装包匹配——Windows CI 缺字段会直接失败，
   手工发布 macOS 时没有这层保护。
2. macOS 先签名/公证 `.app`，再压缩上传（公证票据会随之进入 tar.gz）。
3. **端到端验收（不可跳过）**：用上一版安装包验证 设置 → 检查更新 → 下载 →
   签名校验 → 手动退出重开 → 版本变化。安装完成后不会自动重启，这一步必须手动完成。
4. 代码签名是另一层：它只影响 SmartScreen/系统信任，与 updater 的 minisign 校验独立。

## 3. 安全约束

- endpoint 必须 HTTPS；不要把 `dangerousAcceptInvalidCerts` 等开关打开。
- 签名校验由 updater 插件在安装前完成；pubkey 必须与私钥配对。
- 更新日志按纯文本渲染（`normalizeReleaseNotes`），不解析 HTML。

## 4. 已知限制

- 安装完成后不自动重启（未引入 process 插件）；面板提示用户手动退出重开。
- macOS 本机无代码签名证书，更新包未公证；真实更新链路尚未端到端验证，只验证了配置/插件/UI 接线。
- Windows 代码签名同样未启用（无证书）；CI 已有条件签名钩子，配置
  `WINDOWS_CERTIFICATE` / `WINDOWS_CERTIFICATE_PASSWORD` secret 后自动生效。

## 5. 自动检查行为

- 启动 2 秒后，若 `ember.updater.autoCheck !== '0'` 且 endpoint 有更新，推送一条 notice。
- 静默检查失败（尚未发布、无网络）只 `console.warn`，不打扰用户。
- 手动检查失败在「检查更新」面板内显式展示错误。
