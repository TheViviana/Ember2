/**
 * CR-20261119-11：画布 8 方向缩放纯函数。
 *
 * 本模块**只有纯函数、零 DOM 依赖**，node --test 链可直接单测。
 * engine.ts / interaction.ts 都从它导入，零 ESM 循环（常量归 consts.ts）。
 */
import { MIN_NODE_HEIGHT, MIN_NODE_WIDTH, PORT_LEAVE, RESIZE_HANDLE_HIT } from './consts.ts';

export type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export interface ResizeOrigin {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface ResizeResult {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * 计算 8 方向拖拽后节点的新 {x, y, w, h}。
 *
 * 对边锚定语义：
 *   se（右下拖）→ 右/下边缘移动，左/上锚定不变
 *   nw（左上拖）→ 左/上边缘移动，右/下锚定不变
 *   sw（左下拖）→ 左/下边缘移动，右/上锚定不变
 *   ne（右上拖）→ 右/上边缘移动，左/下锚定不变
 *   n （上拖）→ 上边缘移动，下锚定不变
 *   s （下拖）→ 下边缘移动，上锚定不变
 *   e （右拖）→ 右边缘移动，左锚定不变
 *   w （左拖）→ 左边缘移动，右锚定不变
 *
 * 最小尺寸钳制时**保证锚定边不动**：
 *   se 拖到 w < minW → w 钳到 minW，x 不变（左锚定）
 *   nw 拖到 w < minW → w 钳到 minW，x 回退 origin.x + origin.w - minW（右锚定）
 *   同理高度方向。
 */
export function computeResizeResult(
  origin: ResizeOrigin,
  delta: { readonly dx: number; readonly dy: number },
  dir: ResizeDir,
  minW: number = MIN_NODE_WIDTH,
  minH: number = MIN_NODE_HEIGHT,
  maxW = 10000,
  maxH = 10000,
): ResizeResult {
  let { x, y, w, h } = origin;

  switch (dir) {
    case 'se': { w = clampWithin(origin.w + delta.dx, minW, maxW); h = clampWithin(origin.h + delta.dy, minH, maxH); break; }
    case 'sw': { w = clampWithin(origin.w - delta.dx, minW, maxW); h = clampWithin(origin.h + delta.dy, minH, maxH); x = origin.x + (origin.w - w); break; }
    case 'ne': { w = clampWithin(origin.w + delta.dx, minW, maxW); h = clampWithin(origin.h - delta.dy, minH, maxH); y = origin.y + (origin.h - h); break; }
    case 'nw': { w = clampWithin(origin.w - delta.dx, minW, maxW); h = clampWithin(origin.h - delta.dy, minH, maxH); x = origin.x + (origin.w - w); y = origin.y + (origin.h - h); break; }
    case 'n':  { h = clampWithin(origin.h - delta.dy, minH, maxH); y = origin.y + (origin.h - h); break; }
    case 's':  { h = clampWithin(origin.h + delta.dy, minH, maxH); break; }
    case 'e':  { w = clampWithin(origin.w + delta.dx, minW, maxW); break; }
    case 'w':  { w = clampWithin(origin.w - delta.dx, minW, maxW); x = origin.x + (origin.w - w); break; }
  }

  return { x, y, w, h };
}

function clampWithin(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface ResizeRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface ResizeZone {
  /** 命中的 ResizeDir；null 表示没命中 resize zone（端口 or 节点） */
  readonly dir: ResizeDir | null;
  /** 端口让位区命中则不为 null；此时 dir 必为 null（应让给端口） */
  readonly port: 'left' | 'right' | null;
}

/**
 * 判定 point 落在节点 rect 的哪个缩放 zone。
 *
 * 优先级：角 > 边（端口区除外 且 非角）> 端口 > 节点（兜底）
 * 角收缩：corner = min(hit, w/4, h/4)
 * 边收缩：edge   = min(hit, w/6, h/6)
 * 竖边（e/w）被完全吃掉的条件：
 *   2*PORT_LEAVE（端口总高）+ 2*corner（两角总高）>= h（竖边总高）
 *   → 此时 resolveResizeZone 在竖边上**永不返回 'e'/'w'**。
 *
 * @param rect       节点屏幕 CSS 矩形
 * @param point      屏幕 CSS px
 * @param hit        热区基准；默认 RESIZE_HANDLE_HIT
 * @param portLeave  端口让位外推；默认 PORT_LEAVE
 */
export function resolveResizeZone(
  rect: ResizeRect,
  point: { readonly x: number; readonly y: number },
  hit: number = RESIZE_HANDLE_HIT,
  portLeave: number = PORT_LEAVE,
): ResizeZone {
  const { left, top, right, bottom } = rect;
  const w = right - left;
  const h = bottom - top;
  const centerY = (top + bottom) / 2;

  const corner = Math.min(hit, Math.floor(w / 4), Math.floor(h / 4));
  const edge = Math.min(hit, Math.floor(w / 6), Math.floor(h / 6));

  const atLeft   = point.x >= left && point.x <= left + corner;
  const atRight  = point.x >= right - corner && point.x <= right;
  const atTop    = point.y >= top && point.y <= top + corner;
  const atBottom = point.y >= bottom - corner && point.y <= bottom;

  // 角优先
  if (atLeft && atTop)    return { dir: 'nw', port: null };
  if (atRight && atTop)   return { dir: 'ne', port: null };
  if (atLeft && atBottom) return { dir: 'sw', port: null };
  if (atRight && atBottom) return { dir: 'se', port: null };

  // 端口 zone 双轴判断（不是单轴 slice！）
  const inLeftPort  = Math.abs(point.x - left)  <= portLeave && Math.abs(point.y - centerY) <= portLeave;
  const inRightPort = Math.abs(point.x - right) <= portLeave && Math.abs(point.y - centerY) <= portLeave;

  if (inLeftPort)  return { dir: null, port: 'left' };
  if (inRightPort) return { dir: null, port: 'right' };

  // 边 zone（已排除角和端口 zone）
  const edgeLeft   = point.x >= left && point.x <= left + edge;
  const edgeRight  = point.x >= right - edge && point.x <= right;
  const edgeTop    = point.y >= top && point.y <= top + edge;
  const edgeBottom = point.y >= bottom - edge && point.y <= bottom;

  if (edgeTop)    return { dir: 'n', port: null };
  if (edgeBottom) return { dir: 's', port: null };
  if (edgeLeft)   return { dir: 'w', port: null };
  if (edgeRight)  return { dir: 'e', port: null };

  return { dir: null, port: null };
}

/** ResizeDir → CSS cursor。纯函数、无 DOM 依赖。 */
export function cursorForResizeDir(dir: ResizeDir): string {
  switch (dir) {
    case 'se': case 'nw': return 'nwse-resize';
    case 'ne': case 'sw': return 'nesw-resize';
    case 'n':  case 's':  return 'ns-resize';
    case 'e':  case 'w':  return 'ew-resize';
  }
}
