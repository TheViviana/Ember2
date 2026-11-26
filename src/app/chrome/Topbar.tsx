/**
 * 顶栏：中部模式切换（画布/看板），右侧搜索 → 连接状态 → 设置。
 * 交通灯=系统原生（tauri.conf titleBarStyle:'Overlay' + hiddenTitle，悬浮于顶栏之上，
 * 关闭经 close-guard 的 onCloseRequested 两阶段拦截）；整条作为窗口拖拽区，交互元素显式排除拖拽。
 */
import type { RefObject } from 'react';
import { useEmberStore } from '../stores/ember-store';
import type { WorkspaceMode } from '../stores/canvas-session-store';
import { Icon } from '../../ui/icon.tsx';
import styles from './Topbar.module.css';

export interface TopbarProps {
  readonly mode: WorkspaceMode;
  readonly onModeChange: (mode: WorkspaceMode) => void;
  /** 打开命令面板（§8.5：顶栏搜索指向唯一全局搜索入口）。 */
  readonly onOpenSearch?: () => void;
  /** 打开设置壳（由 AppShell 持有壳状态）。 */
  readonly onOpenSettings?: () => void;
  /** 设置壳是否展开（aria-expanded）。 */
  readonly settingsOpen?: boolean;
  /** 设置关闭后由 AppShell 把焦点还给这个按钮。 */
  readonly settingsButtonRef?: RefObject<HTMLButtonElement | null>;
  /** 专注模式（CR-20261121-45 项6）：编辑器/浮窗阅读时顶栏淡出 30%，悬停恢复。 */
  readonly focusFade?: boolean;
}

const CANVAS_ICON = (
  <Icon size={14}>
    <rect x="3" y="3" width="18" height="18" rx="2.5" />
    <circle cx="8.5" cy="8.5" r="1.6" />
    <circle cx="15.5" cy="15.5" r="1.6" />
    <path d="M9.7 9.7l4.6 4.6" />
  </Icon>
);

const BOARD_ICON = (
  <Icon size={14}>
    <rect x="3" y="4" width="4.5" height="16" rx="1.2" />
    <rect x="9.75" y="4" width="4.5" height="11" rx="1.2" />
    <rect x="16.5" y="4" width="4.5" height="7" rx="1.2" />
  </Icon>
);

const SEARCH_ICON = (
  <Icon size={16}>
    <circle cx="11" cy="11" r="6" />
    <path d="M15.5 15.5 21 21" />
  </Icon>
);

const SETTINGS_ICON = (
  <Icon size={16}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
  </Icon>
);

/** 顶栏提示：第一行名称，第二行可选快捷键（如 ⌘K）。 */
function Tip({ label, shortcut }: { readonly label: string; readonly shortcut?: string }) {
  return (
    <span className={styles.tooltip} aria-hidden="true">
      {label}
      {shortcut !== undefined ? <kbd className={styles.tooltipShortcut}>{shortcut}</kbd> : null}
    </span>
  );
}

function connectionOf(status: string): { readonly label: string; readonly tone: string } {
  if (status === 'ready') return { label: '本地 · 已连接', tone: 'ok' };
  if (status === 'failed' || status === 'disposed') return { label: '本地 · 未连接', tone: 'bad' };
  return { label: '本地 · 连接中', tone: 'wait' };
}

export function Topbar({
  mode,
  onModeChange,
  onOpenSearch,
  onOpenSettings,
  settingsOpen = false,
  settingsButtonRef,
  focusFade = false,
}: TopbarProps) {
  const readonly = useEmberStore((state) => state.identity?.readonly ?? false);
  const coreStatus = useEmberStore((state) => state.status);
  const connection = connectionOf(coreStatus);
  const active = mode === 'docs' ? 'docs' : 'canvas';

  return (
    <header className={`${styles.topbar} ${focusFade ? styles.focusFade : ''}`}>
      {/* 只保留顶部一条窄拖拽带：顶栏下方的内容仍可被选中/拖拽。 */}
      <span className={styles.dragHandle} data-tauri-drag-region aria-hidden="true" />

      <div className={styles.center} data-no-drag-region="true">
        <div
          className={styles.modeSwitch}
          data-active={active}
          role="group"
          aria-label="主区模式"
        >
          <span className={styles.modeIndicator} aria-hidden="true" />
          <button
            type="button"
            className={styles.iconButton}
            aria-label="画布"
            aria-pressed={active === 'canvas'}
            onClick={() => onModeChange('canvas')}
          >
            {CANVAS_ICON}
            <span className={styles.modeLabel}>画布</span>
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="看板"
            aria-pressed={active === 'docs'}
            onClick={() => onModeChange('docs')}
          >
            {BOARD_ICON}
            <span className={styles.modeLabel}>看板</span>
          </button>
        </div>
      </div>

      <div className={styles.trailing} data-no-drag-region="true">
        {readonly ? <span className={styles.readonly}>只读</span> : null}
        {onOpenSearch ? (
          <button
            type="button"
            className={styles.iconButton}
            aria-label="搜索"
            onClick={onOpenSearch}
          >
            {SEARCH_ICON}
            <Tip label="搜索" shortcut="⌘K" />
          </button>
        ) : null}
        <span
          className={styles.connection}
          data-tone={connection.tone}
          title={connection.label}
          role="status"
        >
          <span className={styles.connectionDot} aria-hidden="true" />
          {connection.label}
        </span>
        {onOpenSettings ? (
          <button
            ref={settingsButtonRef}
            type="button"
            className={`${styles.iconButton} ${settingsOpen ? styles.iconButtonActive : ''}`}
            aria-label="设置"
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            onClick={onOpenSettings}
          >
            {SETTINGS_ICON}
            <Tip label="设置" />
          </button>
        ) : null}
      </div>
    </header>
  );
}
