/**
 * 连线 canvas 层（C3）：屏幕空间绘制，同色边合并为单条 Path2D 一次 stroke。
 *
 * 两个实例（edge / highlight）由 engine 决定挂载顺序：
 * grid canvas → edge canvas → world DOM → highlight canvas（§13.3）。
 * 本模块不碰坐标公式，只消费 `edge-layout.ts` 已投影好的屏幕几何。
 */
import type { EdgeDrawPlan, ScreenEdge } from './edge-layout.ts';
import type { ViewportSize } from './viewport.ts';
import { themeColors } from './canvas-palette.ts';

/** 绘制需要的最小路径接口（Path2D 结构化满足，测试注入假路径）。 */
export interface EdgePath {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(
    c1x: number,
    c1y: number,
    c2x: number,
    c2y: number,
    x: number,
    y: number,
  ): void;
  /** CR-20261121-59：末端连接点圆（替代大箭头）。 */
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  closePath(): void;
}

/** 绘制需要的最小上下文（CanvasRenderingContext2D 结构化满足）。 */
export interface EdgeContext {
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  stroke(path: EdgePath): void;
  fill(path: EdgePath): void;
}

export interface EdgePalette {
  readonly edge: string;
  readonly selected: string;
  readonly arrow: string;
  /** 可选柔光色：提供时用同路径宽描边叠一层，避免 SVG/Canvas filter 的离屏开销。 */
  readonly glow?: string;
}

/** CR-20261121-44：默认调色板改为运行时解析令牌（--ember-edge / --ember-edge-active），
 * 主题切换随缓存失效自动生效；`options.palette` 仍可逐键覆写。 */
function defaultEdgePalette(): EdgePalette {
  const theme = themeColors();
  return {
    edge: theme.edge,
    selected: theme.edgeSelected,
    arrow: theme.edgeArrow,
    glow: theme.edgeGlow,
  };
}

/** CR-20261121-59：末端连接点半径（CSS px）——macOS 风格小圆点替代大箭头。
 * 2026-11-24：2.5 → 3.5，与放大后的 10px 端口在视觉上同权。 */
export const EDGE_ENDPOINT_RADIUS = 3.5;

export type PathFactory = () => EdgePath;

export interface EdgeDrawStats {
  readonly edges: number;
  readonly arrows: number;
}

/**
 * 末端连接点：`in` 锚点在目标节点左边缘中点，曲线末端切线恒为 +x（c2 = p3 - k）。
 * CR-20261121-59：小圆点替代大箭头；低缩放 LOD 不画。
 */
function appendArrow(path: EdgePath, tip: { readonly x: number; readonly y: number }): void {
  path.moveTo(tip.x + EDGE_ENDPOINT_RADIUS, tip.y);
  path.arc(tip.x, tip.y, EDGE_ENDPOINT_RADIUS, 0, 2 * Math.PI);
  path.closePath();
}

function appendEdge(path: EdgePath, edge: ScreenEdge, straight: boolean): void {
  path.moveTo(edge.p0.x, edge.p0.y);
  if (straight) {
    path.lineTo(edge.p3.x, edge.p3.y);
    return;
  }
  path.bezierCurveTo(edge.c1.x, edge.c1.y, edge.c2.x, edge.c2.y, edge.p3.x, edge.p3.y);
}

/** 普通边层：批量 stroke + 批量箭头 fill。空计划不产生绘制调用。 */
export function drawEdgePlan(
  ctx: EdgeContext,
  plan: EdgeDrawPlan,
  palette: EdgePalette,
  createPath: PathFactory,
): EdgeDrawStats {
  if (plan.edges.length === 0) return { edges: 0, arrows: 0 };

  const strokePath = createPath();
  for (const edge of plan.edges) appendEdge(strokePath, edge, plan.straight);
  const width = plan.straight ? 2 : 2.5; /* CR-20261121-59：线宽 2~2.5px */
  if (palette.glow !== undefined) {
    /* 柔光层：同一条 Path2D 先粗描一次，成本约等于多一次 stroke，不引入 filter。 */
    ctx.strokeStyle = palette.glow;
    ctx.lineWidth = width + 4;
    ctx.stroke(strokePath);
  }
  ctx.strokeStyle = palette.edge;
  ctx.lineWidth = width;
  ctx.stroke(strokePath);

  if (plan.straight) return { edges: plan.edges.length, arrows: 0 };

  const arrowPath = createPath();
  for (const edge of plan.edges) appendArrow(arrowPath, edge.p3);
  ctx.fillStyle = palette.arrow;
  ctx.fill(arrowPath);
  return { edges: plan.edges.length, arrows: plan.edges.length };
}

/** 高亮层：画在世界层之上，选中连线不被节点卡片截断。 */
export function drawEdgeHighlight(
  ctx: EdgeContext,
  edges: readonly ScreenEdge[],
  palette: EdgePalette,
  createPath: PathFactory,
): number {
  if (edges.length === 0) return 0;

  const strokePath = createPath();
  for (const edge of edges) appendEdge(strokePath, edge, edge.straight);
  if (palette.glow !== undefined) {
    ctx.strokeStyle = palette.glow;
    ctx.lineWidth = 6.5;
    ctx.stroke(strokePath);
  }
  ctx.strokeStyle = palette.selected;
  ctx.lineWidth = 2.5;
  ctx.stroke(strokePath);

  const arrowPath = createPath();
  for (const edge of edges) appendArrow(arrowPath, edge.p3);
  ctx.fillStyle = palette.selected;
  ctx.fill(arrowPath);
  return edges.length;
}

export interface EdgeLayerOptions {
  readonly className: string;
  /** `data-layer` 值，供浏览器验收断言 z 序（grid/edges/highlight）。 */
  readonly layerName: string;
  readonly palette?: Partial<EdgePalette>;
}

export interface EdgeLayer {
  readonly element: HTMLCanvasElement;
  resize(size: ViewportSize, dpr: number): void;
  draw(plan: EdgeDrawPlan): EdgeDrawStats;
  drawHighlight(edges: readonly ScreenEdge[]): number;
  dispose(): void;
}

export function createEdgeLayer(options: EdgeLayerOptions): EdgeLayer {
  const element = document.createElement('canvas');
  element.className = options.className;
  element.dataset.layer = options.layerName;
  element.setAttribute('aria-hidden', 'true');
  const created = element.getContext('2d');
  if (created === null) throw new Error(`无法创建连线 Canvas 2D 上下文：${options.layerName}`);
  const context: CanvasRenderingContext2D = created;
  const paletteOverride = options.palette;
  let size: ViewportSize = { width: 1, height: 1 };
  let dpr = 1;

  /* 每次绘制惰性解析：主题切换（color-scheme 变更）后下一次绘制即用新色。 */
  function currentPalette(): EdgePalette {
    return { ...defaultEdgePalette(), ...paletteOverride };
  }

  function prepare(): void {
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, size.width, size.height);
  }

  return {
    element,
    resize(next: ViewportSize, nextDpr: number): void {
      size = next;
      dpr = Math.max(1, nextDpr);
      const width = Math.max(1, Math.round(next.width * dpr));
      const height = Math.max(1, Math.round(next.height * dpr));
      if (element.width !== width) element.width = width;
      if (element.height !== height) element.height = height;
    },
    draw(plan: EdgeDrawPlan): EdgeDrawStats {
      prepare();
      return drawEdgePlan(context, plan, currentPalette(), () => new Path2D());
    },
    drawHighlight(edges: readonly ScreenEdge[]): number {
      prepare();
      return drawEdgeHighlight(context, edges, currentPalette(), () => new Path2D());
    },
    dispose(): void {
      element.remove();
    },
  };
}
