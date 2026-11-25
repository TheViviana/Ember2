/**
 * P5-C2：浮窗渲染层根组件。
 *
 * - 四个常驻容器（W8）：#window-layer / #drag-layer / #modal-layer / #toast-layer，
 *   均 position: fixed + pointer-events: none，仅子节点按需 pointer-events: auto。
 * - #window-layer 顶沿 = var(--topbar-height)（D1：窗永不进顶栏）；其 clientWidth/Height
 *   经 ResizeObserver 写入视口，供 manager 的 open/setGeometry/tile 消费。
 * - 快照来自 useWindowManager（useSyncExternalStore）；最小化窗仍挂载（display:none，W5 保状态），
 *   并在 #toast-layer 底部渲染最小化条。
 * - 内容由注册表取数（getWindowContent）；未注册走 W7 兜底可见提示，不抛错不留白。
 * - 恢复检测演示已改为设置浮窗内的受控入口，由 app 层挂载，本层不再渲染。
 *
 * 本组件是 src/windows/ 渲染文件（引 React）；不引 src/app（gate:layers），
 * app 专属行为（activePath 同步、提示组装）经 props 注入。
 */
import { useEffect, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { WindowFrame } from './WindowFrame.tsx';
import {
  activateWindow,
  closeWindow,
  getWindowContent,
  getWindowZIndex,
  minimizeWindow,
  restoreWindow,
  setViewport,
  setWindowGeometry,
  useWindowManager,
} from './use-window-manager.ts';
import type { WindowRecord } from './manager.ts';
import { Z_DRAG, Z_MODAL, Z_TOAST, Z_WINDOW } from './layer-z.ts';

export interface WindowLayerProps {
  /** 注入 #toast-layer 的提示内容（关窗 flush 提示、重叠提示等），由 app 层组装。 */
  readonly notices?: ReactNode;
  /** 窗口获得焦点时回调（app 层据此同步 activePath，C2 过渡态用）。 */
  readonly onWindowFocus?: (record: WindowRecord) => void;
  /**
   * C4：编辑器窗口的关闭请求转发；返回 true 表示 app 已接管，本次不直接关窗。
   * 仅对 `contentType === 'editor'` 调用（A.6）。
   */
  readonly onRequestClose?: (record: WindowRecord) => boolean;
  /** C4：关闭中的窗口 id；对应窗框禁用 ×、拖动与缩放手柄并弱化视觉。 */
  readonly closingIds?: ReadonlySet<string>;
}

const WINDOW_LAYER_STYLE: CSSProperties = {
  position: 'fixed',
  top: 'var(--topbar-height)',
  left: 0,
  right: 0,
  // 上下栏是覆盖层：浮窗区域让出状态栏高度，避免窗口底边被状态栏压住。
  bottom: 'var(--statusbar-height)',
  pointerEvents: 'none',
  zIndex: Z_WINDOW,
};

const DRAG_LAYER_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  pointerEvents: 'none',
  zIndex: Z_DRAG,
};

const MODAL_LAYER_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  pointerEvents: 'none',
  zIndex: Z_MODAL,
};

const TOAST_LAYER_STYLE: CSSProperties = {
  position: 'fixed',
  left: 0,
  right: 0,
  bottom: 'var(--statusbar-height)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 'var(--space-sm)',
  padding: '0 var(--space-md) var(--space-sm)',
  pointerEvents: 'none',
  zIndex: Z_TOAST,
};

/** §8.7：通知统一右下角，宽 320px；同级子项纵向叠放。 */
const NOTICE_STACK_STYLE: CSSProperties = {
  alignSelf: 'flex-end',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-sm)',
  width: 'min(320px, calc(100vw - var(--space-lg) * 2))',
  pointerEvents: 'auto',
};

const MINIMIZED_BAR_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'center',
  gap: 'var(--space-sm)',
  maxWidth: '100%',
  padding: 'var(--space-xs) var(--space-sm)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--ember-bg-elevated)',
  border: '1px solid var(--ember-border)',
  boxShadow: 'var(--shadow-md)',
  pointerEvents: 'auto',
};

const MINIMIZED_BUTTON_STYLE: CSSProperties = {
  padding: 'var(--space-xs) var(--space-md)',
  border: '1px solid var(--ember-border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--ember-bg-surface)',
  color: 'var(--ember-text-secondary)',
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--text-xs)',
  cursor: 'pointer',
};

const FALLBACK_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  padding: 'var(--space-lg)',
  color: 'var(--ember-text-secondary)',
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--text-sm)',
  textAlign: 'center',
};

function titleFor(record: WindowRecord): string {
  if (record.contentType === 'editor') {
    return record.id.split('/').pop() ?? record.id;
  }
  return record.id;
}

function renderWindowContent(record: WindowRecord): ReactNode {
  const Renderer = getWindowContent(record.contentType);
  if (!Renderer) {
    return <div style={FALLBACK_STYLE}>不支持的内容类型：{record.contentType}</div>;
  }
  return <Renderer record={record} />;
}

export function WindowLayer({
  notices,
  onWindowFocus,
  onRequestClose,
  closingIds,
}: WindowLayerProps) {
  const snapshot = useWindowManager();
  const layerRef = useRef<HTMLDivElement | null>(null);

  // 测量 #window-layer 尺寸作为 manager 视口（已扣顶栏）；窗口缩放时实时更新。
  useEffect(() => {
    const el = layerRef.current;
    if (!el) return;
    const measure = (): void => {
      setViewport({ width: el.clientWidth, height: el.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const minimized = snapshot.windows.filter((w) => w.minimized);

  return (
    <>
      <div id="window-layer" ref={layerRef} style={WINDOW_LAYER_STYLE}>
        {snapshot.windows.map((record) => (
          <WindowFrame
            key={record.id}
            id={record.id}
            title={titleFor(record)}
            contentType={record.contentType}
            geometry={record.geometry}
            zIndex={getWindowZIndex(record.id)}
            focused={snapshot.focusedId === record.id}
            minimized={record.minimized}
            closing={closingIds?.has(record.id) ?? false}
            onGeometryCommit={(geometry) => setWindowGeometry(record.id, geometry)}
            onFocus={() => {
              activateWindow(record.id);
              onWindowFocus?.(record);
            }}
            onClose={() => {
              if (record.contentType === 'editor' && onRequestClose?.(record) === true) return;
              closeWindow(record.id);
            }}
            onMinimize={() => minimizeWindow(record.id)}
          >
            {renderWindowContent(record)}
          </WindowFrame>
        ))}
      </div>

      <div id="drag-layer" style={DRAG_LAYER_STYLE} />
      <div id="modal-layer" style={MODAL_LAYER_STYLE} />

      <div id="toast-layer" style={TOAST_LAYER_STYLE}>
        {minimized.length > 0 ? (
          <div style={MINIMIZED_BAR_STYLE} role="toolbar" aria-label="最小化窗口">
            {minimized.map((record) => (
              <button
                key={record.id}
                type="button"
                style={MINIMIZED_BUTTON_STYLE}
                onClick={() => {
                  restoreWindow(record.id);
                  onWindowFocus?.(record);
                }}
                title={record.id}
              >
                {titleFor(record)}
              </button>
            ))}
          </div>
        ) : null}
        {notices ? (
          <div style={NOTICE_STACK_STYLE}>{notices}</div>
        ) : null}
      </div>
    </>
  );
}
