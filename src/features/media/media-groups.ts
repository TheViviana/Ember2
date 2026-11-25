/**
 * CR-20261119-23：媒体库列表纯逻辑——tabs 过滤 / 分组计数 / 排序 / 懒加载切片。
 * 零 React / 零 IPC / 零 app / 零 data（复核修订）；条目为结构化类型，
 * 与 `src/types/ipc.ts` 的 MediaEntryDto 结构兼容（窗口层直传）。
 */

export type MediaKind = 'image' | 'audio' | 'video' | 'doc';
export type MediaTab = 'all' | MediaKind;

/** 列表条目的结构化视图（与 MediaEntryDto 同形）。 */
export interface MediaEntry {
  readonly path: string;
  readonly kind: MediaKind;
  readonly bytes: number;
  readonly modifiedMs: number;
}

export const MEDIA_TABS: readonly MediaTab[] = Object.freeze(['all', 'image', 'audio', 'video', 'doc']);

/** tab 过滤：'all' 原样返回（不复制引用，过滤结果为新数组）。 */
export function filterByTab(entries: readonly MediaEntry[], tab: MediaTab): readonly MediaEntry[] {
  if (tab === 'all') return entries;
  return entries.filter((entry) => entry.kind === tab);
}

/** 各 tab 计数（含 all = 全量）。 */
export function countByTab(entries: readonly MediaEntry[]): Record<MediaTab, number> {
  const counts: Record<MediaTab, number> = {
    all: entries.length,
    image: 0,
    audio: 0,
    video: 0,
    doc: 0,
  };
  for (const entry of entries) counts[entry.kind] += 1;
  return counts;
}

/** 展示排序：modifiedMs 降序；同 ms 按 path 字典序升序（稳定确定）。 */
export function sortForDisplay(entries: readonly MediaEntry[]): readonly MediaEntry[] {
  return [...entries].sort((a, b) => {
    if (a.modifiedMs !== b.modifiedMs) return b.modifiedMs - a.modifiedMs;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}

/** 懒加载切片：首屏 120 条，每次「加载更多」追加 240 条。 */
export const FIRST_SLICE = 120;
export const MORE_SLICE = 240;

export function sliceVisible(entries: readonly MediaEntry[], count: number): readonly MediaEntry[] {
  return entries.slice(0, Math.max(0, count));
}
