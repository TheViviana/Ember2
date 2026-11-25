/**
 * 内核层错误：契约错误码的唯一转换点。
 *
 * 放在 core 而不是 data：core 不能反向依赖 data（gate:layers），而写队列、事件处理
 * 等内核逻辑都需要用 `code` 判据。`src/data/ipc-client.ts` 从这里导入并 re-export，
 * 调用侧路径保持兼容。
 *
 * 契约唯一真理源：docs/contract.md §II。
 */
import {
  IPC_ERROR_CODES,
  type BackupFailureCause,
  type FrontendErrorCode,
  type IpcErrorCode,
} from '../types/ipc.ts';

/** 画布错误载荷的可选扩展字段（CR-20261116-02 §5.2 / §8.2.1）；其它命令恒为 null。 */
export interface IpcErrorDetails {
  readonly currentSha?: string | null;
  readonly cause?: BackupFailureCause | null;
}

/** 统一的 IPC 错误；`code` 是前端唯一判据，`message` 只用于日志与展示。 */
export class EmberIpcError extends Error {
  readonly code: FrontendErrorCode;
  readonly rawCode: string;
  readonly command: string;
  /** 仅 `E_CONFLICT`：磁盘当前版本 sha；`null` 表示目标不存在。 */
  readonly currentSha: string | null;
  /** 仅 `E_BACKUP_FAILED`：备份失败根因类别。 */
  override readonly cause: BackupFailureCause | null;

  constructor(
    command: string,
    code: FrontendErrorCode,
    message: string,
    rawCode: string,
    details: IpcErrorDetails = {},
  ) {
    super(message);
    this.name = 'EmberIpcError';
    this.command = command;
    this.code = code;
    this.rawCode = rawCode;
    this.currentSha = details.currentSha ?? null;
    this.cause = details.cause ?? null;
  }
}

export function ipcFailure(
  command: string,
  code: 'E_INVALID_ARG' | 'E_NOT_FOUND' | 'E_UNKNOWN',
  message: string,
): EmberIpcError {
  return new EmberIpcError(command, code, message, code);
}

export function isIpcErrorCode(code: string): code is IpcErrorCode {
  return (IPC_ERROR_CODES as readonly string[]).includes(code);
}

interface ParsedErrorPayload {
  code: string;
  message: string;
  currentSha: string | null;
  cause: BackupFailureCause | null;
}

function asBackupCause(value: unknown): BackupFailureCause | null {
  return value === 'EACCES' || value === 'ENOSPC' || value === 'E_IO' ? value : null;
}

function parseErrorPayload(value: unknown): ParsedErrorPayload | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.code !== 'string' || typeof record.message !== 'string') return null;
  return {
    code: record.code,
    message: record.message,
    currentSha: typeof record.currentSha === 'string' ? record.currentSha : null,
    cause: asBackupCause(record.cause),
  };
}

function describeRejection(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  const payload = parseErrorPayload(value);
  if (payload) return payload.message;
  return String(value);
}

/**
 * 把任意 rejection 归一成 EmberIpcError：
 * - `{ code, message }` 且 code 在契约表内 → 原样保留；
 * - `{ code, message }` 但 code 未知 → code = E_UNKNOWN，rawCode 保留原值；
 * - 纯字符串 / Error / 其它 → code = E_UNKNOWN，message 取可读文本。
 */
export function toIpcError(command: string, rejection: unknown): EmberIpcError {
  const payload = parseErrorPayload(rejection);
  if (payload) {
    const details: IpcErrorDetails = { currentSha: payload.currentSha, cause: payload.cause };
    if (isIpcErrorCode(payload.code)) {
      return new EmberIpcError(command, payload.code, payload.message, payload.code, details);
    }
    return new EmberIpcError(command, 'E_UNKNOWN', payload.message, payload.code, details);
  }
  return new EmberIpcError(command, 'E_UNKNOWN', describeRejection(rejection), 'E_UNKNOWN');
}

/**
 * 把任意未知错误收敛为可读字符串：
 * - `Error` 实例 → `error.message`；
 * - 字符串 → 原样返回；
 * - 其它 → `fallback`（默认「未知错误」）。
 *
 * 收敛 src 下散落的 `errorMessage` / `messageOf` / `errorMessageOf`：各调用点保留
 * 自身 fallback 文案（固定串或 `String(error)`），Error / string 路径输出逐字不变。
 */
export function formatUnknownError(error: unknown, fallback = '未知错误'): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return fallback;
}
