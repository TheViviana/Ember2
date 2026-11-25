/**
 * 画布视口变换（C1 世界层）。
 *
 * 纯函数、零依赖、不碰 DOM：世界→屏幕、屏幕→世界、缩放锚点、平移、LOD 与视口范围。
 * 约定（CR-20261117-01 §2）：scale = 1 时 1 世界单位 = 1 CSS px，y 轴向下；
 * 三式中的世界坐标 W 一律指「绝对世界坐标」（absolute），origin 只服务于 rebase。
 */

/** 缩放下限。 */
export const MIN_SCALE = 0.05;
/** 缩放上限。 */
export const MAX_SCALE = 8;
/** 节点绝对坐标与相机精度的 C4 阈值。 */
export const REBASE_THRESHOLD = 1e12;
export const ORIGIN_PRECISION_LIMIT = 1e15;
/** 基准网格间距（世界单位）。 */
export const BASE_SPACING = 24;
/** 屏幕空间允许的最小网格间距（CSS px）：点阵按 24px 排布（Cinematic Ember §3.9）。 */
export const MIN_GRID_PX = 24;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * 视口变换状态。
 * - `tx/ty`：世界原点在屏幕中的位置（CSS px）；
 * - `scale`：缩放倍数；
 * - `originX/originY`：rebase 用的世界原点偏移（C2 补全，C1 恒为 0）。
 */
export interface ViewportTransform {
  readonly tx: number;
  readonly ty: number;
  readonly scale: number;
  readonly originX: number;
  readonly originY: number;
}

export function createViewportTransform(
  tx = 0,
  ty = 0,
  scale = 1,
  originX = 0,
  originY = 0,
): ViewportTransform {
  return { tx, ty, scale: clampScale(scale), originX, originY };
}

/** 把缩放钳制到 [MIN_SCALE, MAX_SCALE]；非有限值回落到 1。 */
export function clampScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** 世界 → 屏幕：Sx = Wx * s + tx，Sy = Wy * s + ty。 */
export function worldToScreen(transform: ViewportTransform, world: Point): Point {
  return {
    x: world.x * transform.scale + transform.tx,
    y: world.y * transform.scale + transform.ty,
  };
}

/** 屏幕 → 世界：Wx = (Sx - tx) / s，Wy = (Sy - ty) / s。 */
export function screenToWorld(transform: ViewportTransform, screen: Point): Point {
  return {
    x: (screen.x - transform.tx) / transform.scale,
    y: (screen.y - transform.ty) / transform.scale,
  };
}

/** 平移：屏幕像素增量直接累加，不乘 scale。 */
export function panBy(transform: ViewportTransform, delta: Point): ViewportTransform {
  return { ...transform, tx: transform.tx + delta.x, ty: transform.ty + delta.y };
}

/**
 * 以屏幕点 anchor 为锚点缩放：锚点下的世界坐标不动。
 * w = (p - t) / s；s' = clamp(s * factor)；t' = p - w * s'。
 */
export function zoomAt(
  transform: ViewportTransform,
  anchor: Point,
  factor: number,
): ViewportTransform {
  if (!Number.isFinite(factor) || factor <= 0) return transform;
  const world = screenToWorld(transform, anchor);
  const scale = clampScale(transform.scale * factor);
  return {
    ...transform,
    scale,
    tx: anchor.x - world.x * scale,
    ty: anchor.y - world.y * scale,
  };
}

/**
 * CR-20261122-63：把非空世界矩形完整适配到视口并居中。
 * 只缩小、不放大；矩形使用绝对世界坐标，tx/ty 仍满足 screen = absolute * scale + t。
 */
export function fitRectsToViewport(
  rects: readonly Rect[],
  size: ViewportSize,
  transform: ViewportTransform,
  padding = 48,
): ViewportTransform {
  if (
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    size.width <= 0 ||
    size.height <= 0 ||
    !Number.isFinite(padding) ||
    padding < 0
  ) {
    return transform;
  }
  const availableWidth = size.width - padding * 2;
  const availableHeight = size.height - padding * 2;
  if (availableWidth <= 0 || availableHeight <= 0) return transform;

  let bounds: { left: number; top: number; right: number; bottom: number } | null = null;
  for (const rect of rects) {
    if (
      !Number.isFinite(rect.left) ||
      !Number.isFinite(rect.top) ||
      !Number.isFinite(rect.right) ||
      !Number.isFinite(rect.bottom) ||
      rect.right <= rect.left ||
      rect.bottom <= rect.top
    ) {
      continue;
    }
    if (bounds === null) {
      bounds = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    } else {
      bounds = {
        left: Math.min(bounds.left, rect.left),
        top: Math.min(bounds.top, rect.top),
        right: Math.max(bounds.right, rect.right),
        bottom: Math.max(bounds.bottom, rect.bottom),
      };
    }
  }
  if (bounds === null) return transform;

  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const scale = clampScale(Math.min(1, availableWidth / width, availableHeight / height));
  const tx = size.width / 2 - ((bounds.left + bounds.right) / 2) * scale;
  const ty = size.height / 2 - ((bounds.top + bounds.bottom) / 2) * scale;
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) return transform;
  return { ...transform, tx, ty, scale };
}

/** 回到 100% 并让世界原点对齐屏幕左上角；保留 rebase 偏移。 */
export function resetView(transform: ViewportTransform): ViewportTransform {
  return { ...transform, tx: 0, ty: 0, scale: 1 };
}

/** LOD 层级：k = ceil(log2(MIN_GRID_PX / (BASE_SPACING * s)))。 */
export function gridLevel(scale: number): number {
  const safe = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return Math.ceil(Math.log2(MIN_GRID_PX / (BASE_SPACING * safe)));
}

/** 当前缩放下一条网格线的世界步长：stepWorld = BASE_SPACING * 2^k。 */
export function gridStepWorld(scale: number): number {
  return BASE_SPACING * 2 ** gridLevel(scale);
}

/** 视口覆盖的世界矩形。 */
export function visibleWorldRect(transform: ViewportTransform, size: ViewportSize): Rect {
  const topLeft = screenToWorld(transform, { x: 0, y: 0 });
  const bottomRight = screenToWorld(transform, { x: size.width, y: size.height });
  return {
    left: topLeft.x,
    top: topLeft.y,
    right: bottomRight.x,
    bottom: bottomRight.y,
  };
}

/** rebase 的世界偏移：O 取 BASE=24 的整数倍，保持网格相位。 */
export function rebaseOffset(transform: ViewportTransform): Point {
  const divisor = BASE_SPACING * transform.scale;
  return {
    x: Math.trunc(transform.tx / divisor) * BASE_SPACING,
    y: Math.trunc(transform.ty / divisor) * BASE_SPACING,
  };
}

/**
 * 平移世界原点：origin += O、t -= O*s；调用方必须把同一 O 同步加到实体绝对坐标
 * 与撤销/重做的 from/to，才能保持 local、屏幕位置和 undo 语义不变。
 */
export function rebase(
  transform: ViewportTransform,
  offset: Point = rebaseOffset(transform),
): ViewportTransform {
  if (!Number.isFinite(offset.x) || !Number.isFinite(offset.y)) return transform;
  return {
    ...transform,
    originX: transform.originX + offset.x,
    originY: transform.originY + offset.y,
    tx: transform.tx - offset.x * transform.scale,
    ty: transform.ty - offset.y * transform.scale,
  };
}
