/**
 * 应用内指针拖拽通道（文档行 / 媒体卡片共用）。
 *
 * WKWebView 对 `draggable` 元素不发起 HTML5 拖拽（CR-20261119-07 已验证），故统一改为
 * 指针会话：pointerdown 进入 pending，位移达到阈值升级为 dragging；pointerup 由调用方
 * 用 `document.elementFromPoint` 命中 `[data-canvas-drop-host]` 后派发本通道。
 *
 * 载荷与 `dnd/protocol.ts` 的 DocPayload / MediaPayload 同形，落点侧无需再分叉解析；
 * 媒体类型由落点按 `media/` 前缀与扩展名判定，避免拖动侧闭包携带列表项。
 */

import type { DocPayload, FilesPayload, MediaPayload, TextPayload } from './protocol.ts';

export type PointerDragPayload = DocPayload | MediaPayload | TextPayload | FilesPayload;

export const POINTER_DRAG_THRESHOLD_PX = 8;

export const POINTER_DRAG_DROP_EVENT = 'ember:pointer-drag-drop';

export interface PointerDragPoint {
  readonly x: number;
  readonly y: number;
}

export type PointerDragSession =
  | {
      readonly phase: 'pending';
      readonly payload: PointerDragPayload;
      readonly pointerId: number;
      readonly start: PointerDragPoint;
    }
  | {
      readonly phase: 'dragging';
      readonly payload: PointerDragPayload;
      readonly pointerId: number;
      readonly start: PointerDragPoint;
      readonly current: PointerDragPoint;
    };

export interface PointerDragDropDetail {
  readonly payload: PointerDragPayload;
  readonly clientX: number;
  readonly clientY: number;
}

export function beginPointerDragSession(
  payload: PointerDragPayload,
  pointerId: number,
  start: PointerDragPoint,
): PointerDragSession {
  return { phase: 'pending', payload, pointerId, start };
}

/**
 * 同一指针的移动才推进会话；位移达到阈值即升级为 dragging。
 * 返回 null 表示事件不属于当前会话（多指/迟到的 move），调用方应忽略。
 */
export function movePointerDragSession(
  session: PointerDragSession,
  pointerId: number,
  point: PointerDragPoint,
): PointerDragSession | null {
  if (session.pointerId !== pointerId) return null;
  if (session.phase === 'dragging') return { ...session, current: point };
  const distance = Math.hypot(point.x - session.start.x, point.y - session.start.y);
  if (distance < POINTER_DRAG_THRESHOLD_PX) return session;
  return {
    phase: 'dragging',
    payload: session.payload,
    pointerId,
    start: session.start,
    current: point,
  };
}

/** pointerup 时只有进入 dragging 才允许落点建节点；其余视为普通点击。 */
export function droppedPointerDrag(
  session: PointerDragSession | null,
  pointerId: number,
): PointerDragPayload | null {
  if (session === null || session.pointerId !== pointerId) return null;
  return session.phase === 'dragging' ? session.payload : null;
}

export function dispatchPointerDragDrop(detail: PointerDragDropDetail): void {
  document.dispatchEvent(
    new CustomEvent<PointerDragDropDetail>(POINTER_DRAG_DROP_EVENT, { detail }),
  );
}

function isPointerDragPayload(value: unknown): value is PointerDragPayload {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as {
    readonly kind?: unknown;
    readonly path?: unknown;
    readonly text?: unknown;
    readonly paths?: unknown;
  };
  if (
    (candidate.kind === 'doc' || candidate.kind === 'media') &&
    typeof candidate.path === 'string' &&
    candidate.path.length > 0
  ) {
    return true;
  }
  if (candidate.kind === 'text') return typeof candidate.text === 'string';
  return (
    candidate.kind === 'files' &&
    Array.isArray(candidate.paths) &&
    candidate.paths.length > 0 &&
    candidate.paths.every((path: unknown) => typeof path === 'string' && path.length > 0)
  );
}

/** 跨组件载荷守卫：坏 detail 一律丢弃，不抛错、不建节点。 */
export function readPointerDragDropDetail(value: unknown): PointerDragDropDetail | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as {
    readonly payload?: unknown;
    readonly clientX?: unknown;
    readonly clientY?: unknown;
  };
  if (
    !isPointerDragPayload(candidate.payload) ||
    typeof candidate.clientX !== 'number' ||
    typeof candidate.clientY !== 'number' ||
    !Number.isFinite(candidate.clientX) ||
    !Number.isFinite(candidate.clientY)
  ) {
    return null;
  }
  return {
    payload: candidate.payload,
    clientX: candidate.clientX,
    clientY: candidate.clientY,
  };
}
