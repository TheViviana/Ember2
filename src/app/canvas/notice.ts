export type CanvasNoticeCode =
  | 'E_PRECISION'
  | 'E_REBASED'
  | 'E_CONFLICT'
  | 'E_SAVE_FAILED'
  | 'E_COMMAND'
  | 'E_SCHEMA'
  | 'E_RESIZE_FAILED';

export interface CanvasNotice {
  readonly code: CanvasNoticeCode;
  readonly message: string;
  /** true 供状态栏常驻；false 是一次性 toast 事件。 */
  readonly persistent: boolean;
}

/** 仅精度与冲突提示按码去重；错误与其他状态变化必须逐次送达。 */
export function dispatchCanvasNotice(
  notice: CanvasNotice,
  onceNotices: Set<CanvasNoticeCode>,
  listeners: ReadonlySet<(notice: CanvasNotice) => void>,
): void {
  const once = notice.code === 'E_PRECISION' || notice.code === 'E_CONFLICT';
  if (once && onceNotices.has(notice.code)) return;
  if (once) onceNotices.add(notice.code);
  for (const listener of listeners) listener(notice);
}
