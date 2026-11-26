/**
 * P5-C2：单扇浮窗的受控展示组件。
 *
 * 职责（仅本组件关心的中间态，提交归 manager）：
 * - 拖动 / 缩放统一机制：pointerdown 标题栏或手柄 → setPointerCapture → pointermove
 *   经 requestAnimationFrame 节流，直接写 el.style.left/top/width/height（不经 React），
 *   pointerup 提交 onGeometryCommit。拖动与缩放共用同一套 applyGeometryToDom，避免
 *   拖动原 transform 方案在 pointerup 清理时与 React 重绘打架产生的 1 帧回跳。
 *   拖动实时 clamp x ≥ 0 / y ≥ 0（相对 window-layer，y=0 即顶栏下沿），右/下界留到
 *   提交时 clampGeometry（D1 用户确认选项）。
 * - 交互置顶：拖动/缩放期间用 local state `interacting` 把 zIndex 提到 Z_DRAG，
 *   状态驱动（非内联 style），React 重渲染不会把它覆盖回 props.zIndex（P3 修复）。
 * - 入场动画（W6）：opacity 0→1 + scale 0.96→1，约 120ms，见 .frameInner。
 * - 最小化（W5）：根 display:none，React 子树仍挂载以保留内容状态。
 * - 可交互性（P0 修复）：.frame 显式 pointer-events: auto，覆盖 #window-layer 的 none。
 *
 * 纯展示：不订阅 store，不引 src/app（gate:layers）；几何/焦点/z 序均由 props 注入。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, type Geometry, type Viewport } from './manager.ts';
import { getViewport } from './use-window-manager.ts';
import { Z_DRAG } from './layer-z.ts';
import { EDITOR_WINDOW_CONTENT, MEDIA_LIBRARY_WINDOW_CONTENT } from './content-types.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { DevRenderFault } from './DevRenderFault.tsx';
import { Icon } from '../ui/icon.tsx';
import styles from './WindowFrame.module.css';

type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
type InteractionMode = 'drag' | 'resize';

const RESIZE_EDGES: ReadonlyArray<ResizeEdge> = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/** 标题栏类型砖图标（§8.6）：14px、1.5 描边，颜色继承类型砖。 */
const EDITOR_ICON = (
  <Icon size={14}>
    <path d="M6 3.5h7l5 5V20a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 1.5-1.5Z" />
    <path d="M13 3.5V9h5" />
    <path d="M8.5 13h7M8.5 16.5h5" />
  </Icon>
);

const MEDIA_ICON = (
  <Icon size={14}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="8.5" cy="9" r="1.5" />
    <path d="m4 17 5-5 4 4 3-3 4 4" />
  </Icon>
);

function typeIconFor(contentType: string): ReactNode {
  if (contentType === MEDIA_LIBRARY_WINDOW_CONTENT) return MEDIA_ICON;
  if (contentType === EDITOR_WINDOW_CONTENT) return EDITOR_ICON;
  return EDITOR_ICON;
}

export interface WindowFrameProps {
  readonly id: string;
  readonly title: string;
  readonly contentType: string;
  readonly geometry: Geometry;
  readonly zIndex: number;
  readonly focused: boolean;
  readonly minimized: boolean;
  /** C4：关闭协调器接管中；禁用 ×、拖动与缩放手柄并弱化视觉。 */
  readonly closing?: boolean;
  readonly onGeometryCommit: (geometry: Geometry) => void;
  readonly onFocus: () => void;
  readonly onClose: () => void;
  readonly onMinimize: () => void;
  readonly children: ReactNode;
}

interface DragState {
  readonly startX: number;
  readonly startY: number;
  readonly origX: number;
  readonly origY: number;
  readonly width: number;
  readonly height: number;
}

interface ResizeState {
  readonly startX: number;
  readonly startY: number;
  readonly orig: Geometry;
  readonly edge: ResizeEdge;
  readonly viewport: Viewport;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 依据手柄方向与指针位移计算新几何；尺寸钳到 [MIN, 视口剩余]，位置随边联动。 */
function computeResize(state: ResizeState, clientX: number, clientY: number): Geometry {
  const { orig, edge } = state;
  const vp = state.viewport;
  const vpW = Math.max(0, vp.width);
  const vpH = Math.max(0, vp.height);
  const dx = clientX - state.startX;
  const dy = clientY - state.startY;

  let { x, y, width, height } = orig;

  if (edge.includes('e')) {
    width = clamp(orig.width + dx, MIN_WINDOW_WIDTH, Math.max(MIN_WINDOW_WIDTH, vpW - x));
  }
  if (edge.includes('w')) {
    const maxWidth = orig.width + orig.x; // x 退到 0 时的最大宽度
    width = clamp(orig.width - dx, MIN_WINDOW_WIDTH, Math.max(MIN_WINDOW_WIDTH, maxWidth));
    x = orig.x + orig.width - width;
  }
  if (edge.includes('s')) {
    height = clamp(orig.height + dy, MIN_WINDOW_HEIGHT, Math.max(MIN_WINDOW_HEIGHT, vpH - y));
  }
  if (edge.includes('n')) {
    const maxHeight = orig.height + orig.y;
    height = clamp(orig.height - dy, MIN_WINDOW_HEIGHT, Math.max(MIN_WINDOW_HEIGHT, maxHeight));
    y = orig.y + orig.height - height;
  }

  return { x, y, width, height };
}

export function WindowFrame({
  id,
  title,
  contentType,
  geometry,
  zIndex,
  focused,
  minimized,
  closing = false,
  onGeometryCommit,
  onFocus,
  onClose,
  onMinimize,
  children,
}: WindowFrameProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [interacting, setInteracting] = useState(false);
  const modeRef = useRef<InteractionMode | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const rafRef = useRef<number | null>(null);
  const latestRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  useEffect(() => {
    const selectGuard = styles.selectGuard;
    if (!interacting || !selectGuard) return;
    document.body.classList.add(selectGuard);
    return () => {
      document.body.classList.remove(selectGuard);
    };
  }, [interacting]);

  function applyGeometryToDom(cur: Geometry): void {
    const root = rootRef.current;
    if (!root) return;
    root.style.left = `${cur.x}px`;
    root.style.top = `${cur.y}px`;
    root.style.width = `${cur.width}px`;
    root.style.height = `${cur.height}px`;
  }

  const { x: geometryX, y: geometryY, width: geometryWidth, height: geometryHeight } = geometry;
  useLayoutEffect(() => {
    if (modeRef.current !== null) return;
    applyGeometryToDom({ x: geometryX, y: geometryY, width: geometryWidth, height: geometryHeight });
  }, [geometryX, geometryY, geometryWidth, geometryHeight]);

  /** 依据当前交互模式与最新指针位置计算几何；无交互返回 null。 */
  function computeCurrentGeometry(): Geometry | null {
    const mode = modeRef.current;
    if (mode === 'drag') {
      const drag = dragRef.current;
      if (!drag) return null;
      // 实时 clamp ≥0：标题栏始终可见；右/下界留到提交钳制，避免拖动跳变。
      const nx = Math.max(0, drag.origX + (latestRef.current.x - drag.startX));
      const ny = Math.max(0, drag.origY + (latestRef.current.y - drag.startY));
      return { x: nx, y: ny, width: drag.width, height: drag.height };
    }
    if (mode === 'resize') {
      const resize = resizeRef.current;
      if (!resize) return null;
      return computeResize(resize, latestRef.current.x, latestRef.current.y);
    }
    return null;
  }

  /** rAF 节流写 DOM：pointermove 只更新 latestRef，实际写盘合并到下一帧。 */
  function scheduleFrame(): void {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const cur = computeCurrentGeometry();
      if (cur) applyGeometryToDom(cur);
    });
  }

  function beginCapture(event: ReactPointerEvent<HTMLDivElement>): void {
    const root = rootRef.current;
    if (!root) return;
    root.setPointerCapture(event.pointerId);
    latestRef.current = { x: event.clientX, y: event.clientY };
  }

  function handleTitlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (closing) return;
    // 点中标题栏按钮（最小化/关闭）不启动拖动。
    if ((event.target as HTMLElement).closest('button')) return;
    event.preventDefault();
    onFocus();
    beginCapture(event);
    modeRef.current = 'drag';
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      origX: geometry.x,
      origY: geometry.y,
      width: geometry.width,
      height: geometry.height,
    };
  }

  function handleResizePointerDown(edge: ResizeEdge, event: ReactPointerEvent<HTMLDivElement>): void {
    if (closing) return;
    event.stopPropagation();
    event.preventDefault();
    onFocus();
    beginCapture(event);
    modeRef.current = 'resize';
    resizeRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      orig: { ...geometry },
      edge,
      viewport: getViewport(),
    };
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    if (modeRef.current === null) return;
    latestRef.current = { x: event.clientX, y: event.clientY };
    // 首次移动再提升 z 序：纯点击（不拖动）不触发无谓重渲染。
    if (!interacting) setInteracting(true);
    scheduleFrame();
  }

  function endInteraction(event: ReactPointerEvent<HTMLDivElement>): void {
    const root = rootRef.current;
    if (root && root.hasPointerCapture(event.pointerId)) {
      root.releasePointerCapture(event.pointerId);
    }
    if (modeRef.current === null) return;

    // 落定前把最后一帧几何立即写盘（取消未执行的 rAF，用最新坐标算最终值）。
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const finalGeometry = computeCurrentGeometry();
    if (finalGeometry) applyGeometryToDom(finalGeometry);

    modeRef.current = null;
    dragRef.current = null;
    resizeRef.current = null;
    setInteracting(false);

    if (finalGeometry) onGeometryCommit(finalGeometry);
  }

  const frameClassName = `${styles.frame}${focused ? ` ${styles.frameFocused}` : ''}${
    closing ? ` ${styles.frameClosing}` : ''
  }`;
  const effectiveZIndex = interacting ? Z_DRAG : zIndex;

  return (
    <div
      ref={rootRef}
      className={frameClassName}
      aria-busy={closing || undefined}
      style={{
        zIndex: effectiveZIndex,
        display: minimized ? 'none' : undefined,
      }}
      onPointerDown={onFocus}
      onPointerMove={handlePointerMove}
      onPointerUp={endInteraction}
      onPointerCancel={endInteraction}
    >
      <div className={styles.frameInner}>
        <header className={styles.titlebar} onPointerDown={handleTitlePointerDown}>
          <div className={styles.titleGroup}>
            <span className={styles.typeBrick} aria-hidden="true">
              {typeIconFor(contentType)}
            </span>
            <span className={styles.title} title={id}>{title}</span>
          </div>
          <div className={styles.controls}>
            <button
              type="button"
              className={styles.controlButton}
              onClick={onMinimize}
              title="最小化"
              aria-label="最小化窗口"
            >
              <Icon size={12} viewBox="0 0 12 12">
                <path d="M2.5 6h7" />
              </Icon>
            </button>
            <button
              type="button"
              className={`${styles.controlButton} ${styles.controlButtonClose}`}
              onClick={onClose}
              disabled={closing}
              title="关闭"
              aria-label="关闭窗口"
            >
              <Icon size={12} viewBox="0 0 12 12">
                <path d="m2.5 2.5 7 7M9.5 2.5l-7 7" />
              </Icon>
            </button>
          </div>
        </header>
        <div className={styles.content}>
          <ErrorBoundary scope="window" resetKey={id}>
            <DevRenderFault windowId={id}>{children}</DevRenderFault>
          </ErrorBoundary>
        </div>
      </div>
      {RESIZE_EDGES.map((edge) => (
        <div
          key={edge}
          className={`${styles.handle} ${styles[`handle${edge.toUpperCase()}`]}`}
          onPointerDown={(event) => handleResizePointerDown(edge, event)}
        />
      ))}
    </div>
  );
}
