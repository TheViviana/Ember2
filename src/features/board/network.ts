/**
 * S5：知识网络、分布分析与时间线（纯函数，零依赖）。
 *
 * 所有函数只接收调用方给的数据，不 invoke、不读 localStorage、不摸定时器：
 * - 图构建：只保留两端都在范围内的链接，无向去重；超过上限按主维度聚合；
 * - 布局：Fruchterman–Reingold 变体，初始坐标由维度分组 + 黄金角螺旋确定，
 *   不使用 `Math.random`，同一输入必得同一坐标；
 * - 分布 / 时间线口径与 `docs/board-ai-plan-v2.md` §2.2 保持一致（本地日期、近 30 天活跃）。
 */
import {
  BOARD_DIMENSIONS,
  BOARD_DIMENSION_IDS,
  DAY_MS,
  localDateKey,
  normalizeDimensions,
  type BoardDimensionId,
  type BoardDocStat,
  type BoardLink,
} from './model.ts';

export const NETWORK_NODE_LIMIT = 500;
export const NETWORK_WIDTH = 880;
export const NETWORK_HEIGHT = 320;
export const NETWORK_PADDING = 26;
export const NETWORK_TAG_LIMIT = 8;
export const NETWORK_ISSUE_LIMIT = 20;
export const NETWORK_LABEL_LIMIT = 12;
export const TIMELINE_LIMIT = 40;
export const NETWORK_GROUP_PREFIX = 'group:';

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const ACTIVE_DAYS = 30;

const DIMENSION_IDS: readonly BoardDimensionId[] = BOARD_DIMENSION_IDS;
const GROUP_RANK = new Map<string, number>(
  DIMENSION_IDS.map((id, index) => [id, index] as const),
);

export interface NetworkNode {
  readonly id: string;
  readonly label: string;
  readonly degree: number;
  /** 节点权重：字数为 0（大文件跳过）时用 bytes / 4 近似。 */
  readonly weight: number;
  readonly dimensionId: BoardDimensionId | null;
  readonly isolated: boolean;
  /** 聚合节点代表的文档数；普通节点恒为 1。 */
  readonly documentCount: number;
  readonly x: number;
  readonly y: number;
}

export interface NetworkEdge {
  readonly source: string;
  readonly target: string;
  /** 去重后的同向重复链接次数。 */
  readonly weight: number;
}

export interface NetworkGraph {
  readonly nodes: readonly NetworkNode[];
  readonly edges: readonly NetworkEdge[];
  /** true = 文档数超过上限，已按主维度聚合。 */
  readonly aggregated: boolean;
}

export interface NetworkBuildOptions {
  readonly limit?: number;
}

export interface NetworkLayoutOptions {
  readonly width?: number;
  readonly height?: number;
  readonly padding?: number;
  readonly iterations?: number;
}

export function isNetworkGroupId(id: string): boolean {
  return id.startsWith(NETWORK_GROUP_PREFIX);
}

/** 主维度：按八维固定顺序取首个；未标注返回 null。 */
export function primaryDimension(
  dimensions: readonly BoardDimensionId[] | undefined,
): BoardDimensionId | null {
  if (dimensions === undefined || dimensions.length === 0) return null;
  return normalizeDimensions(dimensions)[0] ?? null;
}

function pathWeight(doc: BoardDocStat): number {
  return doc.wordCount > 0 ? doc.wordCount : Math.max(1, Math.round(doc.bytes / 4));
}

interface PathPair {
  readonly a: string;
  readonly b: string;
  weight: number;
}

/** 无向去重；只保留两端都在 `paths` 内的链接。 */
function collectPairs(
  links: readonly BoardLink[],
  paths: ReadonlySet<string>,
): readonly PathPair[] {
  const pairs = new Map<string, PathPair>();
  for (const link of links) {
    const from = link.from;
    const to = link.to;
    if (from === '' || from === to) continue;
    if (!paths.has(from) || !paths.has(to)) continue;
    const [a, b] = from < to ? [from, to] : [to, from];
    const key = `${a}\u0000${b}`;
    const existing = pairs.get(key);
    if (existing === undefined) {
      pairs.set(key, { a, b, weight: 1 });
    } else {
      existing.weight += 1;
    }
  }
  return [...pairs.values()];
}

function degreeOf(paths: readonly string[], pairs: readonly PathPair[]): Map<string, number> {
  const degrees = new Map<string, number>();
  for (const path of paths) degrees.set(path, 0);
  for (const pair of pairs) {
    if (degrees.has(pair.a)) degrees.set(pair.a, (degrees.get(pair.a) ?? 0) + 1);
    if (degrees.has(pair.b)) degrees.set(pair.b, (degrees.get(pair.b) ?? 0) + 1);
  }
  return degrees;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function buildPerDocGraph(
  docs: readonly BoardDocStat[],
  classification: ReadonlyMap<string, readonly BoardDimensionId[]>,
  pairs: readonly PathPair[],
): NetworkGraph {
  const degrees = degreeOf(
    docs.map((doc) => doc.path),
    pairs,
  );
  const nodes: NetworkNode[] = docs.map((doc) => {
    const degree = degrees.get(doc.path) ?? 0;
    return {
      id: doc.path,
      label: doc.title,
      degree,
      weight: pathWeight(doc),
      dimensionId: primaryDimension(classification.get(doc.path)),
      isolated: degree === 0,
      documentCount: 1,
      x: 0,
      y: 0,
    };
  });
  const edges: NetworkEdge[] = pairs.map((pair) => ({
    source: pair.a,
    target: pair.b,
    weight: pair.weight,
  }));
  return {
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    aggregated: false,
  };
}

function groupKeyOf(dimensionId: BoardDimensionId | null): string {
  return dimensionId === null ? 'unclassified' : dimensionId;
}

function groupLabelOf(key: string): string {
  if (key === 'unclassified') return '未分类';
  const meta = BOARD_DIMENSIONS.find((dimension) => dimension.id === key);
  return meta?.shortLabel ?? key;
}

/**
 * 超过上限时按主维度聚合：节点 = 维度分组，边 = 跨组链接次数之和（组内边忽略）。
 * 500 节点只是渲染上限，聚合后节点数最多 9 个，保证布局与交互不崩。
 */
function buildAggregatedGraph(
  docs: readonly BoardDocStat[],
  classification: ReadonlyMap<string, readonly BoardDimensionId[]>,
  pairs: readonly PathPair[],
): NetworkGraph {
  const groupByPath = new Map<string, string>();
  const groups = new Map<
    string,
    { dimensionId: BoardDimensionId | null; weight: number; documentCount: number }
  >();

  for (const doc of docs) {
    const dimensionId = primaryDimension(classification.get(doc.path));
    const key = groupKeyOf(dimensionId);
    groupByPath.set(doc.path, key);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        dimensionId,
        weight: pathWeight(doc),
        documentCount: 1,
      });
    } else {
      existing.weight += pathWeight(doc);
      existing.documentCount += 1;
    }
  }

  const edgeWeights = new Map<string, { source: string; target: string; weight: number }>();
  const neighbours = new Map<string, Set<string>>();
  for (const pair of pairs) {
    const source = groupByPath.get(pair.a);
    const target = groupByPath.get(pair.b);
    if (source === undefined || target === undefined || source === target) continue;
    const [a, b] = source < target ? [source, target] : [target, source];
    const key = `${a}\u0000${b}`;
    const existing = edgeWeights.get(key);
    if (existing === undefined) edgeWeights.set(key, { source: a, target: b, weight: pair.weight });
    else existing.weight += pair.weight;

    const aSet = neighbours.get(a) ?? new Set<string>();
    aSet.add(b);
    neighbours.set(a, aSet);
    const bSet = neighbours.get(b) ?? new Set<string>();
    bSet.add(a);
    neighbours.set(b, bSet);
  }

  const keys = [...groups.keys()].sort(
    (a, b) => (GROUP_RANK.get(a) ?? DIMENSION_IDS.length) - (GROUP_RANK.get(b) ?? DIMENSION_IDS.length),
  );
  const nodes: NetworkNode[] = keys.map((key) => {
    const group = groups.get(key);
    const degree = neighbours.get(key)?.size ?? 0;
    return {
      id: `${NETWORK_GROUP_PREFIX}${key}`,
      label: groupLabelOf(key),
      degree,
      weight: group?.weight ?? 0,
      dimensionId: group?.dimensionId ?? null,
      isolated: degree === 0,
      documentCount: group?.documentCount ?? 0,
      x: 0,
      y: 0,
    };
  });
  const edges: NetworkEdge[] = [...edgeWeights.values()].map((edge) => ({
    source: `${NETWORK_GROUP_PREFIX}${edge.source}`,
    target: `${NETWORK_GROUP_PREFIX}${edge.target}`,
    weight: edge.weight,
  }));

  return {
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    aggregated: true,
  };
}

export function buildNetworkGraph(
  docs: readonly BoardDocStat[],
  classification: ReadonlyMap<string, readonly BoardDimensionId[]>,
  links: readonly BoardLink[],
  options: NetworkBuildOptions = {},
): NetworkGraph {
  const limit = options.limit ?? NETWORK_NODE_LIMIT;
  if (docs.length === 0) {
    return { nodes: Object.freeze([]), edges: Object.freeze([]), aggregated: false };
  }
  // 排序保证布局确定性，不受索引遍历顺序影响。
  const sorted = [...docs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const paths = new Set(sorted.map((doc) => doc.path));
  const pairs = collectPairs(links, paths);
  return docs.length > limit
    ? buildAggregatedGraph(sorted, classification, pairs)
    : buildPerDocGraph(sorted, classification, pairs);
}

interface Point {
  readonly x: number;
  readonly y: number;
}

function groupRankOf(dimensionId: BoardDimensionId | null): number {
  return dimensionId === null ? DIMENSION_IDS.length : (GROUP_RANK.get(dimensionId) ?? 0);
}

/** 确定性初始坐标：维度分组 → 大圆上的组心 → 组内黄金角螺旋。 */
function initialPositions(
  nodes: readonly NetworkNode[],
  width: number,
  height: number,
): Map<string, Point> {
  const groups = new Map<string, NetworkNode[]>();
  for (const node of nodes) {
    const key = node.dimensionId ?? 'unclassified';
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [node]);
    else list.push(node);
  }
  const keys = [...groups.keys()].sort(
    (a, b) =>
      groupRankOf(a === 'unclassified' ? null : (a as BoardDimensionId)) -
      groupRankOf(b === 'unclassified' ? null : (b as BoardDimensionId)),
  );
  const centerX = width / 2;
  const centerY = height / 2;
  const orbit = keys.length <= 1 ? 0 : Math.min(width, height) * 0.33;
  const positions = new Map<string, Point>();
  keys.forEach((key, groupIndex) => {
    const list = groups.get(key) ?? [];
    const angle = -Math.PI / 2 + (groupIndex * 2 * Math.PI) / Math.max(1, keys.length);
    const groupX = keys.length <= 1 ? centerX : centerX + Math.cos(angle) * orbit;
    const groupY = keys.length <= 1 ? centerY : centerY + Math.sin(angle) * orbit;
    list.forEach((node, index) => {
      if (list.length === 1) {
        positions.set(node.id, { x: groupX, y: groupY });
        return;
      }
      const radius = Math.min(96, 10 + Math.sqrt(index) * 18);
      const theta = index * GOLDEN_ANGLE;
      positions.set(node.id, {
        x: clamp(groupX + Math.cos(theta) * radius, 30, width - 30),
        y: clamp(groupY + Math.sin(theta) * radius, 30, height - 30),
      });
    });
  });
  return positions;
}

/**
 * 力导向布局：斥力 k²/d、边弹簧、向心引力与初始锚点；温度线性衰减。
 * 迭代次数按节点数自适应，坐标保留 1 位小数；返回新图，不改入参。
 */
export function layoutNetwork(
  graph: NetworkGraph,
  options: NetworkLayoutOptions = {},
): NetworkGraph {
  const width = options.width ?? NETWORK_WIDTH;
  const height = options.height ?? NETWORK_HEIGHT;
  const padding = options.padding ?? NETWORK_PADDING;
  const count = graph.nodes.length;
  if (count === 0) return graph;

  const iterations =
    options.iterations ?? (count <= 150 ? 160 : count <= 300 ? 110 : 70);
  const initial = initialPositions(graph.nodes, width, height);
  const indexOf = new Map<string, number>();
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const anchorX = new Float64Array(count);
  const anchorY = new Float64Array(count);
  graph.nodes.forEach((node, index) => {
    indexOf.set(node.id, index);
    const point = initial.get(node.id) ?? { x: width / 2, y: height / 2 };
    xs[index] = point.x;
    ys[index] = point.y;
    anchorX[index] = point.x;
    anchorY[index] = point.y;
  });

  const dx = new Float64Array(count);
  const dy = new Float64Array(count);
  const area = width * height;
  const k = Math.sqrt(area / count) * 0.55;
  const minX = padding;
  const maxX = width - padding;
  const minY = padding;
  const maxY = height - padding;
  const centerX = width / 2;
  const centerY = height / 2;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    dx.fill(0);
    dy.fill(0);

    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        let deltaX = (xs[i] ?? 0) - (xs[j] ?? 0);
        let deltaY = (ys[i] ?? 0) - (ys[j] ?? 0);
        let distanceSquared = deltaX * deltaX + deltaY * deltaY;
        if (distanceSquared < 1) {
          // 完全重合时用下标做确定性抖动，避免 NaN。
          deltaX = ((i * 37 + j * 17) % 11) - 5;
          deltaY = ((i * 53 + j * 29) % 11) - 5;
          distanceSquared = deltaX * deltaX + deltaY * deltaY;
          if (distanceSquared < 1) {
            deltaX = 1;
            deltaY = 0;
            distanceSquared = 1;
          }
        }
        const distance = Math.sqrt(distanceSquared);
        const force = (k * k) / distance;
        const unitX = deltaX / distance;
        const unitY = deltaY / distance;
        dx[i] = (dx[i] ?? 0) + unitX * force;
        dy[i] = (dy[i] ?? 0) + unitY * force;
        dx[j] = (dx[j] ?? 0) - unitX * force;
        dy[j] = (dy[j] ?? 0) - unitY * force;
      }
    }

    for (const edge of graph.edges) {
      const source = indexOf.get(edge.source);
      const target = indexOf.get(edge.target);
      if (source === undefined || target === undefined || source === target) continue;
      let deltaX = (xs[source] ?? 0) - (xs[target] ?? 0);
      let deltaY = (ys[source] ?? 0) - (ys[target] ?? 0);
      const distance = Math.max(1, Math.hypot(deltaX, deltaY));
      deltaX /= distance;
      deltaY /= distance;
      const strength = 0.6 + Math.min(3, edge.weight) * 0.2;
      const force = (distance * distance * strength) / k;
      dx[source] = (dx[source] ?? 0) - deltaX * force;
      dy[source] = (dy[source] ?? 0) - deltaY * force;
      dx[target] = (dx[target] ?? 0) + deltaX * force;
      dy[target] = (dy[target] ?? 0) + deltaY * force;
    }

    const alpha = Math.max(0.04, 1 - iteration / iterations);
    const temperature = Math.max(1.5, (Math.min(width, height) / 9) * (1 - iteration / iterations));

    for (let i = 0; i < count; i += 1) {
      dx[i] =
        (dx[i] ?? 0) +
        (centerX - (xs[i] ?? 0)) * 0.02 +
        ((anchorX[i] ?? 0) - (xs[i] ?? 0)) * 0.03;
      dy[i] =
        (dy[i] ?? 0) +
        (centerY - (ys[i] ?? 0)) * 0.02 +
        ((anchorY[i] ?? 0) - (ys[i] ?? 0)) * 0.03;

      const length = Math.hypot(dx[i] ?? 0, dy[i] ?? 0);
      if (length === 0) continue;
      const step = Math.min(length * 0.12 * alpha, temperature);
      xs[i] = clamp((xs[i] ?? 0) + ((dx[i] ?? 0) / length) * step, minX, maxX);
      ys[i] = clamp((ys[i] ?? 0) + ((dy[i] ?? 0) / length) * step, minY, maxY);
    }
  }

  // 边界夹取会把节点挤到画布边缘；补几轮碰撞松弛，减少重叠与堆叠。
  // 节点越多半径越小，否则 500 个节点在固定画布内无法完全铺开。
  const maxWeight = graph.nodes.reduce((max, node) => Math.max(max, node.weight), 0);
  const radii = graph.nodes.map((node) => networkNodeRadius(node, maxWeight));
  const gapScale = count > 300 ? 0.55 : count > 150 ? 0.75 : 1;
  for (let pass = 0; pass < 60; pass += 1) {
    let moved = false;
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        let deltaX = (xs[i] ?? 0) - (xs[j] ?? 0);
        let deltaY = (ys[i] ?? 0) - (ys[j] ?? 0);
        const gap = ((radii[i] ?? 5) + (radii[j] ?? 5)) * gapScale + 3;
        let distance = Math.hypot(deltaX, deltaY);
        if (distance >= gap) continue;
        if (distance < 0.01) {
          deltaX = ((i * 31 + j * 17) % 7) - 3;
          deltaY = ((i * 13 + j * 29) % 7) - 3;
          if (deltaX === 0 && deltaY === 0) deltaX = 1;
          distance = Math.hypot(deltaX, deltaY);
        }
        const push = (gap - distance) / 2;
        const unitX = deltaX / distance;
        const unitY = deltaY / distance;
        xs[i] = clamp((xs[i] ?? 0) + unitX * push, minX, maxX);
        ys[i] = clamp((ys[i] ?? 0) + unitY * push, minY, maxY);
        xs[j] = clamp((xs[j] ?? 0) - unitX * push, minX, maxX);
        ys[j] = clamp((ys[j] ?? 0) - unitY * push, minY, maxY);
        moved = true;
      }
    }
    if (!moved) break;
  }

  const laidOut = graph.nodes.map((node, index) => ({
    ...node,
    x: Math.round((xs[index] ?? 0) * 10) / 10,
    y: Math.round((ys[index] ?? 0) * 10) / 10,
  }));
  return { ...graph, nodes: Object.freeze(laidOut) };
}

/** 渲染半径：字数 + 连接数的平方根映射，避免超大节点吞掉整张图。 */
export function networkNodeRadius(node: NetworkNode, maxWeight: number): number {
  const weightRatio = maxWeight <= 0 ? 0 : Math.sqrt(Math.max(0, node.weight) / maxWeight);
  const degreeBonus = Math.min(6, Math.sqrt(Math.max(0, node.degree)) * 2);
  return Math.round((5 + weightRatio * 9 + degreeBonus) * 10) / 10;
}

export interface NetworkLabelOptions {
  readonly limit?: number;
  /** 选中节点的标签永远显示，即使超出上限。 */
  readonly selectedId?: string | null;
  /** 筛选/高亮后仍可见的节点，标签优先级高于其它节点。 */
  readonly visibleIds?: ReadonlySet<string> | null;
}

interface LabelRect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

const LABEL_HEIGHT = 12;
const LABEL_GAP = 2;

/** 10px 字号下的粗略文本宽度：CJK 按全角、其余按半角估算。 */
function estimateLabelWidth(label: string): number {
  let width = 0;
  for (const char of label) {
    const code = char.codePointAt(0) ?? 0;
    width += code > 0x2e7f && code < 0xa000 ? 10 : 5.6;
  }
  return width;
}

function labelRect(node: NetworkNode, radius: number): LabelRect {
  const half = estimateLabelWidth(node.label) / 2;
  const bottom = node.y - radius - 4;
  return { left: node.x - half, right: node.x + half, top: bottom - LABEL_HEIGHT, bottom };
}

function rectsOverlap(a: LabelRect, b: LabelRect): boolean {
  return (
    a.left < b.right + LABEL_GAP &&
    a.right + LABEL_GAP > b.left &&
    a.top < b.bottom + LABEL_GAP &&
    a.bottom + LABEL_GAP > b.top
  );
}

/**
 * 标签避让：按「选中 → 可见 → 度数 → 权重 → 路径」排序后贪心放置，
 * 与已放置标签矩形重叠的候选直接跳过。返回应显示标签的节点 id 集合。
 */
export function selectNetworkLabels(
  nodes: readonly NetworkNode[],
  options: NetworkLabelOptions = {},
): ReadonlySet<string> {
  const limit = Math.max(0, options.limit ?? NETWORK_LABEL_LIMIT);
  const selectedId = options.selectedId ?? null;
  const visibleIds = options.visibleIds ?? null;
  const maxWeight = nodes.reduce((max, node) => Math.max(max, node.weight), 0);

  const rank = (node: NetworkNode): number => {
    if (node.id === selectedId) return 0;
    if (visibleIds === null) return 1;
    return visibleIds.has(node.id) ? 1 : 2;
  };
  const ranked = [...nodes].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    if (a.degree !== b.degree) return b.degree - a.degree;
    if (a.weight !== b.weight) return b.weight - a.weight;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const accepted: LabelRect[] = [];
  const ids = new Set<string>();
  for (const node of ranked) {
    if (ids.size >= limit && node.id !== selectedId) break;
    const rect = labelRect(node, networkNodeRadius(node, maxWeight));
    if (accepted.some((other) => rectsOverlap(rect, other))) continue;
    accepted.push(rect);
    ids.add(node.id);
  }
  return ids;
}

export interface DimensionDistributionRow {
  readonly id: BoardDimensionId;
  readonly count: number;
  /** 近 30 天修改过的该维度文档数。 */
  readonly active: number;
}

export interface TagDistributionRow {
  readonly tag: string;
  readonly count: number;
}

export interface OrphanDocRow {
  readonly path: string;
  readonly title: string;
}

export interface BrokenLinkRow {
  readonly from: string;
  readonly to: string;
  readonly fromTitle: string;
}

export interface BoardDistribution {
  readonly dimensions: readonly DimensionDistributionRow[];
  readonly tags: readonly TagDistributionRow[];
  readonly isolated: readonly OrphanDocRow[];
  readonly brokenLinks: readonly BrokenLinkRow[];
  /** 范围内没有任何维度标注的文档数。 */
  readonly unclassified: number;
  /** 范围内不同标签总数（截断前）。 */
  readonly totalTags: number;
  /** 孤立文档总数（不受 issueLimit 截断）。 */
  readonly isolatedTotal: number;
  /** 断链总数（不受 issueLimit 截断）。 */
  readonly brokenLinksTotal: number;
}

export interface DistributionOptions {
  readonly now?: number;
  /** 全库路径集合；断链 = to 不在该集合。缺省时用范围内文档。 */
  readonly allPaths?: ReadonlySet<string>;
  readonly tagLimit?: number;
  readonly issueLimit?: number;
}

export function buildDistribution(
  docs: readonly BoardDocStat[],
  classification: ReadonlyMap<string, readonly BoardDimensionId[]>,
  links: readonly BoardLink[],
  options: DistributionOptions = {},
): BoardDistribution {
  const now = options.now ?? Date.now();
  const tagLimit = options.tagLimit ?? NETWORK_TAG_LIMIT;
  const issueLimit = options.issueLimit ?? NETWORK_ISSUE_LIMIT;
  const paths = new Set(docs.map((doc) => doc.path));
  const allPaths = options.allPaths ?? paths;
  const byPath = new Map(docs.map((doc) => [doc.path, doc] as const));
  const pairs = collectPairs(links, paths);
  const degrees = degreeOf([...paths], pairs);

  const counts = new Map<BoardDimensionId, number>();
  const actives = new Map<BoardDimensionId, number>();
  for (const id of DIMENSION_IDS) {
    counts.set(id, 0);
    actives.set(id, 0);
  }
  const cutoff = now - ACTIVE_DAYS * DAY_MS;
  let unclassified = 0;
  const tagCounts = new Map<string, number>();
  for (const doc of docs) {
    const dims = normalizeDimensions(classification.get(doc.path) ?? []);
    if (dims.length === 0) unclassified += 1;
    const isActive = doc.modifiedMs >= cutoff;
    for (const id of dims) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
      if (isActive) actives.set(id, (actives.get(id) ?? 0) + 1);
    }
    for (const tag of doc.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const dimensions: DimensionDistributionRow[] = DIMENSION_IDS.map((id) => ({
    id,
    count: counts.get(id) ?? 0,
    active: actives.get(id) ?? 0,
  }));

  const tags: TagDistributionRow[] = [...tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => (b.count === a.count ? (a.tag < b.tag ? -1 : 1) : b.count - a.count))
    .slice(0, tagLimit);

  const isolatedAll: OrphanDocRow[] = docs
    .filter((doc) => (degrees.get(doc.path) ?? 0) === 0)
    .map((doc) => ({ path: doc.path, title: doc.title }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const isolated = isolatedAll.slice(0, issueLimit);

  const brokenSeen = new Set<string>();
  const brokenLinks: BrokenLinkRow[] = [];
  let brokenLinksTotal = 0;
  for (const link of links) {
    if (link.from === '' || link.to === '') continue;
    if (!byPath.has(link.from)) continue;
    if (allPaths.has(link.to)) continue;
    const key = `${link.from}\u0000${link.to}`;
    if (brokenSeen.has(key)) continue;
    brokenSeen.add(key);
    brokenLinksTotal += 1;
    if (brokenLinks.length >= issueLimit) continue;
    brokenLinks.push({
      from: link.from,
      to: link.to,
      fromTitle: byPath.get(link.from)?.title ?? link.from,
    });
  }

  return Object.freeze({
    dimensions: Object.freeze(dimensions),
    tags: Object.freeze(tags),
    isolated: Object.freeze(isolated),
    brokenLinks: Object.freeze(brokenLinks),
    unclassified,
    totalTags: tagCounts.size,
    isolatedTotal: isolatedAll.length,
    brokenLinksTotal,
  });
}

export type TimelineKind = 'created' | 'modified';

export interface TimelineEvent {
  readonly key: string;
  readonly kind: TimelineKind;
  readonly ms: number;
  readonly date: string;
  readonly path: string;
  readonly title: string;
  readonly dimensionId: BoardDimensionId | null;
}

export interface TimelineOptions {
  readonly limit?: number;
}

/** 时间线：每篇一条「修改」；有 created 时再加一条「新建」。倒序，不伪造创建时间。 */
export function buildTimeline(
  docs: readonly BoardDocStat[],
  classification: ReadonlyMap<string, readonly BoardDimensionId[]>,
  options: TimelineOptions = {},
): readonly TimelineEvent[] {
  const limit = options.limit ?? TIMELINE_LIMIT;
  const events: TimelineEvent[] = [];
  for (const doc of docs) {
    const dimensionId = primaryDimension(classification.get(doc.path));
    events.push({
      key: `${doc.path}\u0000modified`,
      kind: 'modified',
      ms: doc.modifiedMs,
      date: localDateKey(doc.modifiedMs),
      path: doc.path,
      title: doc.title,
      dimensionId,
    });
    if (doc.createdMs !== null) {
      events.push({
        key: `${doc.path}\u0000created`,
        kind: 'created',
        ms: doc.createdMs,
        date: localDateKey(doc.createdMs),
        path: doc.path,
        title: doc.title,
        dimensionId,
      });
    }
  }
  events.sort((a, b) => {
    if (a.ms !== b.ms) return b.ms - a.ms;
    if (a.kind !== b.kind) return a.kind === 'created' ? -1 : 1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return Object.freeze(events.slice(0, limit));
}
