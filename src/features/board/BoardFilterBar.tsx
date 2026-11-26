/**
 * 看板统一筛选条：把范围 / 日期 / 快捷筛选 / 分类列表收在一行展示，
 * 任一条件生效时出现，并提供一次性清除。
 */
import { describeBoardFilters, type BoardFilterState } from './filters.ts';
import styles from './BoardView.module.css';

export interface BoardFilterBarProps {
  readonly filters: BoardFilterState;
  readonly matched: number;
  readonly onClear: () => void;
}

export function BoardFilterBar({ filters, matched, onClear }: BoardFilterBarProps) {
  const chips = describeBoardFilters(filters);
  if (chips.length === 0) return null;
  return (
    <div className={styles.filterBar} role="status" aria-label="当前筛选">
      <span className={styles.filterLabel}>当前视图</span>
      {chips.map((chip) => (
        <span key={chip.key} className={styles.filterChip}>
          {chip.label}
        </span>
      ))}
      <span className={styles.filterCount}>命中 {matched} 篇</span>
      <button type="button" className={styles.filterClear} onClick={onClear}>
        清除全部
      </button>
    </div>
  );
}
