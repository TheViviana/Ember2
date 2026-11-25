/**
 * CR-20261119-22：备份命令错误码 → 中文文案（纯函数，不抛错）。
 *
 * 与 docs/contract.md §III backup 三命令错误语义对齐（本 CR §2.2）：
 * - E_INVALID_ARG：导出语境 = 目标已存在（绝不覆盖）；校验语境 = 目录不合法；
 * - E_NOT_FOUND：探测语境 = 未在该目录找到备份（正常会被分流为自动导出，罕见以 error 露出）；
 * - E_DISK_FULL：磁盘空间不足；
 * - E_PATH_ESCAPE / E_IO：I/O 失败（携带原始 message）；
 * - 其余未知码：回退原始 message；message 为空时给兜底文案。
 */

export type BackupErrorPhase = 'validate' | 'inspect' | 'export';

export interface BackupErrorMessage {
  readonly text: string;
  readonly tone: 'error' | 'warning';
}

export function mapBackupErrorCode(
  code: string | undefined,
  rawMessage: string | undefined,
  phase: BackupErrorPhase,
): BackupErrorMessage {
  // C2b 复核修订：rawMessage 允许缺省（normalizeFailure 兜底后仍可能为空串）。
  const message = rawMessage ?? '';
  switch (code) {
    case 'E_INVALID_ARG':
      if (phase === 'export') {
        return {
          text: '目标目录已存在，请选择不存在的目录或先检查现有备份',
          tone: 'error',
        };
      }
      return { text: '目录不合法', tone: 'error' };
    case 'E_NOT_FOUND':
      return { text: '未在该目录找到备份', tone: 'warning' };
    case 'E_DISK_FULL':
      return { text: '磁盘空间不足，导出失败', tone: 'error' };
    case 'E_PATH_ESCAPE':
    case 'E_IO':
      return { text: `I/O 失败：${message}`, tone: 'error' };
    case undefined:
      return { text: `备份操作失败：${message.length > 0 ? message : '未知错误'}`, tone: 'error' };
    default: {
      // 未知码回退原始 message；message 为空时保留码兜底，绝不抛错。
      if (message.length > 0) return { text: message, tone: 'error' };
      return { text: `备份操作失败（${code}）`, tone: 'error' };
    }
  }
}
