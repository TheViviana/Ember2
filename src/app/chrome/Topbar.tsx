/**
 * 顶栏：品牌、主区模式切换、只读标记与设置入口。
 * 交通灯=系统原生（tauri.conf titleBarStyle:'Overlay' + hiddenTitle，悬浮于顶栏之上，
 * 关闭经 close-guard 的 onCloseRequested 两阶段拦截）；整条作为窗口拖拽区，交互元素显式排除拖拽。
 */
import type { RefObject } from 'react';
import { useEmberStore } from '../stores/ember-store';
import type { WorkspaceMode } from '../stores/canvas-session-store';
import styles from './Topbar.module.css';

export interface TopbarProps {
  readonly mode: WorkspaceMode;
  readonly onModeChange: (mode: WorkspaceMode) => void;
  /** 打开设置下拉菜单（由 AppShell 持有壳状态）。 */
  readonly onOpenSettings?: () => void;
  /** 设置下拉是否展开（aria-expanded）。 */
  readonly settingsOpen?: boolean;
  /** 设置关闭后由 AppShell 把焦点还给这个按钮。 */
  readonly settingsButtonRef?: RefObject<HTMLButtonElement | null>;
  /** 专注模式（CR-20261121-45 项6）：编辑器/浮窗阅读时顶栏淡出 30%，悬停恢复。 */
  readonly focusFade?: boolean;
}

export function Topbar({
  mode,
  onModeChange,
  onOpenSettings,
  settingsOpen = false,
  settingsButtonRef,
  focusFade = false,
}: TopbarProps) {
  const readonly = useEmberStore((state) => state.identity?.readonly ?? false);

  return (
    <header
      className={`${styles.topbar} ${focusFade ? styles.focusFade : ""}`}
      data-tauri-drag-region
    >
      <div className={styles.brand}>
        <span className={styles.brandName}>Ember</span>
        <span className={styles.brandVersion}>2.0</span>
      </div>
      {onOpenSettings ? (
        <button
          ref={settingsButtonRef}
          type="button"
          className={`${styles.settingsButton} ${settingsOpen ? styles.settingsActive : ''}`}
          aria-label="设置"
          title="设置"
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          onClick={onOpenSettings}
          data-no-drag-region="true"
        >
          {/* CR-20261121-58：设置钮图标化（16px 细线齿轮） */}
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
          </svg>
        </button>
      ) : null}
      <div className={styles.modes} role="group" aria-label="主区模式" data-no-drag-region="true">
        <button
          type="button"
          className={`${styles.modeButton} ${mode === 'canvas' ? styles.modeActive : ''}`}
          aria-pressed={mode === 'canvas'}
          onClick={() => onModeChange('canvas')}
        >
          画布
        </button>
        <button
          type="button"
          className={`${styles.modeButton} ${mode === 'docs' ? styles.modeActive : ''}`}
          aria-pressed={mode === 'docs'}
          onClick={() => onModeChange('docs')}
        >
          看板
        </button>
      </div>
      <span className={styles.spacer} />
      {readonly ? <span className={styles.readonly}>只读</span> : null}
    </header>
  );
}
