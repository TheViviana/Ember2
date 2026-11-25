/**
 * P5-C1：焦点判定纯函数。
 *
 * 与 z 序解耦：只回答「下一个该聚焦谁」，不持有状态、不改 records 顺序。
 * 最小化窗口不可聚焦，自动跳过；无候选时返回 null。
 */
import type { WindowRecord } from './manager.ts';

/** 向后取一个可聚焦窗口 id（循环，跳最小化）；无候选返回 null。 */
export function nextFocusableId(
  records: ReadonlyArray<WindowRecord>,
  currentId: string | null,
): string | null {
  return cycle(records, currentId, 1);
}

/** 向前取一个可聚焦窗口 id（循环，跳最小化）；无候选返回 null。 */
export function prevFocusableId(
  records: ReadonlyArray<WindowRecord>,
  currentId: string | null,
): string | null {
  return cycle(records, currentId, -1);
}

function cycle(
  records: ReadonlyArray<WindowRecord>,
  currentId: string | null,
  delta: number,
): string | null {
  const focusable = records.filter((r) => !r.minimized);
  if (focusable.length === 0) return null;

  const currentIdx = currentId ? focusable.findIndex((r) => r.id === currentId) : -1;
  const nextIdx =
    currentIdx === -1
      ? delta > 0
        ? 0
        : focusable.length - 1
      : (currentIdx + delta + focusable.length) % focusable.length;

  const next = focusable[nextIdx];
  return next ? next.id : null;
}
