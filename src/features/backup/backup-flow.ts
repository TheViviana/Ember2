/**
 * CR-20261119-22：备份 UI 纯流程函数（无 React / 无 IPC / 无时钟副作用）。
 *
 * - validateBackupName：backupName 严格白名单（2026-11-19 复核修订：^[A-Za-z0-9._-]+$，
 *   另拒 `.`、`..`（含串中双点）、首尾 `.`、Windows 保留设备名）；
 * - buildDestination：拼 `<父目录>/<backupName>` 子路径（export / inspect 共用语义）；
 * - generateDefaultBackupName：`ember-<YYYYMMDD-HHmmss>` 默认名（本地时间，纯函数收 Date）；
 * - classifyInspectResult / classifyExportResult：IPC 结果分流（探测已有 → 展示；
 *   探测不存在 → 导出；其它 → error），保证导出失败绝不标记成功。
 */

import { isReservedDeviceName } from '../../core/reserved-names.ts';
import type { BackupInspectDto, BackupReportDto } from '../../types/ipc.ts';

/** backupName 白名单：仅字母 / 数字 / 点 / 下划线 / 连字符（空格与所有分隔符天然被拒）。 */
const BACKUP_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/** 备份名合法性：非法一律 false，绝不抛错（调用方据此禁用「检查/导出」）。 */
export function validateBackupName(name: string): boolean {
  if (name.length === 0) return false;
  if (!BACKUP_NAME_PATTERN.test(name)) return false;
  if (name.includes('..')) return false;
  if (name === '.') return false;
  if (name.startsWith('.') || name.endsWith('.')) return false;
  // Windows 保留名按 stem 判（首个点之前）：CON.txt / COM1.log 等同样拒绝（C2b 复核修订）。
  // 清单与判定统一由 core/reserved-names.ts 提供（CR-R1-5）。
  if (isReservedDeviceName(name)) return false;
  return true;
}

/** 拼 `<父目录>/<backupName>` 子路径；目录为空或备份名非法时返回 null（不猜路径）。 */
export function buildDestination(dir: string, name: string): string | null {
  if (dir.length === 0) return null;
  if (!validateBackupName(name)) return null;
  const sep = dir.endsWith('/') || dir.endsWith('\\') ? '' : '/';
  return `${dir}${sep}${name}`;
}

/** 默认备份名 `ember-<YYYYMMDD-HHmmss>`（本地时间；由调用方传入 now 保持纯函数）。 */
export function generateDefaultBackupName(now: Date): string {
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const y = String(now.getFullYear()).padStart(4, '0');
  const mo = p2(now.getMonth() + 1);
  const d = p2(now.getDate());
  const h = p2(now.getHours());
  const mi = p2(now.getMinutes());
  const s = p2(now.getSeconds());
  return `ember-${y}${mo}${d}-${h}${mi}${s}`;
}

// ─── IPC 结果分流（组件据此决定 dispatch 哪个 action）──────────────────────

/** effects 层 reject 出来的错误形状（AppShell rethrow 后为 Error + code = rawCode）。 */
export interface IpcFailure {
  readonly code?: string;
  readonly message: string;
}

/**
 * 任意 reject 值归一为 IpcFailure（C2b 复核修订：catch 里不再手摆形状）：
 * - Error → 取 message 与自定义 code（EmberIpcError 经 rethrow 后 code = rawCode）；
 * - string → 直接作 message；
 * - 其它 / null / undefined → 通用兜底文案（绝不抛错，异步零吞错）。
 */
export function normalizeFailure(e: unknown): IpcFailure {
  if (e instanceof Error) {
    return { code: (e as { code?: string }).code, message: e.message };
  }
  if (typeof e === 'string') {
    return { code: undefined, message: e };
  }
  return { code: undefined, message: '备份操作失败' };
}

export type InspectOutcome =
  | { readonly kind: 'inspect-found'; readonly inspect: BackupInspectDto }
  | { readonly kind: 'should-export' }
  | { readonly kind: 'error'; readonly code: string | undefined; readonly message: string };

/** 探测结果分流：已有备份 → 展示检查结果；E_NOT_FOUND → 自动导出；其它 → error。 */
export function classifyInspectResult(
  outcome:
    | { readonly ok: true; readonly inspect: BackupInspectDto }
    | { readonly ok: false; readonly failure: IpcFailure },
): InspectOutcome {
  if (outcome.ok) {
    return { kind: 'inspect-found', inspect: outcome.inspect };
  }
  if (outcome.failure.code === 'E_NOT_FOUND') {
    return { kind: 'should-export' };
  }
  return { kind: 'error', code: outcome.failure.code, message: outcome.failure.message };
}

export type ExportOutcome =
  | { readonly kind: 'export-done'; readonly report: BackupReportDto }
  | { readonly kind: 'error'; readonly code: string | undefined; readonly message: string };

/** 导出结果分流：成功才标记 export-done；任何 reject（含 E_INVALID_ARG 竞态兜底）一律 error。 */
export function classifyExportResult(
  outcome:
    | { readonly ok: true; readonly report: BackupReportDto }
    | { readonly ok: false; readonly failure: IpcFailure },
): ExportOutcome {
  if (outcome.ok) {
    return { kind: 'export-done', report: outcome.report };
  }
  return { kind: 'error', code: outcome.failure.code, message: outcome.failure.message };
}
