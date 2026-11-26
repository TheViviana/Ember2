/**
 * P2 IPC 类型单一入口。
 *
 * 唯一真理源：`docs/contract.md` §II（错误码）与 §III（命令表）。
 * - 字段一律 camelCase（对应 Rust `#[serde(rename_all = "camelCase")]`）。
 * - 库内路径一律是相对库根的正斜杠字符串（DTO 层已保证，与宿主平台无关）。
 * - 数值量（bytes / modifiedMs / 常量）统一为 number。
 *
 * 本文件只放类型与常量，不引用 `@tauri-apps/*`（该依赖只允许出现在 `src/data/`，见 gate:layers）。
 */

// ---------------------------------------------------------------- §II 错误码

/** 契约 §II 的稳定错误码；前端只认 code，不解析 message。 */
export const IPC_ERROR_CODES = Object.freeze([
  'E_VAULT_LOCKED',
  'E_READONLY',
  'E_LOCK_LOST',
  'E_PATH_ESCAPE',
  'E_RESERVED_PATH',
  'E_NOT_FOUND',
  'E_IO',
  'E_DISK_FULL',
  'E_MEDIA_TYPE',
  'E_MEDIA_TOO_LARGE',
  'E_TRASH_FAILED',
  'E_INVALID_ARG',
  'E_BAD_ID',
  'E_CONFLICT',
  'E_TOO_LARGE',
  'E_ENCODING',
  'E_PERM',
  'E_BACKUP_FAILED',
  'E_AI_NOT_CONFIGURED',
  'E_AI_INVALID_ENDPOINT',
  'E_AI_KEY_MISSING',
  'E_AI_KEYCHAIN_DENIED',
  'E_AI_UNAUTHORIZED',
  'E_AI_RATE_LIMITED',
  'E_AI_TIMEOUT',
  'E_AI_CONNECT_TIMEOUT',
  'E_AI_NETWORK',
  'E_AI_MODEL_UNAVAILABLE',
  'E_AI_UNSUPPORTED_PROVIDER',
  'E_AI_INVALID_RESPONSE',
  'E_AI_RESPONSE_TOO_LARGE',
  'E_AI_CANCELLED',
  'E_TRANSLATE_EMPTY',
  'E_TRANSLATE_TOO_LONG',
  'E_TRANSLATE_LANGUAGE',
  'E_TRANSLATE_NETWORK',
  'E_TRANSLATE_HTTP',
  'E_TRANSLATE_INVALID_RESPONSE',
] as const);

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number];

/**
 * 前端兜底码：Rust 永不返回。
 * 用于 Tauri 非命令级拒绝（命令缺失、ACL 拒绝、序列化失败等只有字符串的失败）。
 * `E_CLOSING` / `E_FLUSH_TIMEOUT` 由 core 产生，不进 `IPC_ERROR_CODES`（该数组只列 Rust 契约码）。
 */
export type FrontendErrorCode = IpcErrorCode | 'E_UNKNOWN' | 'E_CLOSING' | 'E_FLUSH_TIMEOUT';

/** `E_BACKUP_FAILED` 的根因类别（CR-20261116-02 §8.2.1）；其它错误不带该键。 */
export type BackupFailureCause = 'EACCES' | 'ENOSPC' | 'E_IO';

/** 契约 §II：P1 共享失败载荷，恒为 `{ code, message }`。 */
export interface ErrorPayload {
  code: IpcErrorCode;
  message: string;
}

/**
 * 画布命令专用错误载荷（对应 Rust `ipc::canvas::CanvasErrorPayload`）。
 *
 * 与 P1 `ErrorPayload` 类型隔离，不得互相赋值或合并：
 * - Rust 侧 P1 共享载荷保持 `{ code, message }`（H1 方案 A）；
 * - 只有 `canvas_read` / `canvas_write` 可能携带 `currentSha` / `cause`，
 *   且不适用时 Rust 不序列化该键（core 侧归一为 `null`）。
 */
export interface CanvasErrorPayload extends ErrorPayload {
  /** 仅 `E_CONFLICT` 且磁盘存在版本时出现；缺失即「目标不存在」。 */
  currentSha?: string;
  /** 仅 `E_BACKUP_FAILED` 出现。 */
  cause?: BackupFailureCause;
}

// ---------------------------------------------------------------- §III vault

/** 只读原因（`VaultIdentityDto.readonlyReason`），Rust 侧 camelCase 枚举。 */
export type ReadonlyReason = 'lockedByOther' | 'lockLost' | 'filesystemReadonly';

export interface VaultIdentityDto {
  vaultId: string;
  root: string;
  schemaVersion: number;
  readonly: boolean;
  readonlyReason?: ReadonlyReason;
}

/** 全部数值上限/周期的单源下发（契约 I8），前端不得手写数字。 */
export interface VaultConstantsDto {
  maxDocBytes: number;
  maxImageBytes: number;
  maxMediaBytes: number;
  historyKeep: number;
  historyBudgetBytes: number;
  trashRetentionDays: number;
  watcherDebounceMs: number;
  maxScanDepth: number;
}

export interface ReadDocDto {
  path: string;
  text: string;
  bytes: number;
  sha256: string;
  modifiedMs: number;
}

export interface WriteDocDto {
  path: string;
  bytes: number;
  sha256: string;
}

export interface StatDto {
  path: string;
  bytes: number;
  sha256: string;
  modifiedMs: number;
}

export type DirEntryKind = 'dir' | 'file';

export interface DirEntryDto {
  name: string;
  path: string;
  kind: DirEntryKind;
  bytes: number;
  modifiedMs: number;
}

export interface ScanDocDto {
  path: string;
  bytes: number;
  sha256: string;
  modifiedMs: number;
}

/** 非法画布条目的固定原因（CR-20261116-02 §4.4.1，四值封闭）。 */
export type CanvasEntryReason = 'bad_id' | 'symlink' | 'not_regular_file' | 'io_error';

/**
 * `list_canvases` 条目：合法条目带 P1 四键 + `valid:true`；
 * 非法条目只带 `id` / `valid` / `reason`（可含 `modifiedMs`），`path` / `bytes` 缺省。
 */
export interface CanvasEntryDto {
  id: string;
  valid: boolean;
  reason?: CanvasEntryReason;
  path?: string;
  bytes?: number;
  modifiedMs?: number;
}

/** `canvas_read` 响应；`path` 为相对库根的 POSIX 路径。 */
export interface ReadCanvasDto {
  id: string;
  path: string;
  text: string;
  bytes: number;
  sha256: string;
  modifiedMs: number;
}

/** `canvas_write` 响应；不含正文。 */
export interface WriteCanvasDto {
  id: string;
  path: string;
  bytes: number;
  sha256: string;
  modifiedMs: number;
}

/** `canvas_read` 请求；只按 id 定址，不接受路径参数。 */
export interface CanvasReadRequest {
  id: string;
}

/** `canvas_write` 请求；`expectedSha` 空串表示期望目标不存在，`backupV1` 缺省 `false`。 */
export interface CanvasWriteRequest {
  id: string;
  text: string;
  expectedSha?: string | null;
  backupV1?: boolean;
}

export interface VaultReadRequest {
  path: string;
}

export interface VaultRevealRequest {
  path: string;
}

export interface VaultWriteRequest {
  path: string;
  text: string;
  /** SHA 要求版本一致，空字符串要求目标不存在；缺省 / null 保持无条件写。 */
  expectedSha?: string | null;
}

export type VaultImportConflict = 'skip' | 'rename';
export type VaultImportStatus = 'imported' | 'skipped';

export interface VaultImportRequest {
  /** 外部 Markdown 的绝对路径。 */
  sourcePath: string;
  /** 库内相对目录；空串表示库根，默认目录由调用方决定。 */
  targetDir: string;
  conflict: VaultImportConflict;
}

export interface ImportDocDto {
  status: VaultImportStatus;
  /** imported 时为库内相对路径；skipped 时为 null。 */
  path: string | null;
  /** skipped 时为 0。 */
  bytes: number;
  sha: string | null;
}

export interface VaultReplaceItem {
  path: string;
  expectedSha: string;
  /** 前端按 raw offsets 生成的完整新文档。 */
  text: string;
}

export interface VaultReplaceRequest {
  items: VaultReplaceItem[];
}

export type VaultReplaceStatus = 'applied' | 'rolledBack' | 'partial';

export interface VaultReplaceFailure {
  path: string;
  code: string;
  message: string;
}

export interface ReplaceDocDto {
  status: VaultReplaceStatus;
  /** 返回时未恢复、仍由本批次保留新内容的路径。 */
  written: string[];
  restored: string[];
  failure: VaultReplaceFailure | null;
  rollbackErrors: VaultReplaceFailure[];
}

export interface VaultRenameRequest {
  from: string;
  to: string;
}

export interface VaultListRequest {
  /** 缺省为库根。 */
  path?: string;
}

export interface VaultStatRequest {
  path: string;
}

export interface VaultMkdirRequest {
  path: string;
}

export interface VaultRemoveRequest {
  path: string;
}

// ---------------------------------------------------------------- §III media

export type MediaKind = 'image' | 'audio' | 'video' | 'doc';

export interface MediaSaveDto {
  path: string;
  hash: string;
  kind: MediaKind;
  bytes: number;
  /** true 表示命中已有内容、未产生新文件。 */
  deduped: boolean;
}

export interface MediaEntryDto {
  path: string;
  hash: string;
  kind: MediaKind;
  bytes: number;
  modifiedMs: number;
}

export interface MediaSaveRequest {
  /** 绝对路径（来自拖放 / 文件选择器），不经过库内 resolve。 */
  sourcePath: string;
}

export interface MediaSaveBytesRequest {
  /** 标准 base64（无 data URL 前缀）；用于粘贴截图等内存字节。 */
  data: string;
}

export interface MediaDeleteRequest {
  /** 必须带 `media/` 前缀，否则 E_INVALID_ARG。 */
  path: string;
}

// ---------------------------------------------------------------- §III trash

/** 删除实际落点。 */
export type TrashVia = 'system' | 'workbench';

export interface TrashResultDto {
  via: TrashVia;
  trashId: string;
}

export interface TrashEntryDto {
  id: string;
  path: string | null;
  bytes: number;
  deletedAt: string | null;
}

export interface TrashListDto {
  entries: TrashEntryDto[];
}

export interface TrashCleanupRequest {
  ids: string[];
}

export interface TrashCleanupErrorDto {
  id: string;
  code: string;
  message: string;
}

export interface TrashCleanupDto {
  removedIds: string[];
  errors: TrashCleanupErrorDto[];
}

// --------------------------------------------------------------- §III backup

export interface BackupDestinationDto {
  path: string;
}

export interface BackupReportDto {
  path: string;
  files: number;
  bytes: number;
  /** ISO 8601 时间串（manifest.json 原样）。 */
  createdAt: string;
}

export interface BackupInspectDto {
  path: string;
  version: number;
  createdAt: string;
  sourceRoot: string;
  files: number;
  bytes: number;
}

export interface BackupDestinationRequest {
  destination: string;
}

export interface BackupExportRequest {
  /** 最终备份目录，必须不存在（已存在返回 E_INVALID_ARG）。 */
  destination: string;
}

export interface BackupInspectRequest {
  destination: string;
}

// -------------------------------------------------------------- §III history

export interface HistoryVersionDto {
  /** 版本 id = 快照文件名去 .md（26 位 ULID）。 */
  version: string;
  /** 由 ULID 时间戳解码的 ISO 8601（UTC）。 */
  createdAt: string;
  bytes: number;
}

export interface HistoryReadDto {
  docId: string;
  version: string;
  text: string;
  sha256: string;
  bytes: number;
  createdAt: string;
}

export interface HistoryDeleteDto {
  deleted: boolean;
}

export interface HistoryPurgeDto {
  deleted: number;
}

export interface HistoryListRequest {
  docId: string;
}

export interface HistoryReadRequest {
  docId: string;
  version: string;
}

export interface HistoryRestoreRequest {
  path: string;
  /** 必须与目标文档 frontmatter id 一致（不一致 → E_INVALID_ARG）。 */
  docId: string;
  version: string;
  expectedSha: string;
}

export interface HistoryDeleteRequest {
  docId: string;
  version: string;
}

export interface HistoryPurgeRequest {
  docId: string;
}

// ---------------------------------------------------------------- §III window

export interface WindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowResizeFrameRequest {
  frame: WindowFrame;
}

// --------------------------------------------------------------- §III library

export interface LibraryDto {
  id: string;
  name: string;
  path: string;
  current: boolean;
  /** 目录当前是否存在；false 时仍保留在列表中。 */
  available: boolean;
}

export interface LibraryCurrentDto {
  library: LibraryDto;
  identity: VaultIdentityDto;
}

export interface LibraryAddRequest {
  /** 绝对路径。 */
  path: string;
  name?: string;
}

export interface LibraryRemoveRequest {
  id: string;
}

export interface LibraryCurrentRequest {
  id: string;
}

// ------------------------------------------------------------------ §III ai

/** 契约 §III：只接受这两个 provider。 */
export type AiProvider = 'ollama' | 'openai-compatible';

/** AI 配置不落盘，每次调用随请求传入。 */
export interface AiEndpointRequest {
  provider: AiProvider;
  baseUrl: string;
  allowInsecureHttp: boolean;
}

export interface AiKeySaveRequest extends AiEndpointRequest {
  key: string;
}

export interface AiKeySaveDto {
  storage: 'file' | 'memory';
  /** 降级到进程内存时的提示码（本地文件写入失败，非命令失败）。 */
  warningCode?: 'E_AI_KEYCHAIN_DENIED';
}

export interface AiKeyStatusDto {
  configured: boolean;
  keychainAvailable: boolean;
}

export interface AiTestConnectionDto {
  ok: true;
  models: string[];
}

export interface AiModelsDto {
  models: string[];
}

/** Rust 侧 role 为 String 透传，契约未限定取值；前端只发送这三种。 */
export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** `ai_chat_stream` 的 request 体。 */
export interface AiChatRequest {
  /** 非空、≤128 字节、仅 `[A-Za-z0-9_-]`，在途请求间唯一。 */
  requestId: string;
  provider: AiProvider;
  baseUrl: string;
  allowInsecureHttp: boolean;
  model: string;
  messages: ChatMessage[];
}

export interface AiChatCancelRequest {
  requestId: string;
}

export interface AiChatCancelDto {
  cancelled: boolean;
}

// --------------------------------------------------- §III.1 流式对话通道负载

export interface AiChatDeltaEvent {
  type: 'delta';
  requestId: string;
  text: string;
}

export interface AiChatDoneEvent {
  type: 'done';
  requestId: string;
}

export interface AiChatErrorEvent {
  type: 'error';
  requestId: string;
  code: IpcErrorCode;
  message: string;
}

export type AiChatEvent = AiChatDeltaEvent | AiChatDoneEvent | AiChatErrorEvent;

/** 联网翻译事件（CR-20261121-41）：tagged union，与 AiChatEvent 的 type 判别一致。 */
export interface TranslateProgressEvent {
  type: 'progress';
  done: number;
  total: number;
}

export interface TranslateSegmentEvent {
  type: 'segment';
  /** 所属段落序号（从 0 起；超长段落切分的子段共享同一序号）。 */
  index: number;
  /** 原文片段（对照翻译：译文内联到阅读视图该段落下方）。 */
  source: string;
  text: string;
}

export type TranslateEvent = TranslateProgressEvent | TranslateSegmentEvent;

// ------------------------------------------------------------ §III 全局事件

/** 全局事件名（`@tauri-apps/api/event` 的 listen）。 */
export const IPC_EVENT_NAMES = Object.freeze({
  fileChanged: 'vault://file-changed',
  watchError: 'vault://watch-error',
  trashSweep: 'vault://trash-sweep',
} as const);

/** 改名只有拿到两端路径时才出现；单端时按 removed / created 兜底。 */
export type FileChangeKind = 'created' | 'updated' | 'removed' | 'renamed';

export interface FileChangeDto {
  kind: FileChangeKind;
  path: string;
  /** 旧路径，仅 renamed 携带。 */
  from?: string;
  /** removed 不携带。 */
  bytes?: number;
  sha256?: string;
  modifiedMs?: number;
}

/** `vault://file-changed` 负载：一次防抖冲刷对应一条事件。 */
export interface FileChangedDto {
  changes: FileChangeDto[];
}

export type SweepSkip = 'readonly' | 'busy';

export interface SweepErrorDto {
  id: string;
  message: string;
}

/** `vault://trash-sweep` 负载；`skipped` 为 null 表示正常执行。 */
export interface SweepReportDto {
  scanned: number;
  removed: string[];
  errors: SweepErrorDto[];
  skipped: SweepSkip | null;
}

/** `vault://watch-error` 负载与命令错误同形。 */
export type WatchErrorPayload = ErrorPayload;
