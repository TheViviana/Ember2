/**
 * CR-20261119-23 C2c：媒体命令错误码 → 中文文案（纯函数，不抛错）。
 *
 * 与 docs/contract.md §II / §III media 对齐：
 * - E_INVALID_ARG：media_delete 只接受 media/ 前缀；
 * - E_READONLY：库只读闩锁；
 * - E_DISK_FULL / E_IO / E_TRASH_FAILED：删除链路既有码；
 * - 未知码回退原始 message；message 为空时带码兜底，绝不抛错。
 * 窗口错误条显示映射文案（text）+ 原始 message（detail，若有且不重复）。
 */

export interface MediaErrorMessage {
  readonly text: string;
  /** 原始 message（若有且不与 text 重复）；未知码回退时为 null。 */
  readonly detail: string | null;
}

export function mapMediaErrorCode(
  code: string | undefined,
  rawMessage: string,
): MediaErrorMessage {
  const message = rawMessage ?? '';
  switch (code) {
    case 'E_INVALID_ARG':
      return { text: '媒体路径不合法（必须位于 media/ 下）', detail: nonEmpty(message) };
    case 'E_NOT_FOUND':
      return { text: '媒体文件不存在', detail: nonEmpty(message) };
    case 'E_READONLY':
      return { text: '当前库为只读，无法删除', detail: nonEmpty(message) };
    case 'E_DISK_FULL':
      return { text: '磁盘空间不足，删除失败', detail: nonEmpty(message) };
    case 'E_IO':
      return { text: 'I/O 失败', detail: nonEmpty(message) };
    case 'E_TRASH_FAILED':
      return { text: '移入回收站失败', detail: nonEmpty(message) };
    default: {
      // 未知码 / 缺码：回退原始 message；空 message 带码兜底，绝不抛错。
      if (message.length > 0) return { text: message, detail: null };
      if (code !== undefined && code !== '') {
        return { text: `媒体操作失败（${code}）`, detail: null };
      }
      return { text: '媒体操作失败', detail: null };
    }
  }
}

function nonEmpty(value: string): string | null {
  return value.length > 0 ? value : null;
}
