/**
 * 无限点阵绘制（C1）：只算视口内的点，按 LOD 控制密度，屏幕空间对齐设备像素。
 * 纯计算 + 最小 Canvas 上下文接口，便于在 node --test 下用假 ctx 断言。
 *
 * Cinematic Ember §3.9：网格从「线」改为「点阵」——24px 间距、1px 点、6% 白；
 * 点阵比线更容易让半透明卡片显形。点阵不是实体，不参与命中或坐标计算。
 */
import {
  gridLevel,
  gridStepWorld,
  visibleWorldRect,
  type ViewportSize,
  type ViewportTransform,
} from './viewport.ts';

/** 单帧点阵总数硬上限（线数上限在点阵下等价为面积上限）。 */
export const MAX_DOTS = 40000;

export interface GridPalette {
  readonly background: string;
  readonly dot: string;
}

export interface GridPoint {
  /** 屏幕 CSS px（已按 dpr 对齐半像素）。 */
  readonly screen: number;
}

export interface GridPoints {
  readonly vertical: readonly GridPoint[];
  readonly horizontal: readonly GridPoint[];
  readonly level: number;
  readonly stepWorld: number;
}

/** drawGrid 需要的最小上下文（CanvasRenderingContext2D 天然满足）。 */
export interface GridContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  /** CR-20261121-57 反馈修复：背景透明化后必须真清屏，否则点阵逐帧叠画成花格。 */
  clearRect(x: number, y: number, width: number, height: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
}

export interface GridDrawResult {
  readonly dots: number;
  readonly stepWorld: number;
}

/** 区间内网格点的下标范围：first = ceil(min/step)，last = floor(max/step)。 */
export function gridIndexRange(
  min: number,
  max: number,
  step: number,
): { readonly first: number; readonly last: number } {
  return { first: Math.ceil(min / step), last: Math.floor(max / step) };
}

function alignToDevicePixel(value: number, dpr: number): number {
  return (Math.round(value * dpr) + 0.5) / dpr;
}

/** 计算视口内的点阵；超过硬上限时提升 LOD 层级直至收敛。 */
export function gridPoints(
  transform: ViewportTransform,
  size: ViewportSize,
  dpr = 1,
): GridPoints {
  const rect = visibleWorldRect(transform, size);
  let level = gridLevel(transform.scale);
  let stepWorld = gridStepWorld(transform.scale);

  const maxIterations = 64;
  for (let i = 0; i < maxIterations; i += 1) {
    const verticalRange = gridIndexRange(rect.left, rect.right, stepWorld);
    const horizontalRange = gridIndexRange(rect.top, rect.bottom, stepWorld);
    const verticalCount = verticalRange.last - verticalRange.first + 1;
    const horizontalCount = horizontalRange.last - horizontalRange.first + 1;
    if (verticalCount * horizontalCount <= MAX_DOTS) {
      return {
        vertical: collectPoints(
          verticalRange,
          stepWorld,
          transform.tx,
          transform.scale,
          dpr,
        ),
        horizontal: collectPoints(
          horizontalRange,
          stepWorld,
          transform.ty,
          transform.scale,
          dpr,
        ),
        level,
        stepWorld,
      };
    }
    level += 1;
    stepWorld *= 2;
  }

  return { vertical: [], horizontal: [], level, stepWorld };
}

function collectPoints(
  range: { readonly first: number; readonly last: number },
  stepWorld: number,
  offset: number,
  scale: number,
  dpr: number,
): GridPoint[] {
  const points: GridPoint[] = [];
  for (let index = range.first; index <= range.last; index += 1) {
    points.push({ screen: alignToDevicePixel(index * stepWorld * scale + offset, dpr) });
  }
  return points;
}

/** 透明背景判定：'transparent' 与计算样式产出的 'rgba(0, 0, 0, 0)' 都算（其余视为不透明）。 */
function isOpaqueBackground(value: string): boolean {
  const normalized = value.replace(/\s+/g, '').toLowerCase();
  return normalized !== 'transparent' && normalized !== 'rgba(0,0,0,0)';
}

/** 绘制背景 + 点阵；返回值用于单测/基准断言。 */
export function drawGrid(
  ctx: GridContext,
  transform: ViewportTransform,
  size: ViewportSize,
  dpr: number,
  palette: GridPalette,
): GridDrawResult {
  // CR-20261121-57 反馈修复：背景令牌透明化后，fillRect 透明填充不清除旧帧，
  // 平移/缩放时点阵逐帧叠画成花格——先 clearRect 真清屏；不透明背景仍保留填充
  // （兼容调色板覆写与既有测试）。
  ctx.clearRect(0, 0, size.width, size.height);
  if (isOpaqueBackground(palette.background)) {
    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, size.width, size.height);
  }

  const points = gridPoints(transform, size, dpr);
  ctx.fillStyle = palette.dot;

  // 1 CSS px 点；坐标为设备像素中心，减半后落在像素边界上。
  const dotSize = 1;
  const half = dotSize / 2;
  let dots = 0;
  for (const y of points.horizontal) {
    for (const x of points.vertical) {
      ctx.fillRect(x.screen - half, y.screen - half, dotSize, dotSize);
      dots += 1;
    }
  }

  return { dots, stepWorld: points.stepWorld };
}
