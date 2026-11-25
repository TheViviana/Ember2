/**
 * CR-20261123-69 / S1：看板数据层纯函数。
 *
 * 输入全部由调用方提供（索引元数据 + 正文 + 分类覆盖层 + 连线），本模块不 invoke、
 * 不读 localStorage、不摸定时器；统计口径见 docs/board-ai-plan-v2.md §2.2：
 * - 日期一律按本地时区分桶（禁止 UTC 截断）；
 * - 覆盖度 / 连接密度取相对值，天然避免除零；
 * - 综合得分 = 0.45×覆盖 + 0.30×密度 + 0.25×活跃；
 * - 均衡度需至少 4 个「有文档」的维度，否则返回 null（UI 显示数据不足）。
 */
import { parseFrontmatter } from '../../core/markdown.ts';

export type BoardDimensionId =
  | 'factual'
  | 'conceptual'
  | 'procedural'
  | 'metacognitive'
  | 'explicit'
  | 'tacit'
  | 'interpersonal'
  | 'value';

export type BoardDimensionGroup = 'cognitive' | 'representation' | 'function';

export interface BoardDimension {
  readonly id: BoardDimensionId;
  readonly label: string;
  readonly shortLabel: string;
  readonly group: BoardDimensionGroup;
  readonly color: string;
}

/** 轴顺序固定：事实 → 概念 → 程序 → 元认知 → 显性 → 隐性 → 人际 → 价值。 */
export const BOARD_DIMENSIONS: readonly BoardDimension[] = Object.freeze([
  { id: 'factual', label: '事实性知识', shortLabel: '事实', group: 'cognitive', color: 'var(--board-dim-factual)' },
  { id: 'conceptual', label: '概念性知识', shortLabel: '概念', group: 'cognitive', color: 'var(--board-dim-conceptual)' },
  { id: 'procedural', label: '程序性知识', shortLabel: '程序', group: 'cognitive', color: 'var(--board-dim-procedural)' },
  {
    id: 'metacognitive',
    label: '元认知知识',
    shortLabel: '元认知',
    group: 'cognitive',
    color: 'var(--board-dim-metacognitive)',
  },
  { id: 'explicit', label: '显性知识', shortLabel: '显性', group: 'representation', color: 'var(--board-dim-explicit)' },
  { id: 'tacit', label: '隐性知识', shortLabel: '隐性', group: 'representation', color: 'var(--board-dim-tacit)' },
  { id: 'interpersonal', label: '人际性知识', shortLabel: '人际', group: 'function', color: 'var(--board-dim-interpersonal)' },
  { id: 'value', label: '价值性知识', shortLabel: '价值', group: 'function', color: 'var(--board-dim-value)' },
]);

export const BOARD_DIMENSION_IDS: readonly BoardDimensionId[] = Object.freeze(
  BOARD_DIMENSIONS.map((dimension) => dimension.id),
);

const DIMENSION_ID_SET: ReadonlySet<string> = new Set(BOARD_DIMENSION_IDS);

export function isBoardDimensionId(value: unknown): value is BoardDimensionId {
  return typeof value === 'string' && DIMENSION_ID_SET.has(value);
}

/** 去重并过滤非法维度；顺序永远按 BOARD_DIMENSIONS 固定顺序。 */
export function normalizeDimensions(values: readonly unknown[]): readonly BoardDimensionId[] {
  const wanted = new Set<BoardDimensionId>();
  for (const value of values) {
    if (isBoardDimensionId(value)) wanted.add(value);
  }
  return BOARD_DIMENSIONS.filter((dimension) => wanted.has(dimension.id)).map(
    (dimension) => dimension.id,
  );
}

/** 单篇正文统计上限：超过则跳过字数/标签，只计入总数（v2 §2.1 规则 2）。 */
export const MAX_STAT_BYTES = 1024 * 1024;

export const DAY_MS = 24 * 60 * 60 * 1000;

export const BOARD_TREND_DAYS = 30;
export const BOARD_HEATMAP_DAYS = 26 * 7;
const ACTIVITY_DAYS = 30;
const COVERED_SCORE_THRESHOLD = 20;

export interface BoardDocSource {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly modifiedMs: number;
  readonly text: string;
}

export interface BoardDocStat {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly modifiedMs: number;
  readonly title: string;
  readonly tags: readonly string[];
  /** 去空白后的正文字符数；跳过大文件时为 0。 */
  readonly wordCount: number;
  /** true = 超过 MAX_STAT_BYTES，未解析正文。 */
  readonly skipped: boolean;
  /** frontmatter created 的本地时间戳；缺失或非法为 null。 */
  readonly createdMs: number | null;
}

const MARKDOWN_EXT_RE = /\.md$/i;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function stripMarkdownExtension(path: string): string {
  return path.replace(MARKDOWN_EXT_RE, '');
}

/** 文件名回退标题：取最后一段并去扩展名；空路径返回空串。 */
export function titleFromPath(path: string): string {
  const segments = path.split('/');
  const base = segments[segments.length - 1] ?? '';
  return stripMarkdownExtension(base);
}

/**
 * 解析 frontmatter 中的时间：
 * - 纯日期（YYYY-MM-DD）按**本地**零点，避免 `Date.parse` 的 UTC 截断；
 * - 其余交给 Date.parse（需自带时区偏移才能跨时区稳定）。
 */
export function parseLocalTimeMs(raw: string | undefined | null): number | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value === '') return null;
  const dateOnly = DATE_ONLY_RE.exec(value);
  if (dateOnly !== null) {
    const ms = new Date(
      Number(dateOnly[1]),
      Number(dateOnly[2]) - 1,
      Number(dateOnly[3]),
    ).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** 正文去空白字符数（CJK 按字；拉丁按字符，不额外分词）。 */
export function countWords(body: string): number {
  return body.replace(/\s+/g, '').length;
}

export function parseDocStat(source: BoardDocSource): BoardDocStat {
  const base = {
    path: source.path,
    sha256: source.sha256,
    bytes: source.bytes,
    modifiedMs: source.modifiedMs,
  } as const;

  if (source.bytes > MAX_STAT_BYTES) {
    return Object.freeze({
      ...base,
      title: titleFromPath(source.path),
      tags: Object.freeze([]),
      wordCount: 0,
      skipped: true,
      createdMs: null,
    });
  }

  const parsed = parseFrontmatter(source.text);
  const frontmatter = parsed.frontmatter;
  const rawTitle = frontmatter?.title?.trim() ?? '';
  const tags: string[] = [];
  for (const tag of frontmatter?.tags ?? []) {
    const trimmed = tag.trim();
    if (trimmed !== '' && !tags.includes(trimmed)) tags.push(trimmed);
  }

  return Object.freeze({
    ...base,
    title: rawTitle === '' ? titleFromPath(source.path) : rawTitle,
    tags: Object.freeze(tags),
    wordCount: countWords(parsed.body),
    skipped: false,
    createdMs: parseLocalTimeMs(frontmatter?.created),
  });
}

export interface BoardLink {
  readonly from: string;
  readonly to: string;
}

export interface BoardTotals {
  readonly docs: number;
  readonly words: number;
  readonly links: number;
  readonly isolated: number;
  /** 没有任何维度标注的文档数。 */
  readonly unclassified: number;
  /** 因超过 1 MiB 被跳过正文统计的文档数。 */
  readonly skipped: number;
}

export interface BoardTrendPoint {
  readonly date: string;
  readonly count: number;
}

export type BoardHeatmapDay = BoardTrendPoint;

export interface BoardTrendSeries {
  /** 配置窗口（默认 30 天）的「最后修改」分布，按本地日期连续分桶。 */
  readonly modified: readonly BoardTrendPoint[];
  /** 同窗口的「新增」分布；库内无任何可用 createdMs 时为 null。 */
  readonly created: readonly BoardTrendPoint[] | null;
}

export interface BoardDimensionMetric {
  readonly id: BoardDimensionId;
  /** 标注了该维度的文档数。 */
  readonly docs: number;
  /** 相对覆盖度 0–100（该维度节点数 / 最大维度节点数）。 */
  readonly coverage: number;
  /** 相对连接密度 0–100（该维度平均 degree / 全库最大平均 degree）。 */
  readonly density: number;
  /** 活跃度 0–100（近 30 天修改的该维度文档占比）。 */
  readonly activity: number;
  /** 综合得分 0–100。 */
  readonly score: number;
}

export interface BoardMetrics {
  readonly totals: BoardTotals;
  readonly trend: BoardTrendSeries;
  readonly heatmap: readonly BoardHeatmapDay[];
  /** 全部 8 维，顺序固定；无数据维度各项为 0。 */
  readonly dimensions: readonly BoardDimensionMetric[];
  /** 均衡度 0–100；不足 4 个非零维度时为 null。 */
  readonly balance: number | null;
  /** 综合得分 ≥20 的维度数。 */
  readonly coveredDimensions: number;
  /** 近 30 天修改的文档占比 0–100。 */
  readonly active30: number;
  readonly generatedAt: number;
}

export interface BoardMetricsOptions {
  readonly now?: number;
  readonly links?: readonly BoardLink[];
  /** T0 索引里的文档总数；未全量读取时用它给出准确分母。 */
  readonly totalDocs?: number;
  /** 趋势窗口天数（看板全局范围联动）；默认 30。 */
  readonly trendDays?: number;
  /** 热力图窗口天数（看板全局范围联动）；默认 182。 */
  readonly heatmapDays?: number;
}

/** 本地日期键（YYYY-MM-DD）；跨时区按调用方机器时区分桶。 */
export function localDateKey(ms: number): string {
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localStartOfDay(ms: number): Date {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

interface DayWindow {
  readonly keys: readonly string[];
  readonly index: ReadonlyMap<string, number>;
}

function buildDayWindow(now: number, days: number): DayWindow {
  const today = localStartOfDay(now);
  const keys: string[] = [];
  const index = new Map<string, number>();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    const key = localDateKey(date.getTime());
    index.set(key, keys.length);
    keys.push(key);
  }
  return { keys, index };
}

function bucketDays(
  docs: readonly BoardDocStat[],
  window: DayWindow,
  pick: (doc: BoardDocStat) => number | null,
): readonly BoardTrendPoint[] {
  const counts = new Array<number>(window.keys.length).fill(0);
  for (const doc of docs) {
    const ms = pick(doc);
    if (ms === null) continue;
    const slot = window.index.get(localDateKey(ms));
    if (slot === undefined) continue;
    counts[slot] = (counts[slot] ?? 0) + 1;
  }
  return Object.freeze(
    window.keys.map((date, slot) => Object.freeze({ date, count: counts[slot] ?? 0 })),
  );
}

/** 去重无向文档对：自环与重复边忽略，返回 [a,b] 且 a < b（字典序）。 */
function uniqueDocPairs(links: readonly BoardLink[]): readonly (readonly [string, string])[] {
  const seen = new Set<string>();
  const pairs: Array<readonly [string, string]> = [];
  for (const link of links) {
    const from = link.from;
    const to = link.to;
    if (from === to || from === '' || to === '') continue;
    const [a, b] = from < to ? [from, to] : [to, from];
    const key = `${a}\u0000${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push([a, b]);
  }
  return pairs;
}

function degreeMap(docs: readonly BoardDocStat[], links: readonly BoardLink[]): Map<string, number> {
  const degrees = new Map<string, number>();
  for (const doc of docs) degrees.set(doc.path, 0);
  for (const [a, b] of uniqueDocPairs(links)) {
    if (degrees.has(a)) degrees.set(a, (degrees.get(a) ?? 0) + 1);
    if (degrees.has(b)) degrees.set(b, (degrees.get(b) ?? 0) + 1);
  }
  return degrees;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function buildBoardMetrics(
  docs: readonly BoardDocStat[],
  classification: ReadonlyMap<string, readonly BoardDimensionId[]>,
  options: BoardMetricsOptions = {},
): BoardMetrics {
  const now = options.now ?? Date.now();
  const links = options.links ?? [];
  const degrees = degreeMap(docs, links);

  const dimensionDocs = new Map<BoardDimensionId, BoardDocStat[]>();
  for (const id of BOARD_DIMENSION_IDS) dimensionDocs.set(id, []);

  let unclassified = 0;
  for (const doc of docs) {
    const dims = normalizeDimensions([...(classification.get(doc.path) ?? [])]);
    if (dims.length === 0) unclassified += 1;
    for (const dim of dims) dimensionDocs.get(dim)?.push(doc);
  }

  let maxCount = 0;
  for (const list of dimensionDocs.values()) maxCount = Math.max(maxCount, list.length);

  const averageDegrees = new Map<BoardDimensionId, number>();
  for (const [id, list] of dimensionDocs) {
    if (list.length === 0) {
      averageDegrees.set(id, 0);
      continue;
    }
    let sum = 0;
    for (const doc of list) sum += degrees.get(doc.path) ?? 0;
    averageDegrees.set(id, sum / list.length);
  }
  let maxAverageDegree = 0;
  for (const value of averageDegrees.values()) maxAverageDegree = Math.max(maxAverageDegree, value);

  const activityCutoff = now - ACTIVITY_DAYS * DAY_MS;

  const dimensions: BoardDimensionMetric[] = BOARD_DIMENSIONS.map((dimension) => {
    const list = dimensionDocs.get(dimension.id) ?? [];
    const docsCount = list.length;
    const coverage = maxCount === 0 ? 0 : (docsCount / maxCount) * 100;
    const averageDegree = averageDegrees.get(dimension.id) ?? 0;
    const density = maxAverageDegree === 0 ? 0 : (averageDegree / maxAverageDegree) * 100;
    const activeCount = list.filter((doc) => doc.modifiedMs >= activityCutoff).length;
    const activity = docsCount === 0 ? 0 : (activeCount / docsCount) * 100;
    return {
      id: dimension.id,
      docs: docsCount,
      coverage: clampPercent(coverage),
      density: clampPercent(density),
      activity: clampPercent(activity),
      score: Math.round(clampPercent(0.45 * coverage + 0.3 * density + 0.25 * activity)),
    };
  });

  const nonZero = dimensions.filter((dimension) => dimension.docs > 0);
  let balance: number | null = null;
  if (nonZero.length >= 4) {
    // 只在「有文档的维度」之间衡量均衡：未使用的维度属于覆盖问题，由覆盖度承担。
    const scores = nonZero.map((dimension) => dimension.score);
    const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    if (mean === 0) {
      balance = 0;
    } else {
      const variance =
        scores.reduce((sum, score) => sum + (score - mean) * (score - mean), 0) / scores.length;
      const coefficient = Math.sqrt(variance) / mean;
      balance = Math.round(clampPercent(100 - coefficient * 100));
    }
  }

  const totalDocs = options.totalDocs ?? docs.length;
  const activityWindow = docs.filter((doc) => doc.modifiedMs >= activityCutoff).length;

  const trendDays = Math.max(1, Math.floor(options.trendDays ?? BOARD_TREND_DAYS));
  const heatmapDays = Math.max(1, Math.floor(options.heatmapDays ?? BOARD_HEATMAP_DAYS));
  const trendWindow = buildDayWindow(now, trendDays);
  const heatmapWindow = buildDayWindow(now, heatmapDays);
  const hasCreated = docs.some((doc) => doc.createdMs !== null);

  return Object.freeze({
    totals: Object.freeze({
      docs: totalDocs,
      words: docs.reduce((sum, doc) => sum + doc.wordCount, 0),
      links: uniqueDocPairs(links).length,
      isolated: docs.filter((doc) => (degrees.get(doc.path) ?? 0) === 0).length,
      unclassified,
      skipped: docs.filter((doc) => doc.skipped).length,
    }),
    trend: Object.freeze({
      modified: bucketDays(docs, trendWindow, (doc) => doc.modifiedMs),
      created: hasCreated ? bucketDays(docs, trendWindow, (doc) => doc.createdMs) : null,
    }),
    heatmap: bucketDays(docs, heatmapWindow, (doc) => doc.modifiedMs),
    dimensions: Object.freeze(dimensions),
    balance,
    coveredDimensions: dimensions.filter((dimension) => dimension.score >= COVERED_SCORE_THRESHOLD)
      .length,
    active30: docs.length === 0 ? 0 : (activityWindow / docs.length) * 100,
    generatedAt: now,
  });
}
