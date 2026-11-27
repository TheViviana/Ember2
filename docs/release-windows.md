# Windows 64 位打包

> 适用版本：`1.2.0` 起。构建在 GitHub Actions 的 `windows-latest` 上完成
> （Tauri 的 NSIS 打包依赖 Windows 工具链，macOS 主机无法交叉产出安装包）。
> 2026-11-26：Windows 虚拟机实测通过。

## 1. 触发方式

工作流：[`.github/workflows/release-windows.yml`](../.github/workflows/release-windows.yml)

```bash
# 只出可下载的 Artifact，不碰任何 Release（实测用；ref 可填 tag）
env -u GH_TOKEN gh workflow run release-windows.yml --ref main -f ref=v1.2.1

# 出包并上传到指定 Release（发版用）
env -u GH_TOKEN gh workflow run release-windows.yml --ref main -f tag=v1.2.1 -f ref=v1.2.1
```

- **必须 `env -u GH_TOKEN`**：本机环境里的 `GH_TOKEN` 是 GitHub App token，
  缺 `workflow` 权限，直接调用会返回 `HTTP 403: Resource not accessible by integration`；
  keyring 账号（`gho_*`，含 `repo`/`workflow`）才有权限。
- `--ref main` 决定使用哪个分支的工作流定义；`-f ref=` 决定检出哪份源码。
  发布时应把 `-f ref=` 指向目标 tag，保证产物与 tag 对齐。
- `tag` 输入留空时只上传 Artifact（名 `ember-windows-nsis`，含 `.exe` 与 `.exe.sig`，保留 14 天）；
  填了 tag 才会 `gh release upload --clobber`。
- 一次完整构建约 4 分钟（含 `pnpm install` 与 Rust 编译缓存命中）。

本地等价命令（在 Windows 机器上）：

```powershell
pnpm install --frozen-lockfile
pnpm tauri build --bundles nsis
```

产物：`src-tauri/target/release/bundle/nsis/Ember_<version>_x64-setup.exe`
与 updater 签名 `Ember_<version>_x64-setup.exe.sig`
（`x86_64-pc-windows-msvc`，NSIS `installMode: currentUser`，
装到 `%LOCALAPPDATA%\Programs\Ember`，不需要管理员权限）。

> CI 通过 `--config` 强制 `bundle.createUpdaterArtifacts=true`，
> 签名私钥来自仓库 secret `TAURI_SIGNING_PRIVATE_KEY`；缺失时构建直接失败。
> 本地手动构建要产出 `.sig` 时，需自行追加
> `--config '{"bundle":{"createUpdaterArtifacts":true}}'` 并设置同一环境变量。

## 2. 平台差异（已适配，改动相关代码时必须保持）

| 位置 | Windows 行为 |
|---|---|
| `vault::atomic::fsync_dir` | 跳过。Windows 用普通句柄打开目录会返回 `os error 5`（`ERROR_ACCESS_DENIED`），曾导致启动即「I/O 失败：拒绝访问」。`trash`/`backup` 复用同一实现 |
| `vault::paths::app_support_dir` | 取 `%APPDATA%\Ember`。Windows 无 `HOME`，沿用 macOS 的 `~/Library/...` 会退化到 `%TEMP%`，锁与库表会被磁盘清理删掉 |
| `vault::lock` 判活 | `tasklist /FI "PID eq <pid>" /NH`，带 `CREATE_NO_WINDOW` |
| 媒体协议 | `media://` 在 Windows 走 `http://media.localhost`，CSP 必须同时放行该源 |
| 文件定位 | `explorer /select,<path>`，且 explorer 成功时也可能返回非 0，只能确认派生成功 |
| 系统回收站 | `SHFileOperationW`（`FO_DELETE` + `FOF_ALLOWUNDO`），失败自动回落库内回收站；FFI 隔离在 `vault/windows.rs` |
| 快捷键 | 配置里的 `Meta` 在 Windows 映射为 `Ctrl` |
| 图标 | `bundle.icon` 必须含 `icon.ico` |

## 3. 发布前检查

- [ ] 上一次发版后的 E2E 更新链路已验证（检测 → 下载 → 签名校验 → 手动退出重开 → 版本变化），
  结论记入本次 release notes。
- [ ] 发版前用 draft release 跑一次本 workflow，确认 CI 侧生成/合并/上传 `latest.json` 正常
  （不含安装验证），把「CI 是否有效」这个变量提前消掉。
- 仓库内路径不得含 Windows 非法字符（`: * ? " < > |`），尤其 `docs/assets/` 这类上传目录；
  含冒号的文件名会让 Windows runner 在 checkout 阶段直接失败。
- 版本号三处同步：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`，
  并由 cargo 更新 `Cargo.lock`。安装包文件名取自 `tauri.conf.json` 的 `version`。
  CI 还会校验 tag 与这三处版本一致，不一致直接失败（预演需显式勾选 `allow_tag_mismatch`）。
- 代码签名是**可选**的：仓库配置了 `WINDOWS_CERTIFICATE`（base64 PFX）与
  `WINDOWS_CERTIFICATE_PASSWORD` 时，CI 自动导入证书并按 thumbprint 签名
  （SHA-256 + DigiCert 时间戳）；未配置时照旧产出未签名安装包，Windows 会弹
  SmartScreen，需「更多信息 → 仍要运行」。
- `bundle.windows.webviewInstallMode` 为 `downloadBootstrapper`：**首次安装需联网**
  下载 WebView2 运行时。离线机器要先装 WebView2，否则安装会卡住。
- CI 强制 `createUpdaterArtifacts=true`，因此每次都会产出
  `Ember_<version>_x64-setup.exe.sig`（私钥来自 secret `TAURI_SIGNING_PRIVATE_KEY`）。
- 带 tag 的构建会由 `scripts/release/latest-json.mjs` 生成并上传 `latest.json`：
  缺少 `url`/`signature`、版本号三处不一致、既有清单损坏，或试图用更低版本覆盖时，
  构建直接失败。workflow 固定传 `--prune-stale-platforms`：仍指向旧 tag 的其它平台
  条目会被移除，避免全局版本升级后其它平台「检测到新版本却下载旧包」；已指向本次
  tag 的条目会保留。
- **1.2.3 起双平台必须同时 publish**：上传 macOS 资产到同一个 draft 后，先运行
  `node scripts/release/verify-release.mjs --tag <tag> --repository TheViviana/Ember2`，
  或手动触发 `release-publish` workflow；门禁通过后才会转正。缺任一平台资产或
  `latest.json` 条目时不要手动 publish。
- 发布后仍需确认 Release 资产里的 `latest.json` 存在，且 `windows-x86_64` 的
  `url` 指向本次 `.exe`、`signature` 与其 `.sig` 一致。
- 上传到 Release 前确认该 tag 已存在且资产名未冲突；重名需显式 `--clobber`。

## 4. 实机验收清单（虚拟机）

1. 首启直接进主界面，不停在「启动失败」页。
2. 生成 `文档\EmberVault\.workbench\settings.json` 与 `%APPDATA%\Ember\` 下的
   `machine-id`、`libraries.json`。
3. 新建 / 编辑 / 保存 `.md`，重启后内容与库列表都在。
4. 删除文件进系统回收站（可从回收站还原）；回收站不可用时回落库内回收站；导出一次备份成功。
5. 设置 →「检查更新」显示「已是最新版本」，不出现 `TargetNotFound` 之类的错误。
6. 本地 Ollama：虚拟机里的 `localhost` 指虚拟机自身。Ollama 装在宿主机时需
   `OLLAMA_HOST=0.0.0.0:11434`，Base URL 填宿主机局域网 IP，并勾选「允许明文 HTTP」。

## 5. 已知限制（未修，不阻塞使用）

- `atomic::available_bytes` 用 `df -k`，Windows 上取不到值，磁盘空间预检静默跳过。
- `write_atomic_create_new` / 库锁依赖 `hard_link`：NTFS 正常，exFAT/FAT32 库会失败。
