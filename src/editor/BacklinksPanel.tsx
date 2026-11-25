/**
 * 反向链接面板：按需建立的索引，未建立时明确提示「索引未建立」。
 */
import styles from './EditorView.module.css';

export interface BacklinkItem {
  readonly path: string;
  readonly title: string;
}

export interface BacklinksState {
  readonly status: 'idle' | 'building' | 'ready' | 'error';
  readonly items: readonly BacklinkItem[];
  readonly error: string | null;
}

export interface BacklinksPanelProps {
  readonly state: BacklinksState;
  readonly onBuild: () => void;
  readonly onOpen: (path: string) => void;
}

export function BacklinksPanel({ state, onBuild, onOpen }: BacklinksPanelProps) {
  const building = state.status === 'building';
  return (
    <section className={styles.backlinks} aria-label="反向链接">
      <header className={styles.backlinksHeader}>
        <span className={styles.backlinksTitle}>
          反向链接
          {state.status === 'ready' ? ` · ${state.items.length}` : ''}
        </span>
        <button
          type="button"
          className={styles.backlinksBuild}
          onClick={onBuild}
          disabled={building}
        >
          {building ? '建立中…' : state.status === 'ready' ? '刷新索引' : '建立链接索引'}
        </button>
      </header>
      {state.status === 'idle' ? (
        <p className={styles.backlinksHint}>索引未建立，结果可能不完整。</p>
      ) : null}
      {state.status === 'error' ? (
        <p className={styles.backlinksError} role="alert">{state.error ?? '建立索引失败'}</p>
      ) : null}
      {state.status === 'ready' && state.items.length === 0 ? (
        <p className={styles.backlinksHint}>暂无引用本文档的文档。</p>
      ) : null}
      {state.items.length > 0 ? (
        <ul className={styles.backlinksList}>
          {state.items.map((item) => (
            <li key={item.path}>
              <button
                type="button"
                className={styles.backlinksItem}
                title={item.path}
                onClick={() => onOpen(item.path)}
              >
                {item.title}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
