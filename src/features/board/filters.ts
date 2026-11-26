/**
 * 看板统一筛选状态：范围 / 日期 / 快捷 / 分类列表共用一份可持久化快照。
 * 存储按库隔离；读取时逐项校验，坏值回退默认，不影响看板打开。
 */
import type { BoardQuickFilter } from './scope.ts';

export type BoardListFilter = 'all' | 'unclassified';

export interface BoardFilterState {
  readonly rangeDays: number | null;
  readonly activeDate: string | null;
  readonly quickFilter: BoardQuickFilter;
  readonly listFilter: BoardListFilter;
}

export interface BoardFilterStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const BOARD_FILTER_KEY_PREFIX = 'ember.board.filters.v1.';

export const DEFAULT_BOARD_FILTERS: BoardFilterState = Object.freeze({
  rangeDays: null,
  activeDate: null,
  quickFilter: null,
  listFilter: 'all',
});

const RANGE_DAYS: readonly number[] = Object.freeze([30, 90, 182]);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function boardFilterStorageKey(vaultId: string): string {
  return `${BOARD_FILTER_KEY_PREFIX}${vaultId}`;
}

/** 逐项校验；日期与快捷筛选互斥（日期优先），保持与看板交互一致。 */
export function normalizeBoardFilters(input: unknown): BoardFilterState {
  if (input === null || typeof input !== 'object') return DEFAULT_BOARD_FILTERS;
  const record = input as Record<string, unknown>;
  const rangeDays =
    typeof record.rangeDays === 'number' && RANGE_DAYS.includes(record.rangeDays)
      ? record.rangeDays
      : null;
  const activeDate =
    typeof record.activeDate === 'string' && DATE_PATTERN.test(record.activeDate)
      ? record.activeDate
      : null;
  const quickFilter: BoardQuickFilter =
    activeDate === null && (record.quickFilter === 'week' || record.quickFilter === 'stale')
      ? record.quickFilter
      : null;
  const listFilter: BoardListFilter =
    record.listFilter === 'unclassified' ? 'unclassified' : 'all';
  return { rangeDays, activeDate, quickFilter, listFilter };
}

export function loadBoardFilters(
  storage: BoardFilterStorage,
  vaultId: string,
): BoardFilterState {
  try {
    const raw = storage.getItem(boardFilterStorageKey(vaultId));
    if (raw === null) return DEFAULT_BOARD_FILTERS;
    return normalizeBoardFilters(JSON.parse(raw));
  } catch {
    return DEFAULT_BOARD_FILTERS;
  }
}

export function saveBoardFilters(
  storage: BoardFilterStorage,
  vaultId: string,
  filters: BoardFilterState,
): void {
  try {
    storage.setItem(boardFilterStorageKey(vaultId), JSON.stringify(filters));
  } catch {
    // 配额/隐私模式失败不影响看板主流程，下次交互再尝试。
  }
}

export interface BoardFilterChip {
  readonly key: 'range' | 'date' | 'quick' | 'list';
  readonly label: string;
}

export function describeBoardFilters(filters: BoardFilterState): readonly BoardFilterChip[] {
  const chips: BoardFilterChip[] = [];
  if (filters.rangeDays !== null) {
    chips.push({ key: 'range', label: `近 ${filters.rangeDays} 天` });
  }
  if (filters.activeDate !== null) {
    chips.push({ key: 'date', label: `日期 ${filters.activeDate}` });
  }
  if (filters.quickFilter === 'week') {
    chips.push({ key: 'quick', label: '近 7 天有修改' });
  }
  if (filters.quickFilter === 'stale') {
    chips.push({ key: 'quick', label: '90 天未更新' });
  }
  if (filters.listFilter === 'unclassified') {
    chips.push({ key: 'list', label: '仅未分类' });
  }
  return chips;
}
