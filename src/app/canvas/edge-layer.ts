/**
 * 连线 canvas 层（C3）：屏幕空间绘制，同色边合并为单条 Path2D 一次 stroke。
 *
 * 两个实例（edge / highlight）由 engine 决定挂载顺序：
 * grid canvas → edge canvas → world DOM → highlight canvas（§13.3）。
 * 本模块不碰坐标公式，只消费 `edge-layout.ts` 已投影好的屏幕几何。
 */
import type { CanvasEdgeColor } from '#canvas-format';
import type { CanvasEdgeView, EdgeDrawPlan, EdgeStyleView, ScreenEdge } from './edge-layout.ts';
import {
  DEFAULT_EDGE_STYLE,
  EDGE_DASH_PATTERN,
  EDGE_ORTHOGONAL_CORNER,
  cubicAt,
  edgeMidpoint,
  incidentEdgeIds,
} from './edge-layout.ts';
import type { Point, ViewportSize } from './viewport.ts';
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
  /** 以下为可选文本能力：缺失时跳过连线标签（测试假上下文保持轻量）。 */
  fillText?(text: string, x: number, y: number): void;
  measureText?(text: string): { readonly width: number };
  fillRect?(x: number, y: number, width: number, height: number): void;
  font?: string;
  textAlign?: CanvasTextAlign;
  textBaseline?: CanvasTextBaseline;
  /** 虚线能力：缺失时虚线退化为实线（测试假上下文兼容）。 */
  setLineDash?(segments: readonly number[]): void;
  /** 弱高亮透明度；缺失时高亮按不透明绘制。 */
  globalAlpha?: number;
}

export interface EdgePalette {
  readonly edge: string;
  readonly selected: string;
  readonly arrow: string;
  /** 语义连线色；缺失时回退 edge。 */
  readonly colorPrimary?: string;
  readonly colorSuccess?: string;
  readonly colorWarning?: string;
  readonly colorDanger?: string;
  /** 可选柔光色：提供时用同路径宽描边叠一层，避免 SVG/Canvas filter 的离屏开销。 */
  readonly glow?: string;
  /** 连线标签文字与底色；缺省回退 selected。 */
  readonly labelText?: string;
  readonly labelBg?: string;
}

/** CR-20261121-44：默认调色板改为运行时解析令牌（--ember-edge / --ember-edge-active），
 * 主题切换随缓存失效自动生效；`options.palette` 仍可逐键覆写。 */
function defaultEdgePalette(): EdgePalette {
  const theme = themeColors();
  return {
    edge: theme.edge,
    selected: theme.edgeSelected,
    arrow: theme.edgeArrow,
    colorPrimary: theme.edgePrimary,
    colorSuccess: theme.edgeSuccess,
    colorWarning: theme.edgeWarning,
    colorDanger: theme.edgeDanger,
    glow: theme.edgeGlow,
    labelText: theme.labelText,
    labelBg: theme.labelBg,
  };
}

/** CR-20261121-59：末端连接点半径（CSS px）——macOS 风格小圆点替代大箭头。
 * 2026-11-24：2.5 → 3.5，与放大后的 10px 端口在视觉上同权。 */


export type PathFactory = () => EdgePath;

export interface EdgeDrawStats {
  readonly edges: number;
  readonly arrows: number;
}

/**
 * 末端连接点：`in` 锚点在目标节点左边缘中点，曲线末端切线恒为 +x（c2 = p3 - k）。
 * CR-20261121-59：小圆点替代大箭头；低缩放 LOD 不画。
 */
/** 端点圆点历史上与端口圆点重叠而不可见，改为在线上的内向缩进处画实心三角箭头。 */
const EDGE_ARROW_INSET = 13;
const EDGE_ARROW_LENGTH = 10;
const EDGE_ARROW_HALF_WIDTH = 5;

function unitVector(from: Point, to: Point): Point | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  return length === 0 ? null : { x: dx / length, y: dy / length };
}

interface ArrowPlacement {
  readonly tip: Point;
  /** 箭头指向（end 朝 p3，start 朝 p0 反向）。 */
  readonly direction: Point;
}

function curveLengthEstimate(edge: ScreenEdge): number {
  const distance = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);
  return (
    (distance(edge.p0, edge.c1) +
      distance(edge.c1, edge.c2) +
      distance(edge.c2, edge.p3) +
      distance(edge.p0, edge.p3)) /
    2
  );
}

function curveTangent(edge: ScreenEdge, t: number): Point | null {
  const u = 1 - t;
  const dx =
    3 * u * u * (edge.c1.x - edge.p0.x) +
    6 * u * t * (edge.c2.x - edge.c1.x) +
    3 * t * t * (edge.p3.x - edge.c2.x);
  const dy =
    3 * u * u * (edge.c1.y - edge.p0.y) +
    6 * u * t * (edge.c2.y - edge.c1.y) +
    3 * t * t * (edge.p3.y - edge.c2.y);
  const length = Math.hypot(dx, dy);
  return length === 0 ? null : { x: dx / length, y: dy / length };
}

/**
 * 箭头必须落在实际路径上：直角折线取末/首段；曲线按估算弧长回退取曲线点与切线，
 * 避免只按端点水平切线内缩导致箭头悬浮在线条上方（拐点处的虚线尤其明显）。
 */
function arrowPlacement(edge: ScreenEdge, at: 'start' | 'end'): ArrowPlacement | null {
  const points = !edge.straight ? edge.points : undefined;
  if (points !== undefined && points.length >= 2) {
    const previous = at === 'end' ? points[points.length - 2] : edge.p0;
    const next = at === 'end' ? edge.p3 : points[1];
    if (previous === undefined || next === undefined) return null;
    const direction = unitVector(previous, next);
    if (direction === null) return null;
    return at === 'end'
      ? {
          tip: {
            x: edge.p3.x - direction.x * EDGE_ARROW_INSET,
            y: edge.p3.y - direction.y * EDGE_ARROW_INSET,
          },
          direction,
        }
      : {
          tip: {
            x: edge.p0.x + direction.x * EDGE_ARROW_INSET,
            y: edge.p0.y + direction.y * EDGE_ARROW_INSET,
          },
          direction: { x: -direction.x, y: -direction.y },
        };
  }

  const direction = unitVector(edge.p0, edge.p3);
  if (edge.straight) {
    if (direction === null) return null;
    return {
      tip:
        at === 'end'
          ? { x: edge.p3.x - direction.x * EDGE_ARROW_INSET, y: edge.p3.y - direction.y * EDGE_ARROW_INSET }
          : { x: edge.p0.x + direction.x * EDGE_ARROW_INSET, y: edge.p0.y + direction.y * EDGE_ARROW_INSET },
      direction: at === 'end' ? direction : { x: -direction.x, y: -direction.y },
    };
  }

  const estimate = Math.max(curveLengthEstimate(edge), EDGE_ARROW_INSET * 2);
  const rawT = at === 'end' ? 1 - EDGE_ARROW_INSET / estimate : EDGE_ARROW_INSET / estimate;
  const t = Math.min(0.98, Math.max(0.02, rawT));
  const tangent = curveTangent(edge, t) ?? direction;
  if (tangent === null) return null;
  return {
    tip: cubicAt(edge, t),
    direction: at === 'end' ? tangent : { x: -tangent.x, y: -tangent.y },
  };
}

function appendArrowhead(path: EdgePath, tip: Point, direction: Point): void {
  const backX = tip.x - direction.x * EDGE_ARROW_LENGTH;
  const backY = tip.y - direction.y * EDGE_ARROW_LENGTH;
  const normalX = -direction.y * EDGE_ARROW_HALF_WIDTH;
  const normalY = direction.x * EDGE_ARROW_HALF_WIDTH;
  path.moveTo(tip.x, tip.y);
  path.lineTo(backX + normalX, backY + normalY);
  path.lineTo(backX - normalX, backY - normalY);
  path.closePath();
}

/** 直角折线：相邻段之间用 8px 圆角；圆角用三次贝塞尔近似二次曲线。 */
function appendRoundedPolyline(path: EdgePath, points: readonly Point[], radius: number): void {
  const first = points[0];
  if (first === undefined) return;
  path.moveTo(first.x, first.y);
  for (let index = 1; index + 1 < points.length; index += 1) {
    const previous = points[index - 1];
    const corner = points[index];
    const next = points[index + 1];
    if (previous === undefined || corner === undefined || next === undefined) continue;
    const inLength = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const outLength = Math.hypot(next.x - corner.x, next.y - corner.y);
    if (inLength === 0 || outLength === 0) {
      path.lineTo(corner.x, corner.y);
      continue;
    }
    const r = Math.min(radius, inLength / 2, outLength / 2);
    const entry = {
      x: corner.x - ((corner.x - previous.x) / inLength) * r,
      y: corner.y - ((corner.y - previous.y) / inLength) * r,
    };
    const exit = {
      x: corner.x + ((next.x - corner.x) / outLength) * r,
      y: corner.y + ((next.y - corner.y) / outLength) * r,
    };
    path.lineTo(entry.x, entry.y);
    path.bezierCurveTo(
      entry.x + (corner.x - entry.x) * (2 / 3),
      entry.y + (corner.y - entry.y) * (2 / 3),
      exit.x + (corner.x - exit.x) * (2 / 3),
      exit.y + (corner.y - exit.y) * (2 / 3),
      exit.x,
      exit.y,
    );
  }
  const last = points[points.length - 1];
  if (last !== undefined) path.lineTo(last.x, last.y);
}

function appendEdge(path: EdgePath, edge: ScreenEdge, straight: boolean): void {
  if (!straight && edge.points !== undefined && edge.points.length >= 2) {
    appendRoundedPolyline(path, edge.points, EDGE_ORTHOGONAL_CORNER);
    return;
  }
  path.moveTo(edge.p0.x, edge.p0.y);
  if (straight) {
    path.lineTo(edge.p3.x, edge.p3.y);
    return;
  }
  path.bezierCurveTo(edge.c1.x, edge.c1.y, edge.c2.x, edge.c2.y, edge.p3.x, edge.p3.y);
}

const LABEL_FONT_SIZE = 11;
const LABEL_PAD_X = 6;
const LABEL_PAD_Y = 3;
const LABEL_GAP = 8;
const LABEL_MAX_CHARS = 24;

function truncateLabel(label: string): string {
  return label.length > LABEL_MAX_CHARS ? `${label.slice(0, LABEL_MAX_CHARS)}…` : label;
}

/** 连线标签：中点上方绘制文字 pill；上下文缺文本能力时静默跳过。 */
function drawEdgeLabels(
  ctx: EdgeContext,
  edges: readonly ScreenEdge[],
  palette: EdgePalette,
): void {
  if (ctx.fillText === undefined || ctx.measureText === undefined || ctx.fillRect === undefined) {
    return;
  }
  for (const edge of edges) {
    if (edge.label === undefined || edge.label === '') continue;
    const text = truncateLabel(edge.label);
    const mid = edgeMidpoint(edge);
    const width = ctx.measureText(text).width;
    const height = LABEL_FONT_SIZE + LABEL_PAD_Y * 2;
    const left = mid.x - width / 2 - LABEL_PAD_X;
    const top = mid.y - height - LABEL_GAP;
    ctx.fillStyle = palette.labelBg ?? palette.selected;
    ctx.fillRect(left, top, width + LABEL_PAD_X * 2, height);
    ctx.font = `${LABEL_FONT_SIZE}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = palette.labelText ?? palette.selected;
    ctx.fillText(text, mid.x, top + height / 2);
  }
}

function edgeStyleOf(edge: ScreenEdge): EdgeStyleView {
  return edge.style ?? DEFAULT_EDGE_STYLE;
}

/** 语义令牌 → 具体色值；缺失时回退默认连线色。 */
function resolveEdgeColor(palette: EdgePalette, color: CanvasEdgeColor): string {
  switch (color) {
    case 'primary':
      return palette.colorPrimary ?? palette.edge;
    case 'success':
      return palette.colorSuccess ?? palette.edge;
    case 'warning':
      return palette.colorWarning ?? palette.edge;
    case 'danger':
      return palette.colorDanger ?? palette.edge;
    default:
      return palette.edge;
  }
}

interface StrokeGroup {
  readonly line: EdgeStyleView['line'];
  readonly color: CanvasEdgeColor;
  readonly edges: ScreenEdge[];
}

/** 按 `line|color` 分组：默认组仍合并为一条 Path2D，非默认样式只增加组数。 */
function groupEdgesForStroke(edges: readonly ScreenEdge[]): readonly StrokeGroup[] {
  const groups = new Map<string, StrokeGroup>();
  for (const edge of edges) {
    const style = edgeStyleOf(edge);
    const key = `${style.line}|${style.color}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { line: style.line, color: style.color, edges: [edge] });
    } else {
      group.edges.push(edge);
    }
  }
  return [...groups.values()];
}

/** 普通边层：按样式分组批量 stroke + 按颜色批量箭头 fill。空计划不产生绘制调用。 */
export function drawEdgePlan(
  ctx: EdgeContext,
  plan: EdgeDrawPlan,
  palette: EdgePalette,
  createPath: PathFactory,
): EdgeDrawStats {
  if (plan.edges.length === 0) return { edges: 0, arrows: 0 };

  const width = plan.straight ? 2 : 2.5; /* CR-20261121-59：线宽 2~2.5px */
  for (const group of groupEdgesForStroke(plan.edges)) {
    const path = createPath();
    for (const edge of group.edges) appendEdge(path, edge, plan.straight);
    const dashed = group.line === 'dashed' && ctx.setLineDash !== undefined;
    if (dashed) ctx.setLineDash?.(EDGE_DASH_PATTERN);
    if (palette.glow !== undefined && group.line === 'solid') {
      /* 柔光层：同一条 Path2D 先粗描一次，成本约等于多一次 stroke，不引入 filter。
       * 虚线不叠柔光，避免节距被光晕糊掉。 */
      ctx.strokeStyle = palette.glow;
      ctx.lineWidth = width + 4;
      ctx.stroke(path);
    }
    ctx.strokeStyle = resolveEdgeColor(palette, group.color);
    ctx.lineWidth = width;
    ctx.stroke(path);
    if (dashed) ctx.setLineDash?.([]);
  }

  if (plan.straight) return { edges: plan.edges.length, arrows: 0 };

  const arrowGroups = new Map<CanvasEdgeColor, ScreenEdge[]>();
  for (const edge of plan.edges) {
    const style = edgeStyleOf(edge);
    if (style.arrow === 'none') continue;
    const list = arrowGroups.get(style.color);
    if (list === undefined) arrowGroups.set(style.color, [edge]);
    else list.push(edge);
  }
  let arrows = 0;
  for (const [color, list] of arrowGroups) {
    const arrowPath = createPath();
    for (const edge of list) {
      const style = edgeStyleOf(edge);
      const endPlacement = arrowPlacement(edge, 'end');
      if (endPlacement !== null) {
        appendArrowhead(arrowPath, endPlacement.tip, endPlacement.direction);
        arrows += 1;
      }
      if (style.arrow === 'both') {
        const startPlacement = arrowPlacement(edge, 'start');
        if (startPlacement !== null) {
          appendArrowhead(arrowPath, startPlacement.tip, startPlacement.direction);
          arrows += 1;
        }
      }
    }
    ctx.fillStyle = color === 'default' ? palette.arrow : resolveEdgeColor(palette, color);
    ctx.fill(arrowPath);
  }
  drawEdgeLabels(ctx, plan.edges, palette);
  return { edges: plan.edges.length, arrows };
}

/** 高亮描边：实线/虚线各一条 Path2D；虚线同样走 setLineDash。 */
function drawHighlightStrokes(
  ctx: EdgeContext,
  edges: readonly ScreenEdge[],
  palette: EdgePalette,
  createPath: PathFactory,
): void {
  const solid: ScreenEdge[] = [];
  const dashed: ScreenEdge[] = [];
  for (const edge of edges) {
    if (edgeStyleOf(edge).line === 'dashed') dashed.push(edge);
    else solid.push(edge);
  }
  const buckets = [
    { edges: solid, dashed: false },
    { edges: dashed, dashed: true },
  ] as const;
  for (const bucket of buckets) {
    if (bucket.edges.length === 0) continue;
    const path = createPath();
    for (const edge of bucket.edges) appendEdge(path, edge, edge.straight);
    if (bucket.dashed && ctx.setLineDash !== undefined) ctx.setLineDash(EDGE_DASH_PATTERN);
    if (palette.glow !== undefined && !bucket.dashed) {
      ctx.strokeStyle = palette.glow;
      ctx.lineWidth = 6.5;
      ctx.stroke(path);
    }
    ctx.strokeStyle = palette.selected;
    ctx.lineWidth = 2.5;
    ctx.stroke(path);
    if (bucket.dashed && ctx.setLineDash !== undefined) ctx.setLineDash([]);
  }
}

/** 高亮层：画在世界层之上，选中连线不被节点卡片截断。 */
export function drawEdgeHighlight(
  ctx: EdgeContext,
  edges: readonly ScreenEdge[],
  palette: EdgePalette,
  createPath: PathFactory,
  related: readonly ScreenEdge[] = [],
): number {
  if (edges.length === 0 && related.length === 0) return 0;

  /* M2 预留：关联边先以 0.4 透明度弱高亮，再复位画选中边。 */
  if (related.length > 0) {
    const canFade = ctx.globalAlpha !== undefined;
    if (canFade) ctx.globalAlpha = 0.4;
    drawHighlightStrokes(ctx, related, palette, createPath);
    if (canFade) ctx.globalAlpha = 1;
  }
  if (edges.length === 0) return 0;

  drawHighlightStrokes(ctx, edges, palette, createPath);

  const arrowPath = createPath();
  for (const edge of edges) {
    if (edge.straight) continue;
    const placement = arrowPlacement(edge, 'end');
    if (placement === null) continue;
    appendArrowhead(arrowPath, placement.tip, placement.direction);
  }
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

/** 关联高亮所需的最小选中集：与 interaction.CanvasSelection 结构兼容。 */
export interface EdgeHighlightSelection {
  readonly nodes: ReadonlySet<string>;
  readonly edges: ReadonlySet<string>;
}

interface HighlightCache {
  key: string;
  edgeViews: readonly CanvasEdgeView[] | null;
  related: ReadonlySet<string>;
}

/** 选中节点 incident 边 id：按「选中集 + edgeViews 引用」记忆化，拖拽每帧不重算。 */
function relatedEdgeIdsFor(
  cache: HighlightCache,
  edgeViews: readonly CanvasEdgeView[],
  selection: EdgeHighlightSelection,
): ReadonlySet<string> {
  const key = `${[...selection.nodes].sort().join('\u0000')}\u0001${[...selection.edges].sort().join('\u0000')}`;
  if (cache.key === key && cache.edgeViews === edgeViews) return cache.related;
  cache.key = key;
  cache.edgeViews = edgeViews;
  cache.related =
    selection.nodes.size === 0
      ? new Set<string>()
      : incidentEdgeIds(edgeViews, selection.nodes);
  return cache.related;
}

export interface EdgeLayer {
  readonly element: HTMLCanvasElement;
  resize(size: ViewportSize, dpr: number): void;
  draw(plan: EdgeDrawPlan): EdgeDrawStats;
  drawHighlight(edges: readonly ScreenEdge[], related?: readonly ScreenEdge[]): number;
  /** M2：选中边强高亮 + 选中节点 incident 边弱高亮（关联边先画、选中边后画）。 */
  drawSelectionHighlight(
    screenEdges: readonly ScreenEdge[],
    edgeViews: readonly CanvasEdgeView[],
    selection: EdgeHighlightSelection,
  ): number;
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
  const highlightCache: HighlightCache = { key: '', edgeViews: null, related: new Set() };

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
    drawHighlight(edges: readonly ScreenEdge[], related: readonly ScreenEdge[] = []): number {
      prepare();
      return drawEdgeHighlight(context, edges, currentPalette(), () => new Path2D(), related);
    },
    drawSelectionHighlight(
      screenEdges: readonly ScreenEdge[],
      edgeViews: readonly CanvasEdgeView[],
      selection: EdgeHighlightSelection,
    ): number {
      prepare();
      const relatedIds = relatedEdgeIdsFor(highlightCache, edgeViews, selection);
      const primary: ScreenEdge[] = [];
      const related: ScreenEdge[] = [];
      for (const edge of screenEdges) {
        if (selection.edges.has(edge.id)) primary.push(edge);
        else if (relatedIds.has(edge.id)) related.push(edge);
      }
      return drawEdgeHighlight(context, primary, currentPalette(), () => new Path2D(), related);
    },
    dispose(): void {
      element.remove();
    },
  };
}
