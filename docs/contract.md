# Ember 2.0 内核契约（骨架 · 随阶段填充）

> 本文件是 v2 重写的唯一契约源：与代码不一致时以本文件为准，代码是 bug；改行为必须先改本文件并经用户确认。
> 上位方案：`../PLAN.md`（定稿，唯一方案源）。

## I. 不变量（随实现逐条激活，激活阶段见右列）

| # | 不变量 | 激活阶段 |
|---|---|---|
| I1 | 一切磁盘写入走 Rust `vault/atomic.rs::write_atomic`（temp+fsync+rename+目录 fsync）；TS 不直接落盘库内文件 | P1 |
| I2 | 文档身份 = frontmatter `id`（ULID），与路径解耦 | P2 |
| I3 | 单一 Markdown 解析管线：全库仅 `packages/doc-model/src/markdown/pipeline.ts` 一套 unified/remark | P2 |
| I4 | 删除语义：直达系统回收站；先检查失败才落 `.workbench/trash/<ULID>/` 暂存，7 天清扫（PLAN.md §9.6） | P1 |
| I5 | 唯一真相源双向秒级同步：外部改 ≤1s 界面同步；软件改原子写回；无导入副本（PLAN.md §9.1） | P1/P2 |
| I6 | 写入前磁盘空间预检；损坏文件只读降级不覆写（PLAN.md §9.4-3） | P1 |
| I7 | 媒体 `media/image|audio|video` 类型分目录内容寻址；旧平铺兼容读；magic bytes 判型（PLAN.md §9.5） | P1 |
| I8 | 常量单源：全部数值上限/周期只在 Rust 定义，`vault_constants` 启动下发（PLAN.md §2） | P1 |
| I9 | 端口连线：严格端口制、out→in、同端口对唯一、组不连线（PLAN.md §3.2） | P4 |
| I10 | WindowManager 是浮窗几何/z 序唯一管理者，内容组件不自管几何（PLAN.md §4） | P5 |
| I11 | 禁模块级可变导出；EmberCore 显式实例传递（PLAN.md D12） | P2 |
| I12 | 异步路径零吞错：每个回调/事件/写失败必须显式上报（PLAN.md §9.4-1） | P1 起 |

## II. 错误码表（P1 已填充）

IPC 失败统一返回 `ErrorPayload { code, message }`：`code` 是稳定枚举（前端只认它，改动必须走 CR），`message` 仅供日志与展示、允许调整。单源实现见 `src-tauri/src/ipc/error.rs`（`VaultError::code()`）、`src-tauri/src/ai/error.rs`（`AiError::code()`）与 `src-tauri/src/translate.rs`（`TranslateErrorPayload`，联网翻译专用六码）。

例外：`canvas_read` / `canvas_write` 返回 `CanvasErrorPayload`（`ErrorPayload` + 可选 `currentSha` / `cause`，见 §III「canvas」）；`code` 集合与共享载荷一致。`list_canvases` 仍返回共享 `ErrorPayload`。

| code | 触发条件 | 默认 message |
|---|---|---|
| `E_VAULT_LOCKED` | 库被另一实例持有（保留码；当前启动期以只读态呈现而非直接抛出） | 库已被另一个实例占用 |
| `E_READONLY` | 只读态下的写请求：启动时锁被他人持有，或进程内 `FilesystemReadonly` 闩锁已点亮 | 库当前为只读状态 |
| `E_LOCK_LOST` | 运行期发现库锁丢失（保留码，T5 接线） | 库锁已丢失，写操作被拒绝 |
| `E_PATH_ESCAPE` | 绝对路径、`..`、盘符、symlink 越出库范围 | 路径越出库范围 |
| `E_RESERVED_PATH` | 路径组件命中 `.` 开头的保留名（含 `.workbench`） | 路径命中保留名 |
| `E_NOT_FOUND` | 目标不存在，或不是普通文件 / 目录 | 目标不存在 |
| `E_IO` | 其余磁盘 I/O 失败（含读取被 TCC 拒绝） | I/O 失败：`<详情>` |
| `E_DISK_FULL` | ENOSPC(28)，或写入前空间预检余量不足 | 磁盘空间不足 |
| `E_MEDIA_TYPE` | 媒体判型不在白名单（P1 定义，T3 接线） | 媒体类型不受支持 |
| `E_MEDIA_TOO_LARGE` | 媒体文件超过上限（P1 定义，T3 接线） | 媒体文件超过大小上限 |
| `E_TRASH_FAILED` | 移入回收站失败（P1 定义，T3 接线） | 移入回收站失败 |
| `E_INVALID_ARG` | 参数不合法：空路径、非 UTF-8、写入非 `.md`、rename 目标已存在、超长正文等 | 具体原因 |
| `E_BAD_ID` | 画布 id 不符合 `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`，或命中 Windows 保留名（`CON`/`PRN`/`AUX`/`NUL`/`COM1-9`/`LPT1-9`） | 画布 id 不合法 |
| `E_CONFLICT` | `canvas_write` 的 `expectedSha` 与磁盘当前内容不符（`""` 表示期望不存在） | 画布已被外部修改 |
| `E_TOO_LARGE` | 画布读写超过 `MAX_DOC_BYTES`（16 MiB）：写按 `text` 字节数，读按 metadata 或实读字节数 | 画布超出大小上限 |
| `E_ENCODING` | 画布文件内容不是合法 UTF-8 | 画布内容编码非法 |
| `E_PERM` | 画布**写**路径上目标 / 画布目录为 symlink 或非普通文件，或剩余权限拒绝（`EPERM` 等；`EACCES` / `EROFS` 已先映射为 `E_READONLY`） | 画布文件不可写 |
| `E_BACKUP_FAILED` | `backupV1: true` 时写 `.v1.bak` 失败；附 `cause`（`EACCES` / `ENOSPC` / `E_IO`） | 画布备份失败 |
| `E_AI_NOT_CONFIGURED` | 尚未选择提供方/端点（保留码；当前 AI 配置由前端每次调用随请求传入，暂不抛出） | 尚未配置 AI 提供方 |
| `E_AI_INVALID_ENDPOINT` | 端点 URL 非法、协议不支持，或明文 HTTP 指向非回环/非私网地址 | AI 端点非法：`<详情>` |
| `E_AI_KEY_MISSING` | 需要密钥的提供方没有可用密钥 | 缺少 API Key |
| `E_AI_KEYCHAIN_DENIED` | 本地文件持久化不可用或操作失败：保存时降级到进程内存（随 `ai_key_save.warningCode` 返回，不是命令失败），删除时作为命令失败上报；未持久化的 Key 重启需重填 | 写入本地失败，已降级到内存，重启后需重填 |
| `E_AI_UNAUTHORIZED` | 提供方返回 401 / 403 | 提供方拒绝了凭据 |
| `E_AI_RATE_LIMITED` | 提供方返回 429 | 提供方限流 |
| `E_AI_TIMEOUT` | 等待响应头或读取数据块超时 | 请求超时 |
| `E_AI_CONNECT_TIMEOUT` | 建立连接超时 | 连接服务超时 |
| `E_AI_NETWORK` | 其他传输失败、5xx（503 除外）、响应体截断 | 网络请求失败 |
| `E_AI_MODEL_UNAVAILABLE` | 提供方返回 503（模型未下载/名称不对） | 模型不可用：可能未下载或名称不对 |
| `E_AI_UNSUPPORTED_PROVIDER` | `provider` 不是 `ollama` / `openai-compatible` | 该提供方不支持获取模型列表 |
| `E_AI_INVALID_RESPONSE` | 响应不是预期 JSON/事件格式，或非 2xx 且不在上述映射内 | 提供方响应格式非法 |
| `E_AI_RESPONSE_TOO_LARGE` | 单次响应累计超过 64 MiB | 响应超出大小上限 |
| `E_AI_CANCELLED` | 用户主动取消，或流式通道已断开 | 请求已取消 |
| `E_TRANSLATE_EMPTY` | `translate_online` 的 `text` trim 后为空，或切分后无有效内容 | 没有可翻译的内容 |
| `E_TRANSLATE_TOO_LONG` | `translate_online` 的 `text` 超过 200,000 字符 | 单次联网翻译最多 200000 字符 |
| `E_TRANSLATE_LANGUAGE` | `target_lang` 不在支持的语言白名单 | 不支持的目标语言 |
| `E_TRANSLATE_NETWORK` | 翻译端点请求失败（含客户端初始化失败） | 联网翻译网络请求失败 |
| `E_TRANSLATE_HTTP` | 翻译端点返回非 2xx 状态 | 联网翻译服务返回错误状态 |
| `E_TRANSLATE_INVALID_RESPONSE` | 端点响应不是预期 JSON，或未包含译文 | 联网翻译响应格式非法 |

映射规则：

- errno：`EACCES(13)` / `EROFS(30)` 在写路径映射为 `E_READONLY`，同时点亮进程内 `FilesystemReadonly` 闩锁（`vaultIdentity.readonlyReason` 变为 `filesystemReadonly`，进程内不解除、重启复位）；读路径仍按 `E_IO` 上报。
- `ENOSPC(28)` → `E_DISK_FULL`（可恢复，前端提示清理空间）；其余 errno → `E_IO`。
- macOS TCC / 权限拒绝以底层 errno 呈现：命中上述 EACCES/EROFS 的走只读映射，其余按 `E_IO` 上报，不伪造错误码。
- 错误码与 `message` 均通过 Serde 原样透传；P1 共享载荷不新增 `code` 之外的机器可读字段。画布扩展字段只存在于 `CanvasErrorPayload`，不适用时**键不出现**（不是 `null`）：`currentSha` 仅 `E_CONFLICT` 且磁盘存在版本时出现，缺失表示目标不存在；`cause` 仅 `E_BACKUP_FAILED` 出现，取值 `EACCES` / `ENOSPC` / `E_IO`。core 在边界把缺失键归一为 `null`（`EmberIpcError.currentSha` / `cause`），前端只读归一后的字段。
- `E_CLOSING` / `E_FLUSH_TIMEOUT` 由 core 产生，Rust 永不返回，**不进** `IPC_ERROR_CODES`（该数组只列 Rust 契约码）。
- history 命令不引入新错误码：`docId` 非 ULID / `version` 格式错 / `history_restore` 的 path↔docId 不一致 / `expectedSha` 与当前文件不符 → `E_INVALID_ARG`；版本或目标文件不存在 → `E_NOT_FOUND`；恢复写入遇只读 / 越界 / 保留名 / 磁盘满 / I/O → 复用对应既有码（与 `vault_write` 一致）。

## III. IPC 命令清单（P1 已填充）

约定：命令名 snake_case，请求/响应字段 camelCase（Rust DTO `#[serde(rename_all = "camelCase")]`）。所有库内路径为相对库根的**正斜杠**字符串（DTO 层保证，不随宿主平台变化）。失败统一 `ErrorPayload`（见 §II）；仅 `canvas_read` / `canvas_write` 用 `CanvasErrorPayload`（见 §III canvas）。`vault_*` / `media_*` / `backup_*` 均作用于**当前库**，当前库由 `library_current` 切换。

### vault / media / backup

| 命令 | 请求 | 响应 | 可能错误 |
|---|---|---|---|
| `vault_identity` | 无 | `VaultIdentityDto { vaultId, root, schemaVersion, readonly, readonlyReason? }` | 启动失败载荷（`E_IO` / `E_INVALID_ARG` / `E_NOT_FOUND` / `E_DISK_FULL`） |
| `vault_constants` | 无 | `VaultConstantsDto { maxDocBytes, maxImageBytes, maxMediaBytes, historyKeep, historyBudgetBytes, trashRetentionDays, watcherDebounceMs, maxScanDepth }` | 无 |
| `vault_read` | `{ path }` | `ReadDocDto { path, text, bytes, sha256, modifiedMs }` | `E_PATH_ESCAPE` `E_RESERVED_PATH` `E_NOT_FOUND` `E_INVALID_ARG` `E_IO` |
| `vault_reveal` | `{ path }`（当前库内 `.md` 文章相对路径） | `null`（成功） | `E_PATH_ESCAPE` `E_RESERVED_PATH` `E_NOT_FOUND` `E_INVALID_ARG` `E_IO` |
| `vault_write` | `{ path, text, expectedSha? }` | `WriteDocDto { path, bytes, sha256 }` | `E_READONLY` `E_INVALID_ARG`（含条件 SHA 不匹配）`E_PATH_ESCAPE` `E_RESERVED_PATH` `E_DISK_FULL` `E_IO` |
| `vault_rename` | `{ from, to }` | `WriteDocDto { path, bytes, sha256 }` | `E_READONLY` `E_INVALID_ARG`（目标已存在 / 文件非 `.md` / 移入自身）`E_PATH_ESCAPE` `E_RESERVED_PATH` `E_NOT_FOUND` `E_DISK_FULL` `E_IO` |
| `vault_list` | `{ path? }`（缺省为库根） | `DirEntryDto[] { name, path, kind: "dir"\|"file", bytes, modifiedMs }` | `E_PATH_ESCAPE` `E_RESERVED_PATH` `E_NOT_FOUND` `E_INVALID_ARG` `E_IO` |
| `vault_scan` | 无 | `ScanDocDto[] { path, bytes, sha256, modifiedMs }` | `E_PATH_ESCAPE` `E_IO`（遇 I/O 错误整体失败，不静默跳过） |
| `vault_stat` | `{ path }` | `StatDto { path, bytes, sha256, modifiedMs }` | `E_PATH_ESCAPE` `E_RESERVED_PATH` `E_NOT_FOUND` `E_INVALID_ARG` `E_IO` |
| `list_canvases` | 无 | `CanvasEntryDto[] { id, valid, reason?, path?, bytes?, modifiedMs? }`（见 §III canvas） | `E_IO` |
| `media_save` | `{ sourcePath }`（绝对路径） | `MediaSaveDto { path, hash, kind: "image"\|"audio"\|"video"\|"doc", bytes, deduped }` | `E_READONLY` `E_MEDIA_TYPE` `E_MEDIA_TOO_LARGE` `E_INVALID_ARG` `E_DISK_FULL` `E_IO` |
| `media_list` | 无 | `MediaEntryDto[] { path, hash, kind: "image"\|"audio"\|"video"\|"doc", bytes, modifiedMs }` | `E_IO` |
| `vault_mkdir` | `{ path }` | `null`（成功） | `E_PATH_ESCAPE` `E_INVALID_ARG` `E_READONLY` `E_IO` |
| `vault_remove` | `{ path }` | `TrashResultDto { via: "system"\|"workbench", trashId }` | `E_PATH_ESCAPE` `E_RESERVED_PATH` `E_NOT_FOUND` `E_INVALID_ARG` `E_READONLY` `E_TRASH_FAILED` `E_DISK_FULL` `E_IO` |
| `media_delete` | `{ path }`（必须 `media/` 前缀） | `TrashResultDto { via: "system"\|"workbench", trashId }` | 同 `vault_remove`，前缀不符报 `E_INVALID_ARG` |
| `backup_destination` | `{ destination }`（存放备份的目录） | `BackupDestinationDto { path }` | `E_INVALID_ARG` |
| `backup_export` | `{ destination }`（最终备份目录，必须不存在） | `BackupReportDto { path, files, bytes, createdAt }` | `E_INVALID_ARG` `E_DISK_FULL` `E_IO` |
| `backup_inspect` | `{ destination }` | `BackupInspectDto { path, version, createdAt, sourceRoot, files, bytes }` | `E_NOT_FOUND` `E_INVALID_ARG` `E_PATH_ESCAPE` `E_IO` |

- `vault_write` 的 `expectedSha` 缺省或为 `null` 时保持原有无条件创建 / 覆盖语义；传入 SHA 时，Rust 在取得写许可后、原子写之前复核当前普通文件的 SHA，完全匹配才写入。传入空字符串 `""` 表示“期望目标不存在”：仅目标缺失时允许创建，目标已存在则拒绝。条件不匹配返回 `E_INVALID_ARG`，不得修改目标或登记 self-write；调用方不得自动重试，应重新 `vault_stat` 并重新裁决冲突。
- `vault_reveal` 是只读命令：复用 `paths::resolve` 拒绝越界、保留路径与 symlink，只接受已存在的普通 `.md` 文件；macOS 以 `/usr/bin/open` 参数数组执行 `-R <absolutePath>`，不经过 shell，启动失败或非零退出状态均返回 `E_IO`，只读库仍可使用。
- `vault_mkdir`（CR-20261121-57）：`paths::resolve` 防越界 + `gate.enter()` 拦只读；已存在同名条目（文件或目录）报 `E_IO`；父目录级联创建。空目录不进 `vault_scan` 索引；前端通过 `vault_list` 的 `knownDirs` 快照持续展示，`pendingDirs` 仅负责新建后的即时反馈。`.workbench/canvas/*.canvas.json` 属库内普通文件，可经 `vault_remove` 删除（CR-20261121-57 画布删除即此路径）。
- `vault_remove` / `media_delete`：先解析路径防越界，再 `gate.enter()`；只读态直接 `E_READONLY` 且不触碰磁盘。删除走系统废纸篓，失败降级到 `.workbench/trash/<ULID>/`，`via` 表示实际落点。
- `vault_remove` 可删除普通文件或普通目录（CR-20261122-63）。目录在系统回收/库内移动前先无跟随递归走查，根或后代出现 symlink、socket、FIFO、设备文件等一律拒绝且不删除；目录跨卷 `EXDEV` 安全失败并保留源目录，不进入仅支持单文件的复制+删除降级。
- 保留路径唯一例外（CR-20261122-63）：`vault_remove` 接受精确单层 `.workbench/canvas/<name>.canvas.json` 普通文件（含 `bad_id` 文件名），以便删除无效画布；隐藏名、额外路径段、`..`、反斜杠、其它 `.workbench` 内容仍按 `E_RESERVED_PATH` / `E_PATH_ESCAPE` 拒绝，画布父目录或目标为 symlink 时 fail closed。该例外只作用于 `vault_remove`，不改变通用 `paths::resolve`。
- `vault://trash-sweep`：启动时后台线程发一次，负载 `SweepReportDto { scanned, removed: string[], errors: { id, message }[], skipped?: "readonly"|"busy" }`；只读或写队列被占用时整轮跳过，单条失败只进 `errors` 不中断后续。
- `vault://file-changed`：库内 `.md` 的外部变更，负载 `FileChangedDto { changes: [{ kind: "created"|"updated"|"removed"|"renamed", path, from?, bytes?, sha256?, modifiedMs? }] }`。一次防抖冲刷对应一条事件（500 ms 尾沿，连续写入最多推迟 2 s），同一路径在窗口内只出现一次；`bytes`/`sha256`/`modifiedMs` 是冲刷时的落盘值，`removed` 不带。监听跳过隐藏项、`media/`、`history/`、`trash/` 与旧库 `settings.json` 的 `watcherIgnoreDirs`；自己通过 `vault_write` / `vault_rename` / `vault_remove` 造成的变更先登记，按内容 sha256 比对后不上报。
- 改名：只有拿到新旧两端路径时才发 `renamed`（`from` 为旧路径）。macOS FSEvents 通常只给出一端，此时按 `removed`（路径已不存在）或 `created`（路径已存在）兜底上报；前端可能需要把同一窗口内的 `removed` + `created` 推断为一次重命名。
- `vault://watch-error`：负载与命令错误同形 `{ code, message }`。监听启动失败时发一次；运行期 notify 自身报错（队列溢出、句柄失效）与取哈希失败也发此事件，绝不静默丢弃。取哈希失败的路径不进入同批 `vault://file-changed`（宁可让前端重扫，也不上报无 `sha256` 的变更）。监听失败不阻塞启动，其余命令不受影响。
- 备份遍历跳过隐藏项与顶层 `history/`、`trash/`，包含 `media/` 与全部文档；`manifest.json` 记录 `version / createdAt / sourceRoot / files[{ path, bytes, sha256 }]`。
- `backup_export` 先在目标同级 `.tmp_backup-*` 写全量文件，逐个流式复制（1 MiB 缓冲）并从落盘后的目标回读 sha256 复核，最后原子写 `manifest.json` 再回读校验，全部通过才 rename 成最终目录；任一步失败整目录清理，目标已存在一律 `E_INVALID_ARG`，绝不覆盖。
- 导出只读源库，不持 `WriteGate`，不阻塞正常编辑；`backup_inspect` 逐文件核对大小与 sha256，不符返回 `E_IO`。
- `media_save` 的 `sourcePath` 来自拖放/文件选择器，不经过库内 `resolve`；Rust 只接受普通文件（symlink 拒绝），流式复制 + 内容寻址去重，`deduped: true` 表示命中已有文件且未产生新文件。
- `media_list` 同时返回类型分目录与旧版平铺 `media/*`；路径一律正斜杠。
- CR-20261120-26：`media_save` 新增 Doc 判型——`%PDF-` 前缀 → `media/doc/<hash>.pdf`；忽略 BOM/前导空白与大小写后以 `<!doctype html` 或 `<html` 开头 → `media/doc/<hash>.html`；单文件上限复用 500 MiB（与音视频同级，仅防御）；真实类型以 magic bytes 为准。
- `media://localhost/` 对 `.html`/`.htm` 响应额外下发 `X-Content-Type-Options: nosniff` 与 `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src media: data:`（无脚本、无外链、无表单）；`.pdf` 响应 `application/pdf`；其余类型不带 CSP。
- `media://localhost/<相对路径>` 只读协议：仅暴露 `media/` 下文件，拒绝越界与 symlink；支持单段 `Range`（206），单次响应内存上限 20 MiB，无 Range 且超限时返回首段并带 `Content-Range`，超出范围返回 416。
- `vault_scan` 仅返回 `.md`；跳过 `.` 开头的隐藏项、symlink、顶层 `media/`，深度上限取 `vault_constants.maxScanDepth`。
- `vault_list` 只列单层、跳过隐藏项与 symlink；`vault_rename` 目标已存在固定报 `E_INVALID_ARG`，不覆盖。CR-20261122-64：`vault_rename` 同时接受普通目录（同库内 `rename`，不动内容、不跟随内部 symlink），目录结果的 `bytes=0`、`sha256=""`；目标存在、源为 symlink/特殊文件、或目标位于源目录内部时失败并保留源目录；跨卷失败同样保留源目录，不做递归复制。

### history（CR-20261119-21 已注册 5 条；作用于当前库）

历史版本落在 `.workbench/history/documents/<docId>/<version>.md`（`docs/vault-format.md` §1；该文件为本地草稿，暂未入库，格式细节待 P1 填充后随文档一并提供）。
`<docId>` 与 `<version>` **一律 ULID**（26 字符 Crockford Base32）：`createdAt` 由 ULID 时间戳解码；
不建 sidecar 元数据文件，`bytes` 取文件大小，`sha256` 仅在 `history_read` 时计算。
快照在 `vault_write` 覆盖前自动写入旧内容（仅对 frontmatter `id` 为合法 ULID 的文档；id 缺失 /
非 ULID → 无历史，跳过不报错）；5 分钟合并：距最新快照（ULID 时间戳）不足
`SNAPSHOT_MIN_INTERVAL_SECS = 300` 秒则跳过本次快照；`history_restore` 的强制快照不受限。
写入后按每篇 KEEP=20 / BUDGET=64MiB 淘汰最旧版本（至少留最新 1 个）。
watcher 与 backup 均跳过 `history/`，快照不产生 `vault://file-changed` 事件、不进备份。
`vault_write` 的快照为 best-effort：失败仅记录日志，不闩锁全库、不阻塞主写入。

| 命令 | 请求 | 响应 | 可能错误 |
|---|---|---|---|
| `history_list` | `{ docId }` | `HistoryVersionDto[] { version, createdAt, bytes }`（按时间升序） | `E_INVALID_ARG`（非 ULID docId）`E_IO` |
| `history_read` | `{ docId, version }` | `HistoryReadDto { docId, version, text, sha256, bytes, createdAt }` | `E_INVALID_ARG` `E_NOT_FOUND`（docId/version 不存在）`E_IO` |
| `history_restore` | `{ path, docId, version, expectedSha }` | `WriteDocDto { path, bytes, sha256 }`（同 `vault_write`） | `E_INVALID_ARG`（含 path↔docId 不一致 / `expectedSha` 与当前不符 / 目标非 `.md`）`E_READONLY` `E_PATH_ESCAPE` `E_RESERVED_PATH` `E_NOT_FOUND` `E_DISK_FULL` `E_IO` |
| `history_delete` | `{ docId, version }` | `{ deleted: boolean }` | `E_INVALID_ARG` `E_NOT_FOUND` `E_IO` |
| `history_purge` | `{ docId }` | `{ deleted: number }` | `E_INVALID_ARG` `E_IO` |

- `history_restore` 需 **path↔docId 一致**：读当前 `path` 的 frontmatter `id`，缺失 / 非 ULID /
  与请求 `docId` 不匹配 → `E_INVALID_ARG`；目标文件不存在 → `E_NOT_FOUND`——防止把 A 的版本写进 B
  的文档。恢复前强制快照当前内容（保证可撤销，不受 5 分钟合并限制）；快照失败中止恢复，当前文件不动。
- `history_list` / `history_read` 只读不持写闸门；`history_delete` / `history_purge` 持写闸门。

### import / replace / trash（P6 已注册 4 条；CR-20261120-29）

| 命令 | 请求 | 响应 | 可能错误 |
|---|---|---|---|
| `vault_import` | `{ sourcePath, targetDir, conflict: "skip"\|"rename" }` | `ImportDocDto { status: "imported"\|"skipped", path, bytes, sha }`（skipped 时 `path`/`sha` 为 `null`、`bytes` 为 0） | `E_READONLY` `E_INVALID_ARG` `E_PATH_ESCAPE` `E_RESERVED_PATH` `E_TOO_LARGE` `E_ENCODING` `E_DISK_FULL` `E_IO` |
| `vault_replace` | `{ items: [{ path, expectedSha, text }] }` | `ReplaceDocDto { status: "applied"\|"rolledBack"\|"partial", written, restored, failure, rollbackErrors }` | 预检失败（含 SHA 不符）返回 `E_INVALID_ARG`/`E_NOT_FOUND`/`E_TOO_LARGE` 等既有结构化错误，零写入；空 `items` 为 `E_INVALID_ARG` |
| `trash_list` | 无 | `TrashListDto { entries: [{ id, path, bytes, deletedAt }] }`（deletedAt 新到旧、再按 id） | `E_IO` |
| `trash_cleanup` | `{ ids }` | `TrashCleanupDto { removedIds, errors: [{ id, code, message }] }` | 空 `ids` 为 `E_INVALID_ARG`；单条失败只进 `errors` |

- `vault_import` 只接受常规、UTF-8、`.md` 源文件并复用文档大小上限；原始字节逐字节复制，不解析、不补写 frontmatter。`targetDir` 为库内相对目录（空串为库根），越界/反斜杠/保留路径拒绝。`skip` 遇到同名直接返回 skipped；`rename` 依次尝试 `name 2.md`、`name 3.md`…，写入使用 create-only，并发下名称突然出现则继续下一序号，绝不覆盖。
- `vault_replace` 在单个 `WritePermit` 内完成全部预检与提交：任一 path/大小/`expectedSha` 失配在首写前返回错误，零写入；每个文件仍走原子写、写前历史快照与 self-write 登记。第 N 次写失败时按逆序回滚已写文件，每次回滚以“新内容 SHA”为条件，防止覆盖回滚期间的外部改动。全部回滚成功返回 `rolledBack`，任一回滚失败返回 `partial` 并逐项列出 `rollbackErrors`。**不保证进程崩溃/断电时的跨文件原子性，不提供持久化崩溃日志**；前端收到 `partial` 必须显著列出未恢复路径并立即 `reconcilePaths`，禁止盲目重试。
- `trash_list` 只列 `.workbench/trash/<合法 ULID>/` 下同时具备有效 `meta.json` 与真实 `item` 的 Workbench 条目；meta-only 记录（系统废纸篓残留）不列出、也不删除系统回收站内容。该命令只读，不持写闸门，不按 retention 年龄过滤，启动 sweep 语义不变。
- `trash_cleanup` 重新验证每个 id 与目录边界，只删除本次列出的合法条目，逐项报告失败；不做全量清空。

### canvas（P4 已注册 2 条；`list_canvases` 扩展）

画布文件固定落在 `.workbench/canvas/<id>.canvas.json`；命令只按 `id` 定址，不接受路径参数。响应中的 `path` 是**相对库根的正斜杠路径**（如 `.workbench/canvas/c1.canvas.json`），不是绝对路径。`id` 白名单与 `E_BAD_ID` 见 §II。

| 命令 | 请求 | 响应 | 可能错误 |
|---|---|---|---|
| `list_canvases` | 无 | `CanvasEntryDto[]`：合法条目 `{ id, valid: true, path, bytes, modifiedMs }`；非法条目 `{ id, valid: false, reason, path, modifiedMs? }` | `E_IO` |
| `canvas_read` | `{ id }` | `ReadCanvasDto { id, path, text, bytes, sha256, modifiedMs }` | `E_BAD_ID` `E_NOT_FOUND` `E_TOO_LARGE` `E_ENCODING` `E_PERM` `E_READONLY` `E_IO` |
| `canvas_write` | `{ id, text, expectedSha?, backupV1? }` | `WriteCanvasDto { id, path, bytes, sha256, modifiedMs }` | `E_BAD_ID` `E_CONFLICT` `E_TOO_LARGE` `E_READONLY` `E_PERM` `E_BACKUP_FAILED` `E_DISK_FULL` `E_IO` |
| `canvas_rename` | `{ id, newId }`（CR-20261121-58） | `ReadCanvasDto { id, path, text, bytes, sha256, modifiedMs }`（新画布） | `E_BAD_ID`（含 newId）`E_NOT_FOUND` `E_INVALID_ARG`（目标已存在）`E_READONLY` `E_IO` |

- `list_canvases` 的 `valid:false` 带 `id` / `valid` / `reason` / `path`（可含 `modifiedMs`）：`reason` 固定四值 `bad_id` / `symlink` / `not_regular_file` / `io_error`，`path` 只用于受控删除定位，**不带** `bytes` / `sha256` / `text`，且无效条目仍不可打开。实现只做一次 `symlink_metadata`，不读内容、不算 sha；单个非法条目不得使整个列表失败。合法条目在 P1 四键之外仅新增 `valid:true`，其余字段名、类型与顺序不变。
- 路径口径（逐命令）：`list_canvases[].path`、`canvas_read.path`、`canvas_write.path` 三者均为**相对库根的正斜杠路径**（如 `.workbench/canvas/c1.canvas.json`），**不是绝对路径**；`valid:false` 条目同样带真实相对 `path`，但不带 `bytes`。
- `expectedSha` 三态（`None` 只存在于 Rust 边界）：缺省 / `null` → 不校验，无条件创建或覆盖；`""` → 期望目标不存在（目标已存在即 `E_CONFLICT`）；hex → 与磁盘当前普通文件内容精确匹配（不符即 `E_CONFLICT`）。core 永不发送 `None`：未 `open` 直接 `save` 在本地被拒绝，正常路径只发 `""` 或该 id 最近一次已知 sha。
- `E_CONFLICT` 附 `currentSha`：磁盘存在版本时为该内容的 sha256；目标不存在时 Rust 不输出该键，core 归一为 `null`。调用方不得自动重试，应重新读取并重新裁决冲突。
- `backupV1` 缺省 `false`；`true` 时在写主文件前把旧内容备份到同目录 `<id>.canvas.json.v1.bak`（只增不删，已存在则保留首份），失败返回 `E_BACKUP_FAILED` + `cause`（`EACCES` / `ENOSPC` / `E_IO`），主文件不变。
- 写入顺序（`WriteGate` 内）：`expectedSha` 复核 → 备份（可选）→ 原子写主文件。主文件走 `write_atomic`（temp + fsync + rename + 目录 fsync），返回落盘后的 `bytes` / `sha256` / `modifiedMs`。
- 读：目标不存在、为 symlink 或非普通文件一律 `E_NOT_FOUND`（不跟随、不写穿）；超过 `MAX_DOC_BYTES`（16 MiB，先看 metadata 再看实读字节）为 `E_TOO_LARGE`；非 UTF-8 为 `E_ENCODING`。写：目标或画布目录为 symlink / 非普通文件按 `E_PERM` 拒绝。`modifiedMs` 为 Unix epoch 毫秒。
- 失败载荷：两命令均返回 `CanvasErrorPayload`（§II 例外）；`currentSha` / `cause` 不适用时键不出现，core 归一为 `null`。**Q1 口径：Rust wire 不出键；core 归一为 `null`；TS 消费方只见 `null`，不见 `undefined` 或缺键。**

### window（P0 已注册 1 条）

该命令早于 P1 契约，失败返回字符串而非 `ErrorPayload`，前端按字符串展示。

| 命令 | 请求 | 响应 | 可能错误 |
|---|---|---|---|
| `window_resize_frame` | `{ frame: { x, y, width, height } }` | 无 | 字符串（非有限值 / 超出合理范围 / 非正宽高 / 平台调用失败；宽高不足时钳制到最小尺寸） |

### ai（T5b 已注册 7 条）

AI 配置（provider / baseUrl / allowInsecureHttp）不落盘，由前端每次调用随请求传入；密钥由 Rust 按 `{provider}:v1:{origin}` 写入本地文件 `<app_support_dir>/ai-keys.json`（持久，重启仍在），写入失败时降级到进程内存（8 小时）并在响应里带 `warningCode`。

| 命令 | 请求 | 响应 | 可能错误 |
|---|---|---|---|
| `ai_key_save` | `{ provider, baseUrl, allowInsecureHttp, key }` | `{ storage: "file"\|"memory", warningCode? }` | `E_AI_UNSUPPORTED_PROVIDER` `E_AI_INVALID_ENDPOINT` `E_AI_KEY_MISSING` |
| `ai_key_status` | `{ provider, baseUrl, allowInsecureHttp }` | `{ configured, keychainAvailable }` | `E_AI_UNSUPPORTED_PROVIDER` `E_AI_INVALID_ENDPOINT` |
| `ai_key_delete` | `{ provider, baseUrl, allowInsecureHttp }` | 无 | `E_AI_UNSUPPORTED_PROVIDER` `E_AI_INVALID_ENDPOINT` `E_AI_KEYCHAIN_DENIED` |
| `ai_test_connection` | `{ provider, baseUrl, allowInsecureHttp }` | `{ ok: true, models: string[] }` | `E_AI_*` |
| `ai_list_models` | `{ provider, baseUrl, allowInsecureHttp }` | `{ models: string[] }` | `E_AI_*` |
| `ai_chat_stream` | `{ request: { requestId, provider, baseUrl, allowInsecureHttp, model, messages: [{ role, content }] }, onEvent: Channel<AiChatEvent> }` | 无（流式，见 §III.1） | 首个 delta 前：`E_AI_*` `E_INVALID_ARG`；首个 delta 后：以 `error` 事件收尾 |
| `ai_chat_cancel` | `{ requestId }` | `{ cancelled: boolean }` | 无（未知 requestId 返回 `false`） |

- `provider` 只接受 `"ollama"` / `"openai-compatible"`；其余一律 `E_AI_UNSUPPORTED_PROVIDER`。
- `ai_key_save.storage` 取值 `"file"`（持久，重启仍在）或 `"memory"`（落盘失败降级，仅本次运行）；降级时 `warningCode` 为 `E_AI_KEYCHAIN_DENIED`。
- `ai_key_status.keychainAvailable` 字段名保留（避免破坏契约形状），语义为「持久化存储（本地文件）可用」：文件模式为 `true`，纯内存降级为 `false`。
- `ai_key_delete`：内存项必删；持久化删除失败时返回 `E_AI_KEYCHAIN_DENIED`（不假装成功），删除不存在项幂等成功。
- `ai_chat_stream` 的 `requestId` 必须非空、≤128 字节、仅 `[A-Za-z0-9_-]`，且在途请求间唯一；不合法或重复返回 `E_INVALID_ARG`。

### library（T5b 已注册 4 条）

注册表 `libraries.json` 落在 `Application Support/Ember/`，库 id 复用库内 `.workbench/settings.json` 的 `vaultId`；切换是进程内热切换，无需重启，前端切库后自行重扫。

| 命令 | 请求 | 响应 | 可能错误 |
|---|---|---|---|
| `library_list` | 无 | `LibraryDto[] { id, name, path, current, available }` | `E_IO` |
| `library_add` | `{ path, name? }`（绝对路径） | `LibraryDto` | `E_INVALID_ARG`（重复 / 嵌套 / 非绝对）`E_NOT_FOUND` `E_IO` `E_DISK_FULL` |
| `library_remove` | `{ id }` | `LibraryDto[]` | `E_INVALID_ARG` `E_NOT_FOUND` `E_IO` `E_DISK_FULL` |
| `library_current` | `{ id }` | `{ library: LibraryDto, identity: VaultIdentityDto }` | `E_NOT_FOUND` `E_INVALID_ARG` `E_DISK_FULL` `E_IO` |

- `library_add` 只登记、不切换；目录不存在返回 `E_NOT_FOUND`，同一路径已注册或两库目录互相嵌套返回 `E_INVALID_ARG`。
- `library_remove` 只删注册项，不动磁盘任何文件；移除当前库固定 `E_INVALID_ARG`。
- `library_current`：新建会话 → 落盘 → 换 Slot → 显式释放旧 Slot（先排空写闸门，再停监听、放库锁）；落盘失败不改内存态。切库成功后前端应自行重扫。
- `LibraryDto.available` 表示该目录当前是否存在；不可用的库仍保留在列表中，可移除但不建议切换。

### translate（CR-20261120-36 已注册 1 条；CR-20261120-39 补录契约；CR-20261121-50 双线路竞速）

联网翻译不依赖 AI Key：Rust 直接请求公开翻译端点（Google 与 MyMemory；首段真实任务竞速，单次任务内黏性首选并失败回退），不读密钥、不落盘、不经过 AI 配置。错误载荷与共享 `ErrorPayload` 同形（`TranslateErrorPayload { code, message }`）。

| 命令 | 请求 | 响应 | 可能错误 |
|---|---|---|---|
| `translate_online` | `{ text, targetLang, onEvent: Channel<TranslateEvent> }` | `string`（全文兜底；段落间 `\n\n` 连接，已 trim；展示以 segment 成对事件为准） | `E_TRANSLATE_EMPTY` `E_TRANSLATE_TOO_LONG`（含段数超 500）`E_TRANSLATE_LANGUAGE` `E_TRANSLATE_NETWORK` `E_TRANSLATE_HTTP` `E_TRANSLATE_INVALID_RESPONSE` |

- `text` 先 trim 再校验：空串返回 `E_TRANSLATE_EMPTY`；超过 200,000 字符返回 `E_TRANSLATE_TOO_LONG`。
- `targetLang` 白名单（中文名与语言码均接受）：`中文`/`zh`/`zh-CN`、`英文`/`en`、`日文`/`ja`、`韩文`/`ko`、`法文`/`fr`、`德文`/`de`、`西班牙文`/`es`；其余返回 `E_TRANSLATE_LANGUAGE`。
- 长文按段落规划对照翻译段（CR-20261121-42）：以空行为界分段，段内保留单换行；超过 1,800 字符的超长段落按句切到 1,800；**段数上限 500**（超出返回 `E_TRANSLATE_TOO_LONG`，message 注明段数上限）。Google 每个规划段请求一次；MyMemory 把该段再切小（450 字符）并顺序请求，子段共享段落序号，完整段译文以 `\n` 连接。单请求超时 30 秒，网络错误等待 500ms 后重试一次。
- 选路（CR-20261121-50）：每次命令仅对第一个规划段并发请求两条线路，以**完整译完该段**的首个成功响应为胜者；一路先失败则等待另一路，双败返回 Google 错误。后续段只请求首选线路，首选失败时回退另一线路，回退成功即切换后续首选，双败仍返回 Google 错误。首选仅保存在单次命令调用的局部状态中，不跨任务持久化；竞速成功的另一 Future 被丢弃，不发送额外测速请求。
- `onEvent` 事件（CR-20261120-40 引入、CR-20261121-41/42/43 演进为 tagged union，best-effort、不保证送达）：`{ type: "progress", done, total }` 报进度（首事件 `{0, 总段数}`；每完成一次**胜线**端点请求 `done` 递增；MyMemory 以多个子段完成时按子段数上调 `total`；`done`/`total` 只增不减）；`{ type: "segment", index, source, text }` 每译完一个胜线片段即成对推送——`index` 是所属段落序号（从 0 起，超长段落切分的子段共享同一序号），前端把 `text` **内联到阅读视图对应段落下方**（对照翻译，不集中成块、不重复原文）。只有完整成功的线路结果会提交事件，竞速败者和失败尝试（含其部分结果）不上屏。
- 分段口径由前端传入的正文决定：前端剥离 frontmatter 后按空行分段（围栏感知——代码/公式围栏内空行不切断段落），Rust `plan_segments` 与前端展示层使用同一算法与测试向量。
- 逐段推送不改变兜底语义：命令 resolve 的全文（段落间 `\n\n` 连接）是最终结果的兜底；前端展示以 `segment` 成对事件为准。取消仅前端丢弃结果，Rust 不中断已发起的请求；已送达的 segment 保留在界面上。
- 端点为公网 `https://translate.googleapis.com` 与 `https://api.mymemory.translated.net`；翻译内容以明文出网，含敏感内容的文档建议改用本地 AI 端点（前端 UI 已区分两种模式）。

### III.1 流式对话通道契约（`ai_chat_stream`）

`onEvent` 是 `Channel<AiChatEvent>`，事件以 `type` 区分，字段 camelCase：

| type | 负载 | 含义 |
|---|---|---|
| `delta` | `{ type: "delta", requestId, text }` | 一段增量文本，按到达顺序推送 |
| `done` | `{ type: "done", requestId }` | 正常结束，之后不会再有事件 |
| `error` | `{ type: "error", requestId, code, message }` | 已产生过 delta 后的失败，之后不会再有事件 |

- 首个 delta 之前的失败（端点非法、缺密钥、鉴权/网络/状态码错误）直接以命令 `Err(ErrorPayload)` 返回，不推 `error` 事件。
- 首个 delta 之后的失败推一条 `error` 事件并以命令 `Ok(())` 返回；`code` 取自 §II。
- 取消：`ai_chat_cancel` 置位令牌并立即移除登记项，返回 `true`；流在 250 ms 内退出，已产生 delta 时推 `error { code: "E_AI_CANCELLED" }`。
- 清理：正常结束、用户取消、窗口销毁三条路径都会移除登记项；`Channel::send` 失败视为前端已断连，只取消并清理，不会 panic。
- 窗口 `Destroyed` 时，该窗口全部在途流被取消；窗口销毁路径不得 panic。

## IV. 媒体判型白名单（P1 已填充）

| 类型 | 扩展名 | magic bytes / 判定 | 上限 |
|---|---|---|---|
| image | jpg | `FF D8 FF` | 20 MiB |
| image | png | `89 50 4E 47 0D 0A 1A 0A` | 20 MiB |
| image | gif | `GIF87a` / `GIF89a` | 20 MiB |
| image | webp | `RIFF` + `WEBP`（offset 8） | 20 MiB |
| image | avif | ISO-BMFF `ftyp`，brand `avif` / `avis` | 20 MiB |
| image | heic | ISO-BMFF `ftyp`，brand `heic` / `heix` / `hevc` / `hevx` / `mif1` / `msf1` | 20 MiB |
| audio | mp3 | `ID3` 或 `FF Ex` / `FF Fx` 帧同步 | 500 MiB |
| audio | wav | `RIFF` + `WAVE`（offset 8） | 500 MiB |
| audio | flac | `fLaC` | 500 MiB |
| audio | m4a | ISO-BMFF `ftyp`，brand `M4A ` / `M4B ` | 500 MiB |
| audio | ogg | `OggS` | 500 MiB |
| video | mp4 | ISO-BMFF `ftyp`，brand `isom` / `iso2` / `iso5` / `iso6` / `mp41` / `mp42` / `avc1` / `dash` | 500 MiB |
| video | mov | ISO-BMFF `ftyp`，brand `qt  ` | 500 MiB |
| video | m4v | ISO-BMFF `ftyp`，brand `M4V ` / `M4VH` / `M4VP` | 500 MiB |
| video | webm | EBML `1A 45 DF A3` | 500 MiB |

- 只认内容，不认扩展名；最终落盘扩展名取判型结果（源文件叫 `photo.PNG` 也写 `.png`）。
- SVG、未知格式、伪装扩展名一律 `E_MEDIA_TYPE`；超过上限在读取前即 `E_MEDIA_TOO_LARGE`。
- `ftyp` 家族先读 major brand，再扫兼容 brand 列表；同族歧义按上述 brand 表优先，不做扩展名兜底。
