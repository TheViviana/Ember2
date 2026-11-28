import styles from './canvas.module.css';

export interface SplitRerunConfirmDialogProps {
  readonly message: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  /** 缺省为整批重跑文案。 */
  readonly title?: string;
  readonly confirmLabel?: string;
}

/** 分块重跑 / 单块重试的二次确认。 */
export function SplitRerunConfirmDialog({
  message,
  onCancel,
  onConfirm,
  title = '确认覆盖',
  confirmLabel = '继续覆盖',
}: SplitRerunConfirmDialogProps) {
  return (
    <div
      className={styles.confirmBackdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className={styles.confirmDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="split-rerun-confirm-title"
      >
        <div className={styles.confirmTitle} id="split-rerun-confirm-title">
          {title}
        </div>
        <p className={styles.confirmText}>{message}</p>
        <div className={styles.confirmActions}>
          <button type="button" className={styles.confirmCancel} onClick={onCancel}>
            取消
          </button>
          <button type="button" className={styles.confirmOk} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}