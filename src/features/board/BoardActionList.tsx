/**
 * 建议项展开后的可执行清单：直接列出命中文档，支持查看详情与在画布定位，
 * 避免用户看完指标还要自己回文档树里找。
 */
import styles from './BoardView.module.css';

export interface BoardActionItem {
  readonly path: string;
  readonly title: string;
  readonly detail?: string;
}

export interface BoardActionListProps {
  readonly title: string;
  readonly total: number;
  readonly items: readonly BoardActionItem[];
  readonly onSelect: (path: string) => void;
  readonly onReveal?: (path: string) => void;
  readonly onDismiss: () => void;
}

export function BoardActionList({
  title,
  total,
  items,
  onSelect,
  onReveal,
  onDismiss,
}: BoardActionListProps) {
  return (
    <section className={styles.actionList} aria-label={`${title}待处理文档`}>
      <header className={styles.actionHeader}>
        <span className={styles.actionTitle}>
          {title} · 共 {total} 项
        </span>
        <button type="button" className={styles.actionDismiss} onClick={onDismiss}>
          收起
        </button>
      </header>
      <ul className={styles.actionRows}>
        {items.map((item) => (
          <li key={item.path} className={styles.actionRow}>
            <button
              type="button"
              className={styles.actionName}
              title={item.path}
              onClick={() => onSelect(item.path)}
            >
              <span className={styles.actionNameText}>{item.title}</span>
              {item.detail === undefined ? null : (
                <span className={styles.actionDetail}>{item.detail}</span>
              )}
            </button>
            <span className={styles.actionButtons}>
              <button
                type="button"
                className={styles.actionButton}
                onClick={() => onSelect(item.path)}
              >
                详情
              </button>
              {onReveal === undefined ? null : (
                <button
                  type="button"
                  className={styles.actionButton}
                  onClick={() => onReveal(item.path)}
                >
                  在画布定位
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {total > items.length ? (
        <p className={styles.actionMore}>
          仅显示前 {items.length} 项，其余可在下方对应卡片继续查看。
        </p>
      ) : null}
    </section>
  );
}
