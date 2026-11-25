/**
 * 无限网格绘制（C1）：只算视口内的线，按 LOD 控制密度，屏幕空间对齐设备像素。
 * 纯计算 + 最小 Canvas 上下文接口，便于在 node --test 下用假 ctx 断言。
 */
import {
  gridLevel,
  gridStepWorld,
  visibleWorldRect,
  type ViewportSize,
  type ViewportTransform,
} from './viewport.ts';

/** 单轴网格线硬上限（CR-20261117-01 §3）。 */
export const MAX_LINES_PER_AXIS = 600;
/** 每隔几条次线画一条主线。 */
export const MAJOR_EVERY = 5;

export interface GridPalette {
  readonly background: string;
  readonly minor: string;
  readonly major: string;
}

export interface GridLine {
  /** 屏幕 CSS px（已按 dpr 对齐半像素）。 */
  readonly screen: number;
  readonly major: boolean;
}

export interface GridLines {
  readonly vertical: readonly GridLine[];
  readonly horizontal: readonly GridLine[];
  readonly level: number;
  readonly stepWorld: number;
}

/** drawGrid 需要的最小上下文（CanvasRenderingContext2D 天然满足）。 */
export interface GridContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  /** CR-20261121-57 反馈修复：背景透明化后必须真清屏，否则网格线逐帧叠画成花格。 */
  clearRect(x: number, y: number, width: number, height: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
}

export interface GridDrawResult {
  readonly vertical: number;
  readonly horizontal: number;
  readonly stepWorld: number;
}

/** 区间内网格线的下标范围：first = ceil(min/step)，last = floor(max/step)。 */
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

/** 计算视口内的网格线；超过硬上限时提升 LOD 层级直至收敛。 */
export function gridLines(
  transform: ViewportTransform,
  size: ViewportSize,
  dpr = 1,
): GridLines {
  const rect = visibleWorldRect(transform, size);
  let level = gridLevel(transform.scale);
  let stepWorld = gridStepWorld(transform.scale);

  const maxIterations = 64;
  for (let i = 0; i < maxIterations; i += 1) {
    const verticalRange = gridIndexRange(rect.left, rect.right, stepWorld);
    const horizontalRange = gridIndexRange(rect.top, rect.bottom, stepWorld);
    const verticalCount = verticalRange.last - verticalRange.first + 1;
    const horizontalCount = horizontalRange.last - horizontalRange.first + 1;
    if (verticalCount <= MAX_LINES_PER_AXIS && horizontalCount <= MAX_LINES_PER_AXIS) {
      return {
        vertical: collectLines(
          verticalRange,
          stepWorld,
          transform.tx,
          transform.scale,
          dpr,
        ),
        horizontal: collectLines(
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

function collectLines(
  range: { readonly first: number; readonly last: number },
  stepWorld: number,
  offset: number,
  scale: number,
  dpr: number,
): GridLine[] {
  const lines: GridLine[] = [];
  for (let index = range.first; index <= range.last; index += 1) {
    lines.push({
      screen: alignToDevicePixel(index * stepWorld * scale + offset, dpr),
      major: index % MAJOR_EVERY === 0,
    });
  }
  return lines;
}

/** 透明背景判定：'transparent' 与计算样式产出的 'rgba(0, 0, 0, 0)' 都算（其余视为不透明）。 */
function isOpaqueBackground(value: string): boolean {
  const normalized = value.replace(/\s+/g, '').toLowerCase();
  return normalized !== 'transparent' && normalized !== 'rgba(0,0,0,0)';
}

/** 绘制背景 + 次线 + 主线；返回值用于单测/基准断言。 */
export function drawGrid(
  ctx: GridContext,
  transform: ViewportTransform,
  size: ViewportSize,
  dpr: number,
  palette: GridPalette,
): GridDrawResult {
  // CR-20261121-57 反馈修复：背景令牌透明化后，fillRect 透明填充不清除旧帧，
  // 平移/缩放时网格线逐帧叠画成花格——先 clearRect 真清屏；不透明背景仍保留填充
  // （兼容调色板覆写与既有测试）。
  ctx.clearRect(0, 0, size.width, size.height);
  if (isOpaqueBackground(palette.background)) {
    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, size.width, size.height);
  }

  const lines = gridLines(transform, size, dpr);
  const lineWidth = 1 / dpr;
  ctx.lineWidth = lineWidth;

  ctx.strokeStyle = palette.minor;
  ctx.beginPath();
  for (const line of lines.vertical) {
    if (line.major) continue;
    ctx.moveTo(line.screen, 0);
    ctx.lineTo(line.screen, size.height);
  }
  for (const line of lines.horizontal) {
    if (line.major) continue;
    ctx.moveTo(0, line.screen);
    ctx.lineTo(size.width, line.screen);
  }
  ctx.stroke();

  ctx.strokeStyle = palette.major;
  ctx.beginPath();
  for (const line of lines.vertical) {
    if (!line.major) continue;
    ctx.moveTo(line.screen, 0);
    ctx.lineTo(line.screen, size.height);
  }
  for (const line of lines.horizontal) {
    if (!line.major) continue;
    ctx.moveTo(0, line.screen);
    ctx.lineTo(size.width, line.screen);
  }
  ctx.stroke();

  return {
    vertical: lines.vertical.length,
    horizontal: lines.horizontal.length,
    stepWorld: lines.stepWorld,
  };
}
