/**
 * 关窗协调器的三种面板（进行中 / 确认丢弃 / 失败）。
 * 从 EditorWindow 抽出，避免适配器继续膨胀；动作仍直接调用 close-flow store。
 */
import type { ReactElement } from 'react';
import {
  cancelWindowClose,
  confirmDiscardAndClose,
  forceCloseWindow,
  requestAcceptDeletion,
  resolveWindowCloseConflict,
  retryWindowClose,
} from '../stores/close-flow-store';
import type { CloseFlowView } from '../window-close-flow.ts';
import styles from './EditorWindow.module.css';

export function renderCloseOverlay(view: CloseFlowView | null): ReactElement | null {
  if (view === null) return null;
  if (view.phase === 'working') return <WorkingPanel view={view} />;
  if (view.phase === 'confirming') return <ConfirmPanel view={view} />;
  return <FailurePanel view={view} />;
}

function WorkingPanel({ view }: { readonly view: CloseFlowView }) {
  return (
    <section className={styles.panel} role="status" aria-live="polite">
      <p className={styles.panelTitle}>正在关闭窗口</p>
      <p className={styles.panelHint}>{view.message ?? '正在保存并关闭…'}</p>
    </section>
  );
}

function ConfirmPanel({ view }: { readonly view: CloseFlowView }) {
  return (
    <section className={`${styles.panel} ${styles.panelAlert}`} role="alert">
      <p className={styles.panelTitle}>确认丢弃本地改动？</p>
      <p className={styles.panelHint}>{view.message}</p>
      <div className={styles.panelActions}>
        <button
          type="button"
          className={`${styles.button} ${styles.buttonDanger}`}
          onClick={() => confirmDiscardAndClose(view.windowId)}
        >
          确认关闭并丢弃
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.buttonQuiet}`}
          onClick={() => cancelWindowClose(view.windowId)}
        >
          取消
        </button>
      </div>
    </section>
  );
}

function FailurePanel({ view }: { readonly view: CloseFlowView }) {
  const removed = view.reason === 'conflict-removed';
  const updated = view.reason === 'conflict-updated';
  return (
    <section className={`${styles.panel} ${styles.panelAlert}`} role="alert">
      <p className={styles.panelTitle}>关闭未完成</p>
      <p className={styles.panelHint}>{view.message}</p>
      <div className={styles.panelActions}>
        <button
          type="button"
          className={styles.button}
          onClick={() => retryWindowClose(view.windowId)}
        >
          重试
        </button>
        {removed ? (
          <button
            type="button"
            className={`${styles.button} ${styles.buttonDanger}`}
            onClick={() => requestAcceptDeletion(view.windowId)}
          >
            接受删除
          </button>
        ) : null}
        {updated ? (
          <button
            type="button"
            className={styles.button}
            onClick={() => resolveWindowCloseConflict(view.windowId)}
          >
            处理冲突
          </button>
        ) : null}
        <button
          type="button"
          className={`${styles.button} ${styles.buttonDanger}`}
          onClick={() => forceCloseWindow(view.windowId)}
        >
          强制关闭
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.buttonQuiet}`}
          onClick={() => cancelWindowClose(view.windowId)}
        >
          取消
        </button>
      </div>
    </section>
  );
}
