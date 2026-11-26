/**
 * 节点布局（C2）：纯坐标计算，不碰 DOM、不导入 CSS Modules，可直接在 node 下测试。
 *
 * 坐标口径（CR-20261117-02 §2.2 / §7.5）：
 * - 磁盘 `nodes[].x/y` 是绝对世界坐标（absolute），唯一位置真相；
 * - DOM `left/top` 用局部坐标 `local = absolute - origin`，避开大数 float 精度；
 * - 容器变换折入 `origin * s`，因此 `screen = local * s + tx + origin * s`
 *   与三式 `screen = absolute * s + tx` 等价（S2 单测钉死 1e-9）。
 *
 * `origin` 的唯一载体是 `ViewportTransform.originX/originY`；`lastOrigin`
 * 只是装载时恢复它的非权威提示。
 *
 * 纪律：本文件所有坐标公式必须从 `viewport.ts` 导入，或经 `composeScreenPosition`
 * 单函数推导（S1）；不得在此另写一份等价公式。
 */
import { MAX_NODE_DIMENSION } from '#canvas-format';
import type { CanvasDocument } from './format.ts';
import type { Point, Rect, ViewportTransform } from './viewport.ts';

/**
 * 节点盒尺寸（世界单位，scale = 1 时即 CSS px）。
 *
 * C3 端点的结构性依赖（CR-20261117-02 §13.1 方案 C）：缺省盒尺寸为 160×96；
 * 格式层允许显式 `w/h`，由 `nodeSizeOf` 校验后覆盖缺省值。CSS `.node` 的缺省
 * 尺寸与这两个常量由 `edge-layout.test.ts` 的源码断言钉死。
 */
export const NODE_WIDTH = 160;
export const NODE_HEIGHT = 96;

/**
 * 特殊节点（AI / 提示词）固定盒尺寸：用户 2026-11-23 要求尺寸固定、不可拖拽改变。
 * 视图层与命中检测都以 kind 为准，不写盘；CSS 侧由 `.node[data-node-type]` 同步钉死。
 */
export const AI_NODE_WIDTH = 420;
/** 提示词编辑区 + 底部操作行的固定宽扁卡片。 */
export const AI_NODE_HEIGHT = 190;
export const PROMPT_NODE_WIDTH = 320;
export const PROMPT_NODE_HEIGHT = 136;

export function isFixedSizeNodeKind(kind: string | undefined): kind is 'ai' | 'prompt' {
  return kind === 'ai' || kind === 'prompt';
}

/**
 * CR-20261119-05：内容模式阈值——高度严格大于缺省 96px 即展开正文。
 * 零 schema 变更：状态完全由既有 w/h 表达。
 */
export const NODE_CONTENT_MODE_HEIGHT = NODE_HEIGHT;

export interface NodeSize {
  readonly w: number;
  readonly h: number;
}

function validNodeDimension(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_NODE_DIMENSION
    ? value
    : null;
}

/**
 * 节点盒尺寸：显式 `w/h` 各自独立判断，合法才采用；否则分别回退 NODE_WIDTH / NODE_HEIGHT。
 * document 节点 h 缺省时回退 autoH（视图层测量值，不写盘）。
 * 只读投影，不修复、不回写文档（CR-20261118-05 §4.2）。
 */
export function nodeSizeOf(node: {
  readonly w?: number;
  readonly h?: number;
  readonly autoH?: number;
  readonly kind?: 'ai' | 'prompt';
}): NodeSize {
  if (node.kind === 'ai') return { w: AI_NODE_WIDTH, h: AI_NODE_HEIGHT };
  if (node.kind === 'prompt') return { w: PROMPT_NODE_WIDTH, h: PROMPT_NODE_HEIGHT };
  return {
    w: validNodeDimension(node.w) ?? NODE_WIDTH,
    h: node.h !== undefined
      ? (validNodeDimension(node.h) ?? NODE_HEIGHT)
      : (validNodeDimension(node.autoH) ?? NODE_HEIGHT),
  };
}

/** CR-20261119-05：文档节点高度 > 96px 进入内容模式；缩回 96px 恢复卡片模式。
 *  CR-20261119-12 只看显式 h——autoH 不触发模式切换；参数接受 autoH 但不读取。 */
export function isNodeContentMode(node: { readonly h?: number; readonly autoH?: number }): boolean {
  return node.h !== undefined && node.h > NODE_CONTENT_MODE_HEIGHT;
}

/** C2 渲染视图：只取渲染必需字段，不定义节点 schema（format.ts 仍原样保留）。 */
export interface CanvasNodeView {
  readonly id: string;
  readonly label: string;
  /** 绝对世界坐标（磁盘值）。 */
  readonly x: number;
  readonly y: number;
  /** 显式节点宽高；缺失或非法时不透出，渲染层回退 160×96。 */
  readonly w?: number;
  readonly h?: number;
  /** P6-C1-C：媒体预览信息；其它类型或旧媒体节点（无 path）缺省。 */
  readonly media?: {
    readonly kind: 'image' | 'audio' | 'video' | 'doc';
    readonly path: string;
  };
  /** CR-20261119-05：文档节点关联路径；卡片元数据与正文预览的数据源。 */
  readonly docPath?: string;
  /** CR-20261121-53：节点种类判别（ai/prompt 自 raw.type 提取；其余类型缺省）。 */
  readonly kind?: 'ai' | 'prompt';
  /** CR-20261121-59：组节点标记（视图层与自由文本同形，卡片渲染需区分）。 */
  readonly group?: boolean;
  /** CR-20261121-53：ai 节点已选模型；未选择时缺省字段。 */
  readonly aiModel?: string;
  /** ai/prompt 节点提示词正文（可为空串）；其他节点缺省。 */
  readonly promptText?: string;
  /** CR-20261119-12：document 节点自动测量高度（视图层，不序列化）。 */
  readonly autoH?: number;
}

/** CR-20261119-12：把 engine 测量结果合进渲染视图。不可变 `.map`，禁止 Object.assign。
 *  - 显式 h 的节点：不写 autoH（手动接管），原样返回；
 *  - document 节点 h 缺省：从 Map 取 autoH 合进 view；Map 中没有则不写 autoH 字段；
 *  - 其他节点（text/media/group/ai/prompt）原样返回；prompt 自 2026-11-23 起改为固定尺寸，
 *    不再参与自动撑高；保留本函数对历史 autoH 的忽略，防止旧测量值影响布局。 */
export function mergeAutoHeights(
  nodeViews: readonly CanvasNodeView[],
  autoHeightMap: ReadonlyMap<string, number>,
): readonly CanvasNodeView[] {
  return nodeViews.map((v) => {
    if (v.h !== undefined) return v;
    if (v.docPath !== undefined) {
      const h = autoHeightMap.get(v.id);
      if (h !== undefined) return { ...v, autoH: h };
    }
    return v;
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `lastOrigin` 缺失或非法一律按 (0,0)（CR-20261117-02 §2.2/§3.2）。 */
export function readOrigin(document: CanvasDocument): Point {
  const raw = document.lastOrigin;
  if (!isRecord(raw)) return { x: 0, y: 0 };
  const x = finite(raw.x);
  const y = finite(raw.y);
  return x === null || y === null ? { x: 0, y: 0 } : { x, y };
}

/** 把磁盘 origin 写进变换；不新建坐标系，只补 `originX/originY`。 */
export function applyOrigin(transform: ViewportTransform, origin: Point): ViewportTransform {
  return { ...transform, originX: origin.x, originY: origin.y };
}

export { mediaUrlForPath } from '../../core/media-url.ts';

/** 媒体路径的文件名；用于判断标签是否只是内容寻址文件名（旧节点）。 */
export function mediaFileName(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return base === '' ? normalized : base;
}

/** 文档与自定义媒体名称显示在节点外上方；其它节点没有这层外标题。 */
export function hasOutsideNodeLabel(node: CanvasNodeView): boolean {
  if (node.docPath !== undefined) return true;
  return node.media !== undefined && node.label !== '' && node.label !== mediaFileName(node.media.path);
}

/** 外标题的本地坐标、宽度与缩放补偿字号；null 表示沿用 CSS 的 13px。 */
export function nodeOutsideLabelLayout(
  node: CanvasNodeView,
  transform: ViewportTransform,
): Point & { readonly width: number; readonly fontSize: number | null } {
  const local = nodeLocalPosition(node, transform);
  const compensated = transform.scale * 13 < 11;
  return {
    x: local.x,
    y: local.y - (compensated ? 17.2 / transform.scale : 20),
    width: nodeSizeOf(node).w,
    fontSize: compensated ? Number((11 / transform.scale).toFixed(2)) : null,
  };
}

function readMediaView(
  raw: Readonly<Record<string, unknown>>,
): CanvasNodeView['media'] {
  if (raw.type !== 'media') return undefined;
  const kind = raw.kind;
  const path = raw.path;
  if (kind !== 'image' && kind !== 'audio' && kind !== 'video' && kind !== 'doc') return undefined;
  if (typeof path !== 'string' || path === '') return undefined;
  return { kind, path };
}

/**
 * 从任意节点数组取可渲染视图：`id` 为非空字符串且 `x/y` 为有限数才参与渲染。
 * 坏节点跳过，不炸整张画布、不回写磁盘。
 */
export function extractNodeViews(rawNodes: readonly unknown[]): readonly CanvasNodeView[] {
  const nodes: CanvasNodeView[] = [];
  for (const raw of rawNodes) {
    if (!isRecord(raw)) continue;
    const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : null;
    const x = finite(raw.x);
    const y = finite(raw.y);
    if (id === null || x === null || y === null) continue;
    const label = typeof raw.label === 'string' && raw.label !== '' ? raw.label : id;
    const w = validNodeDimension(raw.w);
    const h = validNodeDimension(raw.h);
    const view: CanvasNodeView = {
      id,
      label,
      x,
      y,
      ...(w === null ? {} : { w }),
      ...(h === null ? {} : { h }),
    };
    const media = readMediaView(raw);
    const docPath =
      raw.type === 'document' && typeof raw.docPath === 'string' && raw.docPath !== ''
        ? raw.docPath
        : null;
    // ai/prompt 节点视图字段（text 可为空串，占位由渲染层判定）。
    const kind = raw.type === 'ai' || raw.type === 'prompt' ? raw.type : null;
    const group = raw.type === 'group' ? true : null;
    const aiModel =
      raw.type === 'ai' && typeof raw.model === 'string' && raw.model !== '' ? raw.model : null;
    const promptText = kind !== null && typeof raw.text === 'string' ? raw.text : null;
    const extras: Partial<CanvasNodeView> = {
      ...(media === undefined ? {} : { media }),
      ...(docPath === null ? {} : { docPath }),
      ...(kind === null ? {} : { kind }),
      ...(group === null ? {} : { group }),
      ...(aiModel === null ? {} : { aiModel }),
      ...(promptText === null ? {} : { promptText }),
    };
    if (Object.keys(extras).length === 0) nodes.push(view);
    else nodes.push({ ...view, ...extras });
  }
  return nodes;
}

/** 从原始文档取渲染视图（兼容入口；投影节点走 `extractNodeViews`）。 */
export function extractNodes(document: CanvasDocument): readonly CanvasNodeView[] {
  return extractNodeViews(document.nodes);
}

/** DOM 坐标：left/top = absolute - origin。 */
export function nodeLocalPosition(node: Point, transform: ViewportTransform): Point {
  return { x: node.x - transform.originX, y: node.y - transform.originY };
}

/** 屏幕坐标基式（唯一来源）：`screen = local * s + tx + origin * s`。 */
export function composeScreenPosition(local: Point, transform: ViewportTransform): Point {
  const { tx, ty, scale, originX, originY } = transform;
  return {
    x: local.x * scale + tx + originX * scale,
    y: local.y * scale + ty + originY * scale,
  };
}

/** 节点屏幕坐标：local * s + tx + origin * s（容器折入 origin 后的等价式）。 */
export function nodeScreenPosition(local: Point, transform: ViewportTransform): Point {
  return composeScreenPosition(local, transform);
}

/**
 * 世界层容器平移量：tx + origin * s，即 local = (0,0) 时的基式。
 * `world-layer` 的 CSS transform 与本函数同源，保证 DOM 与三式不分叉。
 */
export function worldContainerOffset(transform: ViewportTransform): Point {
  return composeScreenPosition({ x: 0, y: 0 }, transform);
}

/** 初始适配与手动 fit-all 共用的绝对世界矩形集（含文档 autoH）。 */
export function nodeWorldRects(nodes: readonly CanvasNodeView[]): readonly Rect[] {
  return nodes.map((node) => {
    const size = nodeSizeOf(node);
    return { left: node.x, top: node.y, right: node.x + size.w, bottom: node.y + size.h };
  });
}

/** C4 节点屏幕 AABB：盒尺寸随 scale 缩放，命中统一使用 CSS px。 */
export function nodeScreenRect(node: CanvasNodeView, transform: ViewportTransform): Rect {
  const topLeft = composeScreenPosition(nodeLocalPosition(node, transform), transform);
  const size = nodeSizeOf(node);
  return {
    left: topLeft.x,
    top: topLeft.y,
    right: topLeft.x + size.w * transform.scale,
    bottom: topLeft.y + size.h * transform.scale,
  };
}

/** 节点命中优先级高于连线；同层重叠时取 nodes 数组靠后者（DOM 绘制顺序更靠上）。 */
export function hitTestNodes(
  nodes: readonly CanvasNodeView[],
  transform: ViewportTransform,
  point: Point,
): CanvasNodeView | null {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node === undefined) continue;
    const rect = nodeScreenRect(node, transform);
    if (
      point.x >= rect.left &&
      point.x <= rect.right &&
      point.y >= rect.top &&
      point.y <= rect.bottom
    ) {
      return node;
    }
  }
  return null;
}

function intersects(a: Rect, b: Rect): boolean {
  return a.right >= b.left && a.left <= b.right && a.bottom >= b.top && a.top <= b.bottom;
}

/** 框选只选节点，相交即选；支持反向拖拽形成的矩形。 */
export function marqueeNodeIds(
  nodes: readonly CanvasNodeView[],
  transform: ViewportTransform,
  marquee: Rect,
): readonly string[] {
  const normalized = {
    left: Math.min(marquee.left, marquee.right),
    top: Math.min(marquee.top, marquee.bottom),
    right: Math.max(marquee.left, marquee.right),
    bottom: Math.max(marquee.top, marquee.bottom),
  };
  return nodes
    .filter((node) => intersects(nodeScreenRect(node, transform), normalized))
    .map((node) => node.id);
}
