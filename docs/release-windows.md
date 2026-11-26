# Windows 64 位打包

> 适用版本：`1.2.0` 起。构建在 GitHub Actions 的 `windows-latest` 上完成
> （Tauri 的 NSIS 打包依赖 Windows 工具链，macOS 主机无法交叉产出安装包）。
> 2026-11-26：Windows 虚拟机实测通过。

## 1. 触发方式

工作流：[`.github/workflows/release-windows.yml`](../.github/workflows/release-windows.yml)

```bash
# 只出可下载的 Artifact，不碰任何 Release（实测用）
env -u GH_TOKEN gh workflow run release-windows.yml --ref main -f ref=main

# 出包并上传到指定 Release（发版用）
env -u GH_TOKEN gh workflow run release-windows.yml --ref main -f tag=v1.2.0 -f ref=main
```

- **必须 `env -u GH_TOKEN`**：本机环境里的 `GH_TOKEN` 是 GitHub App token，
  缺 `workflow` 权限，直接调用会返回 `HTTP 403: Resource not accessible by integration`；
  keyring 账号（`gho_*`，含 `repo`/`workflow`）才有权限。
- `tag` 输入留空时只上传 Artifact（名 `ember-windows-nsis`，保留 14 天）；
  填了 tag 才会 `gh release upload --clobber`。
- 一次完整构建约 3 分钟（含 `pnpm install` 与 Rust 编译缓存命中）。

本地等价命令（在 Windows 机器上）：

```powershell
pnpm install --frozen-lockfile
pnpm tauri build --bundles nsis
```

产物：`src-tauri/target/release/bundle/nsis/Ember_<version>_x64-setup.exe`
（`x86_64-pc-windows-msvc`，NSIS `installMode: currentUser`，
装到 `%LOCALAPPDATA%\Programs\Ember`，不需要管理员权限）。

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

- 版本号三处同步：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`，
  并由 cargo 更新 `Cargo.lock`。安装包文件名取自 `tauri.conf.json` 的 `version`。
- 未做代码签名：Windows 会弹 SmartScreen，需「更多信息 → 仍要运行」。
- `bundle.windows.webviewInstallMode` 为 `downloadBootstrapper`：**首次安装需联网**
  下载 WebView2 运行时。离线机器要先装 WebView2，否则安装会卡住。
- `createUpdaterArtifacts` 为 `false`，Windows 安装包不含自动更新。
  要让 Windows 走 updater，需额外产出 `*.nsis.zip` 与 `.sig`，并在 `latest.json`
  中写 `windows-x86_64` 条目。
- 上传到 Release 前确认该 tag 已存在且资产名未冲突；重名需显式 `--clobber`。

## 4. 实机验收清单（虚拟机）

1. 首启直接进主界面，不停在「启动失败」页。
2. 生成 `文档\EmberVault\.workbench\settings.json` 与 `%APPDATA%\Ember\` 下的
   `machine-id`、`libraries.json`。
3. 新建 / 编辑 / 保存 `.md`，重启后内容与库列表都在。
4. 删除文件走库内回收站；导出一次备份成功。
5. 本地 Ollama：虚拟机里的 `localhost` 指虚拟机自身。Ollama 装在宿主机时需
   `OLLAMA_HOST=0.0.0.0:11434`，Base URL 填宿主机局域网 IP，并勾选「允许明文 HTTP」。

## 5. 已知限制（未修，不阻塞使用）

- `atomic::available_bytes` 用 `df -k`，Windows 上取不到值，磁盘空间预检静默跳过。
- `write_atomic_create_new` / 库锁依赖 `hard_link`：NTFS 正常，exFAT/FAT32 库会失败。
