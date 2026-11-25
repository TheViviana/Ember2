/**
 * §8.4 文档库空态：一句说明 + 主/次两个动作，不显示只有插图的空页。
 */
import type { ReactNode } from 'react';
import styles from './DocumentList.module.css';

export interface DocListEmptyProps {
  readonly onCreate: () => void;
  readonly onImport?: () => void;
}

export function DocListEmpty({ onCreate, onImport }: DocListEmptyProps): ReactNode {
  return (
    <div className={styles.empty}>
      <span className={styles.emptyMark} aria-hidden="true" />
      <p className={styles.emptyTitle}>库中暂无文档</p>
      <p className={styles.emptyHint}>新建一篇，或把 Markdown 文件放进库目录。</p>
      <div className={styles.emptyActions}>
        <button type="button" className={styles.emptyAction} onClick={onCreate}>
          新建文档
        </button>
        {onImport === undefined ? null : (
          <button type="button" className={styles.emptyAction} onClick={onImport}>
            导入文档
          </button>
        )}
      </div>
    </div>
  );
}
