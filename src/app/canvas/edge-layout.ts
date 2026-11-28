/**
 * 连线布局（C3）：纯坐标计算，不碰 DOM、不导入 CSS Modules，可直接在 node 下测试。
 *
 * 端点（CR-20261117-02 §13.1 方案 C）：节点盒缺省 160×96，显式 `w/h` 已落格式层；
 * `out` 取实际盒右边缘中点，`in` 取实际盒左边缘中点。
 *
 * 坐标纪律：绝对世界坐标 → `local = absolute - origin`（`nodeLocalPosition`）→
 * `composeScreenPosition`。不在本文件另写等价公式（S1）。
 *
 * 降级链（§13.4）：视口裁剪 → LOD（scale < 0.3 直线）→ Path2D 批量（edge-layer）→
 * 可见边 > 5000 只保留告警（不绘制）→ WebGL 另开 CR（Backlog ⑨）。
 */
import type {
  CanvasEdgeArrow,
  CanvasEdgeColor,
  CanvasEdgeLine,
  CanvasEdgeRoute,
} from '#canvas-format';
import type { CanvasDocument } from './format.ts';
import {
  composeScreenPosition,
  nodeLocalPosition,
  nodeSizeOf,
  NODE_HEIGHT,
  NODE_WIDTH,
  type CanvasNodeView,
  type NodeSize,
} from './node-layout.ts';
import type { Point, Rect, ViewportSize, ViewportTransform } from './viewport.ts';

const DEFAULT_NODE_SIZE: NodeSize = { w: NODE_WIDTH, h: NODE_HEIGHT };

/** 归一后的连线样式：四键必填，缺省值在读取时补齐。 */
export interface EdgeStyleView {
  readonly line: CanvasEdgeLine;
  readonly arrow: CanvasEdgeArrow;
  readonly color: CanvasEdgeColor;
  readonly route: CanvasEdgeRoute;
}

export const DEFAULT_EDGE_STYLE: EdgeStyleView = Object.freeze({
  line: 'solid',
  arrow: 'end',
  color: 'default',
  route: 'curve',
});

const EDGE_LINES: readonly CanvasEdgeLine[] = ['solid', 'dashed'];
const EDGE_ARROWS: readonly CanvasEdgeArrow[] = ['end', 'both', 'none'];
const EDGE_COLORS: readonly CanvasEdgeColor[] = ['default', 'primary', 'success', 'warning', 'danger'];
const EDGE_ROUTES: readonly CanvasEdgeRoute[] = ['curve', 'orthogonal'];

/** 虚线节距（CSS px）：线宽不变，只换线型。 */
export const EDGE_DASH_PATTERN: readonly number[] = [7, 5];
/** 直角折线出线短桩长度（屏幕 px）。 */
export const EDGE_ORTHOGONAL_STUB = 24;
/** 直角折线拐角圆角半径（屏幕 px）。 */
export const EDGE_ORTHOGONAL_CORNER = 8;

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** 逐键白名单归一：非法值回退默认，不抛错；坏值不阻塞整幅画布。 */
export function readEdgeStyle(raw: unknown): EdgeStyleView {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return DEFAULT_EDGE_STYLE;
  const record = raw as Readonly<Record<string, unknown>>;
  return {
    line: pick(record.line, EDGE_LINES, DEFAULT_EDGE_STYLE.line),
    arrow: pick(record.arrow, EDGE_ARROWS, DEFAULT_EDGE_STYLE.arrow),
    color: pick(record.color, EDGE_COLORS, DEFAULT_EDGE_STYLE.color),
    route: pick(record.route, EDGE_ROUTES, DEFAULT_EDGE_STYLE.route),
  };
}

/** 连线渲染视图：只取端点引用，不定义连线 schema（format.ts 仍原样保留）。 */
export interface CanvasEdgeView {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** 归一后的渲染样式；缺省即默认样式（兼容未带样式的测试 fixture）。 */
  readonly style?: EdgeStyleView;
  /** 连线状态/标签（复用格式层 edge.label）。 */
  readonly label?: string;
}

/** 命中容差基准：CSS px（S2），与 dpr 无关。 */
export const EDGE_HIT_TOLERANCE_PX = 6;
/** 动态容差比例：线越长，点击带越宽。 */
export const EDGE_HIT_TOLERANCE_RATIO = 0.015;
/** 动态容差上限：避免超长边吞掉相邻边。 */
export const EDGE_HIT_TOLERANCE_MAX_PX = 24;
/** 低缩放 LOD：小于该倍数画直线、去箭头。 */
export const EDGE_LOD_SCALE = 0.3;
/** 可见边硬上限：超过只告警、不绘制（选中边仍由高亮层绘制）。 */
export const EDGE_VISIBLE_LIMIT = 5000;
/** 视口裁剪外扩（容差 + 线宽）。 */
export const EDGE_CULL_PAD = 8;
/** 曲线采样段数（只用于命中测试与距离，不用于绘制）。 */
export const EDGE_SAMPLE_STEPS = 16;
/** 曲线水平控制柄长度范围（屏幕 px）。 */
export const EDGE_CURVE_OFFSET_MIN = 30; /* CR-20261121-59：控制点离节点边缘至少 30px，S 曲线不出现急转弯 */
export const EDGE_CURVE_OFFSET_MAX = 160;

export interface ScreenEdge {
  readonly id: string;
  /** LOD：true 表示低缩放，绘制与采样都退化为直线。 */
  readonly straight: boolean;
  readonly p0: Point;
  readonly c1: Point;
  readonly c2: Point;
  readonly p3: Point;
  /** 控制多边形包围盒（保守上界），用于视口裁剪与命中预筛。 */
  readonly aabb: Rect;
  /** 归一后的样式；缺省视为默认（兼容既有测试 fixture）。 */
  readonly style?: EdgeStyleView;
  /** 走线方式；缺省视为曲线。 */
  readonly route?: CanvasEdgeRoute;
  /** 直角折线的折线点（仅 route='orthogonal' 且非 LOD 时提供）。 */
  readonly points?: readonly Point[];
  readonly label?: string;
}

export interface EdgeHit {
  readonly edgeId: string;
  readonly distance: number;
}

export interface EdgeDrawWarning {
  readonly code: 'E_EDGE_BUDGET';
  readonly visible: number;
  readonly limit: number;
}

export interface EdgeDrawPlan {
  readonly straight: boolean;
  readonly visibleCount: number;
  /** 实际要画的边；预算超限时为空（高亮层单独处理选中边）。 */
  readonly edges: readonly ScreenEdge[];
  readonly warning: EdgeDrawWarning | null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function endpointNodeId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const nodeId = value.nodeId;
  return typeof nodeId === 'string' && nodeId !== '' ? nodeId : null;
}

/**
 * 从文档取可渲染连线：`id` 非空且唯一、两端 `from.nodeId` / `to.nodeId` 均能在
 * 可渲染节点集中找到。坏边跳过，不炸整张、不回写磁盘（沿 v2 容错语义）。
 */
export function extractEdgeViews(
  rawEdges: readonly unknown[],
  nodes: readonly CanvasNodeView[],
): readonly CanvasEdgeView[] {
  const known = new Set(nodes.map((node) => node.id));
  const seen = new Set<string>();
  const edges: CanvasEdgeView[] = [];
  for (const raw of rawEdges) {
    if (!isRecord(raw)) continue;
    const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : null;
    if (id === null || seen.has(id)) continue;
    const from = endpointNodeId(raw.from);
    const to = endpointNodeId(raw.to);
    if (from === null || to === null) continue;
    if (!known.has(from) || !known.has(to)) continue;
    seen.add(id);
    const label = typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label : undefined;
    const style = readEdgeStyle(raw.style);
    edges.push({ id, from, to, style, ...(label === undefined ? {} : { label }) });
  }
  return edges;
}

/** 从原始文档取连线视图（兼容入口；投影边走 `extractEdgeViews`）。 */
export function extractEdges(
  document: CanvasDocument,
  nodes: readonly CanvasNodeView[],
): readonly CanvasEdgeView[] {
  return extractEdgeViews(document.edges, nodes);
}

/**
 * 端口锚点（绝对世界坐标）：`out` = 右边缘中点，`in` = 左边缘中点。
 * 节点 `x/y` 是卡片左上角；尺寸由调用方按节点显式 `w/h` 解析，缺省 160×96。
 */
export function edgeAnchor(
  absolute: Point,
  side: 'in' | 'out',
  size: NodeSize = DEFAULT_NODE_SIZE,
): Point {
  return {
    x: absolute.x + (side === 'out' ? size.w : 0),
    y: absolute.y + size.h / 2,
  };
}

/** 绝对世界坐标 → 屏幕：`nodeLocalPosition` + `composeScreenPosition`，与 C2 同源。 */
export function absoluteToScreen(absolute: Point, transform: ViewportTransform): Point {
  return composeScreenPosition(nodeLocalPosition(absolute, transform), transform);
}

function boundsOf(points: readonly Point[]): Rect {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point.x < left) left = point.x;
    if (point.y < top) top = point.y;
    if (point.x > right) right = point.x;
    if (point.y > bottom) bottom = point.y;
  }
  return { left, top, right, bottom };
}

/**
 * 直角折线点集（确定性三点/五点路由，不做避障）：
 * - 水平对齐（|dy| < 0.5）：直线 `[p0,p3]`；
 * - 正向空间足够（dx >= 2*STUB）：`p0 → 中线 → p3` 三点；
 * - 其余情况（目标在左侧/空间不足）：先出线 STUB，再沿中线下绕后回到 p3 左边缘。
 */
export function buildOrthogonalPoints(p0: Point, p3: Point): readonly Point[] {
  if (Math.abs(p3.y - p0.y) < 0.5) return [p0, p3];
  const midX = (p0.x + p3.x) / 2;
  if (p3.x - p0.x >= EDGE_ORTHOGONAL_STUB * 2) {
    return [p0, { x: midX, y: p0.y }, { x: midX, y: p3.y }, p3];
  }
  const midY = (p0.y + p3.y) / 2;
  return [
    p0,
    { x: p0.x + EDGE_ORTHOGONAL_STUB, y: p0.y },
    { x: p0.x + EDGE_ORTHOGONAL_STUB, y: midY },
    { x: p3.x - EDGE_ORTHOGONAL_STUB, y: midY },
    { x: p3.x - EDGE_ORTHOGONAL_STUB, y: p3.y },
    p3,
  ];
}

/**
 * 构建屏幕空间连线几何。所有边共用同一变换，故 `straight`（LOD）在构建时定死。
 * 曲线为三次贝塞尔：控制柄水平，端点切线水平（端口在左右边缘中点）。
 * 直角折线只换屏幕几何（points/aabb），端点与命中仍由同一 ScreenEdge 承载。
 */
function buildScreenEdge(
  edge: CanvasEdgeView,
  positions: ReadonlyMap<string, Point>,
  sizes: ReadonlyMap<string, NodeSize>,
  transform: ViewportTransform,
): ScreenEdge | null {
  const from = positions.get(edge.from);
  const to = positions.get(edge.to);
  if (from === undefined || to === undefined) return null;
  const straight = transform.scale < EDGE_LOD_SCALE;
  const p0 = absoluteToScreen(
    edgeAnchor(from, 'out', sizes.get(edge.from) ?? DEFAULT_NODE_SIZE),
    transform,
  );
  const p3 = absoluteToScreen(
    edgeAnchor(to, 'in', sizes.get(edge.to) ?? DEFAULT_NODE_SIZE),
    transform,
  );
  const style = edge.style ?? DEFAULT_EDGE_STYLE;
  const offset = clamp(
    Math.abs(p3.x - p0.x) * 0.5,
    EDGE_CURVE_OFFSET_MIN,
    EDGE_CURVE_OFFSET_MAX,
  );
  const c1 = { x: p0.x + offset, y: p0.y };
  const c2 = { x: p3.x - offset, y: p3.y };
  const points =
    style.route === 'orthogonal' && !straight ? buildOrthogonalPoints(p0, p3) : undefined;
  return {
    id: edge.id,
    straight,
    p0,
    c1,
    c2,
    p3,
    aabb: points === undefined ? boundsOf([p0, c1, c2, p3]) : boundsOf(points),
    style,
    route: style.route,
    ...(points === undefined ? {} : { points }),
    ...(edge.label === undefined ? {} : { label: edge.label }),
  };
}

function nodePositions(nodes: readonly CanvasNodeView[]): Map<string, Point> {
  const positions = new Map<string, Point>();
  for (const node of nodes) positions.set(node.id, { x: node.x, y: node.y });
  return positions;
}

function nodeSizes(nodes: readonly CanvasNodeView[]): Map<string, NodeSize> {
  const sizes = new Map<string, NodeSize>();
  for (const node of nodes) sizes.set(node.id, nodeSizeOf(node));
  return sizes;
}

export function buildScreenEdges(
  edges: readonly CanvasEdgeView[],
  nodes: readonly CanvasNodeView[],
  transform: ViewportTransform,
): readonly ScreenEdge[] {
  const positions = nodePositions(nodes);
  const sizes = nodeSizes(nodes);
  const result: ScreenEdge[] = [];
  for (const edge of edges) {
    const screen = buildScreenEdge(edge, positions, sizes, transform);
    if (screen !== null) result.push(screen);
  }
  return result;
}

/** 增量重算的硬阈值；两者均为「严格大于」才退化。 */
export const EDGE_INCREMENTAL_MAX_INCIDENT = 200;
export const EDGE_INCREMENTAL_VISIBLE_RATIO = 0.4;

/**
 * 节点 → incident edge id。重复 id、空 id、缺端点与（传入 nodes 时）缺节点的边跳过；
 * 每个节点下同一 edge id 只出现一次，自环也不会重复计数。
 */
export function buildNodeAdjacency(
  edges: readonly CanvasEdgeView[],
  nodes?: readonly CanvasNodeView[],
): ReadonlyMap<string, readonly string[]> {
  const known = nodes === undefined ? null : new Set(nodes.map((node) => node.id));
  const seenEdges = new Set<string>();
  const adjacency = new Map<string, Set<string>>();
  const add = (nodeId: string, edgeId: string): void => {
    const bucket = adjacency.get(nodeId) ?? new Set<string>();
    bucket.add(edgeId);
    adjacency.set(nodeId, bucket);
  };
  for (const edge of edges) {
    if (edge.id === '' || seenEdges.has(edge.id)) continue;
    if (edge.from === '' || edge.to === '') continue;
    if (known !== null && (!known.has(edge.from) || !known.has(edge.to))) continue;
    seenEdges.add(edge.id);
    add(edge.from, edge.id);
    add(edge.to, edge.id);
  }
  return new Map([...adjacency].map(([id, bucket]) => [id, [...bucket]]));
}

/**
 * 节点 → incident edge id 集合。重复 id、空 id、坏边跳过；自环只计一次；
 * 选中集中不存在的节点不产生边。
 */
export function incidentEdgeIds(
  edges: readonly CanvasEdgeView[],
  nodeIds: Iterable<string>,
): ReadonlySet<string> {
  const wanted = new Set(nodeIds);
  const result = new Set<string>();
  if (wanted.size === 0) return result;
  const seen = new Set<string>();
  for (const edge of edges) {
    if (edge.id === '' || seen.has(edge.id)) continue;
    if (!wanted.has(edge.from) && !wanted.has(edge.to)) continue;
    seen.add(edge.id);
    result.add(edge.id);
  }
  return result;
}

export interface ScreenEdgeUpdate {
  readonly edges: readonly ScreenEdge[];
  readonly incidentCount: number;
  /** 仅增量路径退化时计数；初次装载与 transform 全量重投影不算退化。 */
  readonly degenerated: boolean;
}

export interface ScreenEdgeCache {
  update(
    edges: readonly CanvasEdgeView[],
    nodes: readonly CanvasNodeView[],
    transform: ViewportTransform,
    size: ViewportSize,
    movedNodeIds?: ReadonlySet<string>,
  ): ScreenEdgeUpdate;
}

function sameTransform(a: ViewportTransform, b: ViewportTransform): boolean {
  return (
    a.tx === b.tx &&
    a.ty === b.ty &&
    a.scale === b.scale &&
    a.originX === b.originX &&
    a.originY === b.originY
  );
}

/**
 * C4 拖拽缓存：相机与边集不变时只重算移动节点的 incident 边；输出始终按
 * `edgeViews` 原顺序重建，不能用 Map 迭代顺序代替绘制顺序。
 */
export function createScreenEdgeCache(): ScreenEdgeCache {
  let sourceEdges: readonly CanvasEdgeView[] | null = null;
  let previousTransform: ViewportTransform | null = null;
  let edgeById = new Map<string, CanvasEdgeView>();
  let adjacency: ReadonlyMap<string, readonly string[]> = new Map();
  let cache = new Map<string, ScreenEdge>();
  let ordered: readonly ScreenEdge[] = [];

  const rebuild = (
    edges: readonly CanvasEdgeView[],
    nodes: readonly CanvasNodeView[],
    transform: ViewportTransform,
    incidentCount: number,
    degenerated: boolean,
  ): ScreenEdgeUpdate => {
    if (sourceEdges !== edges) {
      edgeById = new Map(edges.map((edge) => [edge.id, edge]));
      adjacency = buildNodeAdjacency(edges, nodes);
      sourceEdges = edges;
    }
    ordered = buildScreenEdges(edges, nodes, transform);
    cache = new Map(ordered.map((edge) => [edge.id, edge]));
    previousTransform = { ...transform };
    return { edges: ordered, incidentCount, degenerated };
  };

  return {
    update(edges, nodes, transform, size, movedNodeIds = new Set<string>()): ScreenEdgeUpdate {
      if (
        previousTransform === null ||
        sourceEdges !== edges ||
        !sameTransform(previousTransform, transform)
      ) {
        return rebuild(edges, nodes, transform, 0, false);
      }

      const incident = new Set<string>();
      for (const nodeId of movedNodeIds) {
        for (const edgeId of adjacency.get(nodeId) ?? []) incident.add(edgeId);
      }
      if (incident.size === 0) {
        return { edges: ordered, incidentCount: 0, degenerated: false };
      }
      if (incident.size > EDGE_INCREMENTAL_MAX_INCIDENT) {
        return rebuild(edges, nodes, transform, incident.size, true);
      }

      const positions = nodePositions(nodes);
      const sizes = nodeSizes(nodes);
      for (const edgeId of incident) {
        const edge = edgeById.get(edgeId);
        const screen =
          edge === undefined ? null : buildScreenEdge(edge, positions, sizes, transform);
        if (screen === null) cache.delete(edgeId);
        else cache.set(edgeId, screen);
      }
      const next: ScreenEdge[] = [];
      for (const edge of edges) {
        const screen = cache.get(edge.id);
        if (screen !== undefined) next.push(screen);
      }
      const visibleCount = cullScreenEdges(next, size).length;
      if (incident.size > visibleCount * EDGE_INCREMENTAL_VISIBLE_RATIO) {
        return rebuild(edges, nodes, transform, incident.size, true);
      }
      ordered = next;
      previousTransform = { ...transform };
      return { edges: ordered, incidentCount: incident.size, degenerated: false };
    },
  };
}

/** 三次贝塞尔在 t 处取值。 */
export function cubicAt(edge: ScreenEdge, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * edge.p0.x + b * edge.c1.x + c * edge.c2.x + d * edge.p3.x,
    y: a * edge.p0.y + b * edge.c1.y + c * edge.c2.y + d * edge.p3.y,
  };
}

/** 连线中点（标签锚点）：直角折线按折线弧长 50% 取点。 */
export function edgeMidpoint(edge: ScreenEdge): Point {
  if (edge.points !== undefined && edge.points.length >= 2) {
    return pointAtPolylineLength(edge.points, polylineLength(edge.points) / 2);
  }
  return cubicAt(edge, 0.5);
}

/** 命中测试用折线：直线 LOD 只取两端点，直角折线直接返回顶点，曲线按固定段数采样。 */
export function edgeSamples(edge: ScreenEdge): readonly Point[] {
  if (edge.straight) return [edge.p0, edge.p3];
  if (edge.points !== undefined && edge.points.length >= 2) return edge.points;
  const samples: Point[] = [];
  for (let index = 0; index <= EDGE_SAMPLE_STEPS; index += 1) {
    samples.push(cubicAt(edge, index / EDGE_SAMPLE_STEPS));
  }
  return samples;
}

/** 折线长度（CSS px）。 */
export function polylineLength(points: readonly Point[]): number {
  let total = 0;
  for (let index = 0; index + 1 < points.length; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    if (a === undefined || b === undefined) continue;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/** 折线弧长 `distance` 处的点（夹在 [0, 总长] 内）。 */
export function pointAtPolylineLength(points: readonly Point[], distance: number): Point {
  const fallback = points[0] ?? { x: 0, y: 0 };
  if (points.length === 0) return fallback;
  let remaining = Math.max(0, Math.min(polylineLength(points), distance));
  for (let index = 0; index + 1 < points.length; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    if (a === undefined || b === undefined) continue;
    const segment = Math.hypot(b.x - a.x, b.y - a.y);
    if (remaining <= segment || index + 2 === points.length) {
      const ratio = segment === 0 ? 0 : remaining / segment;
      return { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio };
    }
    remaining -= segment;
  }
  return points.at(-1) ?? fallback;
}

/** 只保留与视口（外扩 pad）相交的边。 */
export function cullScreenEdges(
  edges: readonly ScreenEdge[],
  size: ViewportSize,
  pad = EDGE_CULL_PAD,
): readonly ScreenEdge[] {
  return edges.filter(
    (edge) =>
      edge.aabb.right >= -pad &&
      edge.aabb.left <= size.width + pad &&
      edge.aabb.bottom >= -pad &&
      edge.aabb.top <= size.height + pad,
  );
}

/** 降级链的纯决策：裁剪 → 预算；LOD 已在 `buildScreenEdges` 定死。 */
export function planEdgeDraw(
  edges: readonly ScreenEdge[],
  size: ViewportSize,
): EdgeDrawPlan {
  const visible = cullScreenEdges(edges, size);
  const straight = edges[0]?.straight ?? false;
  if (visible.length > EDGE_VISIBLE_LIMIT) {
    return {
      straight,
      visibleCount: visible.length,
      edges: [],
      warning: { code: 'E_EDGE_BUDGET', visible: visible.length, limit: EDGE_VISIBLE_LIMIT },
    };
  }
  return { straight, visibleCount: visible.length, edges: visible, warning: null };
}

/** 点到线段距离。 */
export function pointSegmentDistance(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = clamp(
    ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared,
    0,
    1,
  );
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/** 点到折线的最小距离。 */
export function distanceToPolyline(point: Point, points: readonly Point[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index + 1 < points.length; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    if (a === undefined || b === undefined) continue;
    const distance = pointSegmentDistance(point, a, b);
    if (distance < best) best = distance;
  }
  return best;
}

/**
 * 单边命中容差：`max(6, min(24, 线长 × 0.015))`，单位 CSS px（S2）。
 * 上限避免超长边把相邻边的点击带全部吞掉。
 */
export function edgeHitTolerance(edge: ScreenEdge): number {
  const length = polylineLength(edgeSamples(edge));
  return Math.max(
    EDGE_HIT_TOLERANCE_PX,
    Math.min(EDGE_HIT_TOLERANCE_MAX_PX, length * EDGE_HIT_TOLERANCE_RATIO),
  );
}

/**
 * 命中测试：AABB 预筛（扩容差）→ 点到折线距离 → 取最近。
 * 同距取数组中靠后的边（绘制顺序更靠上）。
 */
export function hitTestEdges(edges: readonly ScreenEdge[], point: Point): EdgeHit | null {
  let best: EdgeHit | null = null;
  for (const edge of edges) {
    const tolerance = edgeHitTolerance(edge);
    const { aabb } = edge;
    if (
      point.x < aabb.left - tolerance ||
      point.x > aabb.right + tolerance ||
      point.y < aabb.top - tolerance ||
      point.y > aabb.bottom + tolerance
    ) {
      continue;
    }
    const distance = distanceToPolyline(point, edgeSamples(edge));
    if (distance > tolerance) continue;
    if (best === null || distance <= best.distance) best = { edgeId: edge.id, distance };
  }
  return best;
}
