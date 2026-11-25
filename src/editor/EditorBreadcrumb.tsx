/**
 * 浮窗顶栏面包屑：库名 / 目录 / 文档标题。
 *
 * 只做展示，不负责跳转；章节级面包屑本轮不实现。
 */
import styles from './EditorView.module.css';

export interface EditorBreadcrumbProps {
  readonly path: string;
  readonly title: string;
  readonly libraryName: string | null;
}

export function EditorBreadcrumb({ path, title, libraryName }: EditorBreadcrumbProps) {
  const segments = path.split('/').filter((segment) => segment !== '');
  const directories = segments.slice(0, -1);
  return (
    <nav className={styles.breadcrumb} aria-label="文档位置">
      <span className={styles.breadcrumbLibrary}>{libraryName ?? '库'}</span>
      {directories.map((directory) => (
        <span key={directory} className={styles.breadcrumbSegment}>
          <span className={styles.breadcrumbSeparator} aria-hidden="true">/</span>
          {directory}
        </span>
      ))}
      <span className={styles.breadcrumbSeparator} aria-hidden="true">/</span>
      <span className={styles.breadcrumbTitle} title={path}>{title}</span>
    </nav>
  );
}
