/**
 * 删除媒体确认框（受控）：不用 window.confirm（WKWebView 教训）。
 */
import styles from '../media-library.module.css';

export interface DeleteConfirmDialogProps {
  readonly path: string;
  readonly deleting: boolean;
  readonly title?: string;
  readonly message?: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function DeleteConfirmDialog({
  path,
  deleting,
  title = '确认删除媒体',
  message,
  onCancel,
  onConfirm,
}: DeleteConfirmDialogProps) {
  return (
    <div className={styles.confirmScrim} role="presentation">
      <div
        className={styles.confirmBox}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
      >
        <p className={styles.confirmText}>
          {message ?? `确认删除 ${path} ？文件将移入回收站。`}
        </p>
        <div className={styles.confirmActions}>
          <button
            type="button"
            className={styles.confirmCancel}
            onClick={onCancel}
            disabled={deleting}
          >
            取消
          </button>
          <button
            type="button"
            className={styles.confirmDanger}
            onClick={onConfirm}
            disabled={deleting}
          >
            {deleting ? '删除中…' : '确认删除'}
          </button>
        </div>
      </div>
    </div>
  );
}
