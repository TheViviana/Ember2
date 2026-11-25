/**
 * 2026-11-23：看板范围/下钻的纯过滤层。
 *
 * 看板三层范围语义：
 * - rangeDays：全局范围（null=全部；30/90/182 按最后修改时间）；
 * - activeDate：热力图点选的单日（本地日期）；
 * - quickFilter：KPI/建议条快捷筛选（week=近 7 天有修改，stale=90 天未更新）。
 * range 与下钻同时存在时取交集；快捷筛选中的 stale 需要全库（不含 range）才有意义。
 */
import { DAY_MS, localDateKey } from './model.ts';

export const BOARD_STALE_DAYS = 90;
export const BOARD_WEEK_DAYS = 7;

export type BoardQuickFilter = 'week' | 'stale' | null;

export interface BoardScopeOptions {
  readonly now: number;
  readonly rangeDays?: number | null;
  readonly activeDate?: string | null;
  readonly quickFilter?: BoardQuickFilter;
}

export function filterBoardDocs<T extends { readonly modifiedMs: number }>(
  docs: readonly T[],
  options: BoardScopeOptions,
): readonly T[] {
  const rangeDays = options.rangeDays ?? null;
  const activeDate = options.activeDate ?? null;
  const quickFilter = options.quickFilter ?? null;
  const rangeCutoff = rangeDays === null ? -Infinity : options.now - rangeDays * DAY_MS;
  const weekCutoff = options.now - BOARD_WEEK_DAYS * DAY_MS;
  const staleCutoff = options.now - BOARD_STALE_DAYS * DAY_MS;
  const out: T[] = [];
  for (const doc of docs) {
    if (rangeDays !== null && doc.modifiedMs < rangeCutoff) continue;
    if (activeDate !== null && localDateKey(doc.modifiedMs) !== activeDate) continue;
    if (quickFilter === 'week' && doc.modifiedMs < weekCutoff) continue;
    if (quickFilter === 'stale' && doc.modifiedMs >= staleCutoff) continue;
    out.push(doc);
  }
  return out;
}
