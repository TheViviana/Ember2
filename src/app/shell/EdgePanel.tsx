/**
 * C0-C R9'（2026-11-18 用户追认，取代原 R9=D）：可折叠边缘面板。
 *
 * 默认收起，视觉上不显示窄把手；指针进入边缘热区或面板时展开，离开后由控制器延迟收起。
 * 展开态为浮窗卡片（圆角/描边/阴影），高度随内容自适应，宽度上限 360px。
 * 面板层级高于 #window-layer（--layer-sidebar-overlay 1500 > Z_WINDOW 1000），
 * 低于拖拽预览层 Z_DRAG 2000，浮窗打开时列表仍可点用。
 * 键盘入口为视觉隐藏（sr-only）的展开按钮，保留可聚焦性，禁用 display:none / visibility:hidden。
 */
import type { ReactNode } from 'react';
import type { EdgePanelSide } from './edge-panel-state.ts';
import styles from './AppShell.module.css';

export interface EdgePanelProps {
  readonly side: EdgePanelSide;
  readonly label: string;
  readonly open: boolean;
  readonly pinned: boolean;
  readonly onHover: (hovered: boolean) => void;
  readonly onToggle: () => void;
  readonly onPin: (pinned: boolean) => void;
  readonly children: ReactNode;
}

export function EdgePanel({
  side,
  label,
  open,
  pinned,
  onHover,
  onToggle,
  onPin,
  children,
}: EdgePanelProps) {
  const panelId = `edge-panel-${side}`;
  return (
    <div
      className={`${styles.edge} ${side === 'left' ? styles.edgeLeft : styles.edgeRight} ${
        open ? '' : styles.edgeClosed
      }`}
    >
      <div
        className={styles.edgeHotzone}
        aria-hidden="true"
        onPointerEnter={() => onHover(true)}
        onPointerLeave={() => onHover(false)}
      />
      {open ? null : (
        <button
          type="button"
          className={styles.edgeSrOnly}
          aria-expanded={false}
          aria-controls={panelId}
          aria-label={`展开${label}`}
          onClick={onToggle}
        >
          展开{label}
        </button>
      )}
      <aside
        id={panelId}
        className={styles.edgePanel}
        aria-label={label}
        aria-hidden={!open}
        inert={!open}
        onPointerEnter={() => onHover(true)}
        onPointerLeave={() => onHover(false)}
      >
        <div className={styles.edgePanelBar}>
          <span className={styles.edgePanelTitle}>{label}</span>
          <button
            type="button"
            className={styles.edgeBarButton}
            aria-pressed={pinned}
            aria-label={pinned ? `取消固定${label}` : `固定${label}`}
            title={pinned ? '取消固定' : '固定展开'}
            onClick={() => onPin(!pinned)}
          >
            钉
          </button>
          <button
            type="button"
            className={styles.edgeBarButton}
            aria-label={`收起${label}`}
            title="收起"
            onClick={onToggle}
          >
            ×
          </button>
        </div>
        <div className={styles.edgePanelBody}>{children}</div>
      </aside>
    </div>
  );
}
