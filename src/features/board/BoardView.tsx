/**
 * CR-20261123-69 / S3：八维雷达、分类面板、标签映射与快照环比。
 *
 * 数据来源分两级：
 * - T0 索引（docs/bytes/modifiedMs/sha256）→ KPI、趋势；
 * - T1 后台正文（并发 4、可取消、localStorage 缓存）→ 标签，用于规则预填。
 * 分类是旁路覆盖层，不写 frontmatter；显式标注永远优先于标签规则。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  BOARD_DIMENSIONS,
  buildBoardMetrics,
  localDateKey,
  titleFromPath,
  type BoardDimensionId,
  type BoardDocStat,
  type BoardLink,
  type BoardMetrics,
} from './model.ts';
import {
  NETWORK_HEIGHT,
  NETWORK_LABEL_LIMIT,
  NETWORK_TAG_LIMIT,
  NETWORK_WIDTH,
  TIMELINE_LIMIT,
  buildDistribution,
  buildNetworkGraph,
  buildTimeline,
  isNetworkGroupId,
  layoutNetwork,
  networkNodeRadius,
  selectNetworkLabels,
  type NetworkGraph,
} from './network.ts';
import {
  classificationNeedsReview,
  loadClassifications,
  saveClassifications,
  setBoardClassification,
  toDimensionLookup,
  type BoardClassifyMap,
} from './classify-store.ts';
import {
  addDimensionRule,
  loadDimensionRules,
  matchDimensionRules,
  removeDimensionRule,
  saveDimensionRules,
  type BoardDimensionRule,
} from './rules-store.ts';
import {
  averageScore,
  createBoardSnapshot,
  loadSnapshots,
  previousSnapshot,
  recordSnapshot,
  type BoardSnapshot,
} from './snapshot-store.ts';
import { buildBoardStats, type StatsStorage } from './stats-store.ts';
import { buildHeatmapMonthLabels, buildHeatmapWeeks } from './calendar.ts';
import { formatBytes } from '../media/media-format.ts';
import styles from './BoardView.module.css';

export interface BoardDocT0 {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly modifiedMs: number;
}

export interface BoardViewProps {
  readonly docs: readonly BoardDocT0[];
  readonly vaultId: string | null;
  readonly links: readonly BoardLink[];
  readonly readDoc: (path: string) => Promise<{ readonly sha256: string; readonly text: string }>;
  readonly onBackToCanvas: () => void;
  /** S4：把文档定位到画布中的文档节点。 */
  readonly onRevealDoc?: (docPath: string) => void;
}

const TREND_DAYS = 30;
const DAY_MS_RENDER = 24 * 60 * 60 * 1000;
const LIST_LIMIT = 200;
/** 热力图列宽：10px 格子 + 2px 间距，月份轴按此计算偏移。 */
const HEATMAP_COLUMN = 12;
const HEATMAP_WEEKDAYS = ['一', '', '三', '', '五', '', ''] as const;

const DIMENSION_BY_ID = new Map(BOARD_DIMENSIONS.map((dimension) => [dimension.id, dimension]));

interface BoardStorage extends StatsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const memoryFallback = new Map<string, string>();
const fallbackStorage: BoardStorage = {
  getItem: (key) => memoryFallback.get(key) ?? null,
  setItem: (key, value) => {
    memoryFallback.set(key, value);
  },
};

function boardStorage(): BoardStorage {
  try {
    return window.localStorage;
  } catch {
    return fallbackStorage;
  }
}

type T1Status = 'idle' | 'loading' | 'done' | 'error';

interface T1State {
  readonly status: T1Status;
  readonly done: number;
  readonly total: number;
  readonly skipped: number;
}

interface TrendPoint {
  readonly date: string;
  readonly count: number;
}

function buildModifiedTrend(
  docs: readonly BoardDocT0[],
  now: number,
  days: number,
): readonly TrendPoint[] {
  const counts = new Map<string, number>();
  for (const doc of docs) {
    const key = localDateKey(doc.modifiedMs);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const today = new Date(now);
  const points: TrendPoint[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    const key = localDateKey(date.getTime());
    points.push({ date: key, count: counts.get(key) ?? 0 });
  }
  return points;
}

function dateLabel(date: string): string {
  return date.slice(5);
}

function round(value: number): number {
  return Math.round(value);
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value}`;
}

/** S4：热力图 5 档深浅；0 篇保持底色。 */
function heatLevelClass(count: number, max: number): string {
  if (count <= 0 || max <= 0) return styles.heatCellLevel0 ?? '';
  const ratio = count / max;
  if (ratio <= 0.25) return styles.heatCellLevel1 ?? '';
  if (ratio <= 0.5) return styles.heatCellLevel2 ?? '';
  if (ratio <= 0.75) return styles.heatCellLevel3 ?? '';
  return styles.heatCellLevel4 ?? '';
}

function TrendChart({ points }: { readonly points: readonly TrendPoint[] }) {
  const width = 600;
  const height = 150;
  const pad = 8;
  const max = Math.max(1, ...points.map((point) => point.count));
  const step = points.length <= 1 ? 0 : (width - pad * 2) / (points.length - 1);
  const coords = points.map((point, index) => {
    const x = pad + step * index;
    const y = height - pad - (point.count / max) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = coords.join(' ');
  const area = `M${pad},${height - pad} L${coords.join(' L')} L${width - pad},${height - pad} Z`;
  const gridLines = [0.25, 0.5, 0.75].map((ratio) => {
    const y = pad + (height - pad * 2) * ratio;
    return `0,${y.toFixed(1)} ${width},${y.toFixed(1)}`;
  });
  const first = points[0]?.date ?? '';
  const middle = points[Math.floor(points.length / 2)]?.date ?? '';
  const last = points[points.length - 1]?.date ?? '';

  return (
    <div className={styles.chartWrap}>
      <svg
        className={styles.chart}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`最近 ${TREND_DAYS} 天文档修改趋势，峰值 ${max} 次`}
      >
        {gridLines.map((grid) => (
          <polyline key={grid} className={styles.chartGrid} points={grid} />
        ))}
        <polygon className={styles.chartArea} points={area} />
        <polyline className={styles.chartLine} points={line} />
      </svg>
      <div className={styles.chartAxis} aria-hidden="true">
        <span>{dateLabel(first)}</span>
        <span>{dateLabel(middle)}</span>
        <span>{dateLabel(last)}</span>
      </div>
    </div>
  );
}

function RadarChart({ metrics }: { readonly metrics: BoardMetrics }) {
  const size = 260;
  const center = size / 2;
  const radius = 88;
  const byId = new Map(metrics.dimensions.map((dimension) => [dimension.id, dimension]));

  const rings = [25, 50, 75, 100].map((percent) => {
    const points = BOARD_DIMENSIONS.map((_, index) => {
      const angle = -Math.PI / 2 + (index * 2 * Math.PI) / BOARD_DIMENSIONS.length;
      const r = (radius * percent) / 100;
      return `${(center + Math.cos(angle) * r).toFixed(1)},${(center + Math.sin(angle) * r).toFixed(1)}`;
    });
    return points.join(' ');
  });

  const axes = BOARD_DIMENSIONS.map((dimension, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / BOARD_DIMENSIONS.length;
    return {
      id: dimension.id,
      x1: center,
      y1: center,
      x2: center + Math.cos(angle) * radius,
      y2: center + Math.sin(angle) * radius,
    };
  });

  const vertices = BOARD_DIMENSIONS.map((dimension, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / BOARD_DIMENSIONS.length;
    const coverage = byId.get(dimension.id)?.coverage ?? 0;
    const r = (radius * coverage) / 100;
    return {
      id: dimension.id,
      x: center + Math.cos(angle) * r,
      y: center + Math.sin(angle) * r,
    };
  });

  const labels = BOARD_DIMENSIONS.map((dimension, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / BOARD_DIMENSIONS.length;
    const x = center + Math.cos(angle) * (radius + 20);
    const y = center + Math.sin(angle) * (radius + 20);
    const anchor: 'start' | 'middle' | 'end' =
      Math.cos(angle) > 0.3 ? 'start' : Math.cos(angle) < -0.3 ? 'end' : 'middle';
    return { id: dimension.id, label: dimension.shortLabel, x, y, anchor, color: dimension.color };
  });

  return (
    <svg
      className={styles.radar}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="八维知识覆盖雷达图"
    >
      {rings.map((points) => (
        <polygon key={points} className={styles.radarRing} points={points} />
      ))}
      {axes.map((axis) => (
        <line
          key={axis.id}
          className={styles.radarAxisLine}
          x1={axis.x1}
          y1={axis.y1}
          x2={axis.x2}
          y2={axis.y2}
        />
      ))}
      <polygon
        className={styles.radarArea}
        points={vertices.map((vertex) => `${vertex.x.toFixed(1)},${vertex.y.toFixed(1)}`).join(' ')}
      />
      {vertices.map((vertex) => (
        <circle
          key={vertex.id}
          className={styles.radarVertex}
          cx={vertex.x}
          cy={vertex.y}
          r={2.6}
          fill={DIMENSION_BY_ID.get(vertex.id)?.color}
        />
      ))}
      {labels.map((label) => (
        <text
          key={label.id}
          className={styles.radarLabel}
          x={label.x}
          y={label.y}
          textAnchor={label.anchor}
          dominantBaseline="middle"
          fill={label.color}
        >
          {label.label}
        </text>
      ))}
    </svg>
  );
}

interface NetworkView {
  readonly scale: number;
  readonly tx: number;
  readonly ty: number;
}

const IDENTITY_NETWORK_VIEW: NetworkView = { scale: 1, tx: 0, ty: 0 };

function dimensionColor(dimensionId: BoardDimensionId | null): string {
  if (dimensionId === null) return 'var(--ember-text-muted)';
  return DIMENSION_BY_ID.get(dimensionId)?.color ?? 'var(--ember-text-muted)';
}

interface NetworkChartProps {
  readonly graph: NetworkGraph;
  readonly selectedId: string | null;
  /** 被图例筛掉的节点；只降透明度，不移除，保持布局稳定。 */
  readonly dimmedIds: ReadonlySet<string> | null;
  readonly onSelect: (nodeId: string) => void;
}

/** S5：零依赖 SVG 力导向网络图；滚轮缩放、拖拽平移、点击节点选中。 */
function NetworkChart({ graph, selectedId, dimmedIds, onSelect }: NetworkChartProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{
    readonly pointerId: number;
    readonly startX: number;
    readonly startY: number;
    readonly originX: number;
    readonly originY: number;
  } | null>(null);
  const [view, setView] = useState<NetworkView>(IDENTITY_NETWORK_VIEW);
  const [dragging, setDragging] = useState(false);

  // React 的 onWheel 是根节点上的被动监听，阻止不了页面滚动；这里用原生非被动监听。
  useEffect(() => {
    const element = svgRef.current;
    if (element === null) return;
    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const pointX = ((event.clientX - rect.left) / rect.width) * NETWORK_WIDTH;
      const pointY = ((event.clientY - rect.top) / rect.height) * NETWORK_HEIGHT;
      setView((current) => {
        const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
        const scale = Math.min(3, Math.max(0.6, current.scale * factor));
        if (scale === current.scale) return current;
        const ratio = scale / current.scale;
        return {
          scale,
          tx: pointX - (pointX - current.tx) * ratio,
          ty: pointY - (pointY - current.ty) * ratio,
        };
      });
    };
    element.addEventListener('wheel', handleWheel, { passive: false });
    return () => element.removeEventListener('wheel', handleWheel);
  }, []);

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>): void {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: view.tx,
      originY: view.ty,
    };
    setDragging(true);
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>): void {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const scaleX = NETWORK_WIDTH / rect.width;
    const scaleY = NETWORK_HEIGHT / rect.height;
    const offsetX = (event.clientX - drag.startX) * scaleX;
    const offsetY = (event.clientY - drag.startY) * scaleY;
    setView((current) => ({
      ...current,
      tx: drag.originX + offsetX,
      ty: drag.originY + offsetY,
    }));
  }

  function handlePointerEnd(event: ReactPointerEvent<SVGSVGElement>): void {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  }

  function handleNodeKeyDown(event: ReactKeyboardEvent<SVGGElement>, nodeId: string): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onSelect(nodeId);
  }

  const positions = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node] as const)),
    [graph.nodes],
  );
  const maxWeight = useMemo(
    () => Math.max(1, ...graph.nodes.map((node) => node.weight)),
    [graph.nodes],
  );
  const visibleIds = useMemo(() => {
    if (dimmedIds === null) return null;
    const visible = new Set<string>();
    for (const node of graph.nodes) {
      if (!dimmedIds.has(node.id)) visible.add(node.id);
    }
    return visible;
  }, [dimmedIds, graph.nodes]);
  const labelled = useMemo(
    () =>
      selectNetworkLabels(graph.nodes, {
        limit: NETWORK_LABEL_LIMIT,
        selectedId,
        visibleIds,
      }),
    [graph.nodes, selectedId, visibleIds],
  );

  return (
    <div className={styles.networkWrap}>
      <div className={styles.networkToolbar}>
        <span className={styles.networkHint}>滚轮缩放 · 拖拽平移 · 点击节点查看详情</span>
        <span className={styles.networkZoom} aria-live="polite">
          {Math.round(view.scale * 100)}%
        </span>
        <button
          type="button"
          className={styles.networkReset}
          onClick={() => setView(IDENTITY_NETWORK_VIEW)}
        >
          复位
        </button>
      </div>
      <svg
        ref={svgRef}
        className={`${styles.networkSvg} ${dragging ? styles.networkSvgDragging : ''}`}
        viewBox={`0 0 ${NETWORK_WIDTH} ${NETWORK_HEIGHT}`}
        role="img"
        aria-label={`知识网络图，${graph.nodes.length} 个节点，${graph.edges.length} 条连接`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      >
        <g transform={`translate(${view.tx.toFixed(1)} ${view.ty.toFixed(1)}) scale(${view.scale})`}>
          {graph.edges.map((edge) => {
            const source = positions.get(edge.source);
            const target = positions.get(edge.target);
            if (source === undefined || target === undefined) return null;
            const dimmed =
              dimmedIds !== null && (dimmedIds.has(edge.source) || dimmedIds.has(edge.target));
            return (
              <line
                key={`${edge.source}\u0000${edge.target}`}
                className={`${styles.networkEdge} ${dimmed ? styles.networkEdgeDimmed : ''}`}
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                strokeOpacity={Math.min(0.7, 0.22 + edge.weight * 0.12)}
              />
            );
          })}
          {graph.nodes.map((node) => {
            const radius = networkNodeRadius(node, maxWeight);
            const selected = node.id === selectedId;
            const showLabel = selected || labelled.has(node.id);
            const dimmed = dimmedIds !== null && dimmedIds.has(node.id);
            return (
              <g
                key={node.id}
                className={`${styles.networkNode} ${dimmed ? styles.networkNodeDimmed : ''}`}
                transform={`translate(${node.x} ${node.y})`}
                role="button"
                tabIndex={0}
                aria-label={`${node.label}，${node.degree} 条连接，${node.documentCount} 篇文档`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => onSelect(node.id)}
                onKeyDown={(event) => handleNodeKeyDown(event, node.id)}
              >
                {node.isolated ? (
                  <circle className={styles.networkIsolated} r={radius + 4} />
                ) : null}
                <circle
                  className={`${styles.networkDot} ${selected ? styles.networkDotSelected : ''}`}
                  r={radius}
                  fill={dimensionColor(node.dimensionId)}
                />
                {showLabel ? (
                  <text className={styles.networkLabel} y={-(radius + 6)} textAnchor="middle">
                    {node.label}
                  </text>
                ) : null}
                <title>{`${node.label} · ${node.degree} 条连接 · ${node.documentCount} 篇文档`}</title>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

interface SectionToggleProps {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly label: string;
}

/** 分区折叠按钮：默认收起，标题与统计仍在卡片头部可见。 */
function SectionToggle({ open, onToggle, label }: SectionToggleProps) {
  return (
    <button
      type="button"
      className={styles.cardToggle}
      aria-expanded={open}
      aria-label={`${open ? '收起' : '展开'}${label}`}
      onClick={onToggle}
    >
      <svg className={styles.cardToggleChevron} viewBox="0 0 12 12" aria-hidden="true">
        <path
          d="M4.5 2.5 8 6l-3.5 3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {open ? '收起' : '展开'}
    </button>
  );
}

export function BoardView({ docs, vaultId, links, readDoc, onBackToCanvas, onRevealDoc }: BoardViewProps) {
  const [now] = useState(() => Date.now());
  const storage = useMemo(() => boardStorage(), []);

  const [classify, setClassify] = useState<BoardClassifyMap>(
    () => (vaultId === null ? new Map() : loadClassifications(storage, vaultId).map),
  );
  const [classifyWarning, setClassifyWarning] = useState<string | null>(null);
  const [rules, setRules] = useState<readonly BoardDimensionRule[]>(
    () => (vaultId === null ? [] : loadDimensionRules(storage, vaultId).rules),
  );
  const [rulesWarning, setRulesWarning] = useState<string | null>(null);
  const [docStats, setDocStats] = useState<ReadonlyMap<string, BoardDocStat>>(new Map());
  const [t1, setT1] = useState<T1State>({ status: 'idle', done: 0, total: 0, skipped: 0 });
  const [snapshots, setSnapshots] = useState<readonly BoardSnapshot[]>(
    () => (vaultId === null ? [] : loadSnapshots(storage, vaultId)),
  );
  const [listFilter, setListFilter] = useState<'all' | 'unclassified'>('all');
  const [activeDate, setActiveDate] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [networkSelectedId, setNetworkSelectedId] = useState<string | null>(null);
  const [networkDimensionFilter, setNetworkDimensionFilter] = useState<BoardDimensionId | null>(
    null,
  );
  const [networkIsolatedOnly, setNetworkIsolatedOnly] = useState(false);
  const [collapsed, setCollapsed] = useState({ classify: false, rules: false, timeline: false });
  const [rulePattern, setRulePattern] = useState('');
  const [ruleDimension, setRuleDimension] = useState<BoardDimensionId>('procedural');
  const recordedRef = useRef(false);

  // 切库 / 重连：重新读取覆盖层、规则与历史快照。
  useEffect(() => {
    if (vaultId === null) {
      setClassify(new Map());
      setClassifyWarning(null);
      setRules([]);
      setRulesWarning(null);
      setSnapshots([]);
      return;
    }
    const loadedClassify = loadClassifications(storage, vaultId);
    setClassify(loadedClassify.map);
    setClassifyWarning(loadedClassify.warning);
    const loadedRules = loadDimensionRules(storage, vaultId);
    setRules(loadedRules.rules);
    setRulesWarning(loadedRules.warning);
    setSnapshots(loadSnapshots(storage, vaultId));
  }, [storage, vaultId]);

  // T1：后台读取正文标签；并发 4、可取消，缓存命中时几乎无 IO。
  useEffect(() => {
    if (vaultId === null || docs.length === 0) {
      setDocStats(new Map());
      setT1({ status: 'done', done: 0, total: 0, skipped: 0 });
      return;
    }
    const controller = new AbortController();
    setT1({ status: 'loading', done: 0, total: docs.length, skipped: 0 });
    void buildBoardStats({
      docs: docs.map((doc) => ({
        path: doc.path,
        sha256: doc.sha256,
        bytes: doc.bytes,
        modifiedMs: doc.modifiedMs,
      })),
      read: readDoc,
      storage,
      vaultId,
      signal: controller.signal,
      onProgress: (progress) => {
        setT1((current) =>
          progress.done === progress.total || progress.done - current.done >= 10
            ? {
                status: 'loading',
                done: progress.done,
                total: progress.total,
                skipped: progress.skipped,
              }
            : current,
        );
      },
    })
      .then((result) => {
        if (result.cancelled) return;
        setDocStats(new Map(result.stats.map((stat) => [stat.path, stat])));
        setT1({
          status: 'done',
          done: docs.length,
          total: docs.length,
          skipped: result.stats.filter((stat) => stat.skipped).length,
        });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setT1({ status: 'error', done: 0, total: docs.length, skipped: 0 });
      });
    return () => controller.abort();
  }, [docs, readDoc, storage, vaultId]);

  // 显式标注优先；没有显式标注时用标签规则预填。
  const dimensionLookup = useMemo(() => {
    const base = toDimensionLookup(classify);
    const lookup = new Map<string, readonly BoardDimensionId[]>();
    for (const doc of docs) {
      const explicit = base.get(doc.path);
      if (explicit !== undefined && explicit.length > 0) {
        lookup.set(doc.path, explicit);
        continue;
      }
      const tags = docStats.get(doc.path)?.tags ?? [];
      const inferred = matchDimensionRules(tags, rules);
      if (inferred.length > 0) lookup.set(doc.path, inferred);
    }
    return lookup;
  }, [classify, docStats, docs, rules]);

  const statDocs = useMemo<readonly BoardDocStat[]>(
    () =>
      docs.map((doc) => {
        const stat = docStats.get(doc.path);
        if (stat !== undefined && stat.sha256 === doc.sha256) {
          return {
            ...stat,
            bytes: doc.bytes,
            modifiedMs: doc.modifiedMs,
          };
        }
        return {
          path: doc.path,
          sha256: doc.sha256,
          bytes: doc.bytes,
          modifiedMs: doc.modifiedMs,
          title: titleFromPath(doc.path),
          tags: [],
          wordCount: 0,
          skipped: false,
          createdMs: null,
        };
      }),
    [docStats, docs],
  );

  // S4：全局日期筛选——只保留「本地修改日期 == activeDate」的文档。
  const filteredDocs = useMemo(
    () =>
      activeDate === null
        ? docs
        : docs.filter((doc) => localDateKey(doc.modifiedMs) === activeDate),
    [activeDate, docs],
  );

  const scopeStats = useMemo(
    () =>
      activeDate === null
        ? statDocs
        : statDocs.filter((doc) => localDateKey(doc.modifiedMs) === activeDate),
    [activeDate, statDocs],
  );

  const metrics = useMemo(
    () =>
      buildBoardMetrics(statDocs, dimensionLookup, {
        now,
        links,
        totalDocs: docs.length,
      }),
    [dimensionLookup, docs.length, links, now, statDocs],
  );

  // 雷达/维度条按筛选后的文档子集重算；趋势与热力图仍用全量口径。
  const scopedMetrics = useMemo(
    () =>
      buildBoardMetrics(scopeStats, dimensionLookup, {
        now,
        links,
        totalDocs: filteredDocs.length,
      }),
    [dimensionLookup, filteredDocs.length, links, now, scopeStats],
  );
  const scopeMetrics = activeDate === null ? metrics : scopedMetrics;

  const previous = useMemo(() => previousSnapshot(snapshots, now), [now, snapshots]);

  // 首次打开看板、正文统计结束（或降级）后记录一份快照；每次挂载只写一次。
  // S4：有筛选时指标只覆盖子集，不写入快照。
  useEffect(() => {
    if (activeDate !== null) return;
    if (vaultId === null || docs.length === 0 || recordedRef.current) return;
    if (t1.status === 'loading' || t1.status === 'idle') return;
    recordedRef.current = true;
    setSnapshots(recordSnapshot(storage, vaultId, createBoardSnapshot(metrics, now)));
  }, [activeDate, docs.length, metrics, now, storage, t1.status, vaultId]);

  const summary = useMemo(() => {
    const weekCutoff = now - 7 * DAY_MS_RENDER;
    const todayKey = localDateKey(now);
    let bytes = 0;
    let modifiedWeek = 0;
    let modifiedToday = 0;
    for (const doc of filteredDocs) {
      bytes += doc.bytes;
      if (doc.modifiedMs >= weekCutoff) modifiedWeek += 1;
      if (localDateKey(doc.modifiedMs) === todayKey) modifiedToday += 1;
    }
    return { bytes, modifiedWeek, modifiedToday };
  }, [filteredDocs, now]);

  const trend = useMemo(() => buildModifiedTrend(docs, now, TREND_DAYS), [docs, now]);
  const trendTotal = useMemo(
    () => trend.reduce((sum, point) => sum + point.count, 0),
    [trend],
  );
  const heatmapWeeks = useMemo(() => buildHeatmapWeeks(metrics.heatmap), [metrics.heatmap]);
  const heatmapMax = useMemo(
    () => Math.max(0, ...metrics.heatmap.map((day) => day.count)),
    [metrics.heatmap],
  );

  // S5：网络 / 分布 / 时间线均按当前筛选子集计算，与雷达口径一致。
  const networkGraph = useMemo(
    () => layoutNetwork(buildNetworkGraph(scopeStats, dimensionLookup, links)),
    [dimensionLookup, links, scopeStats],
  );
  const distribution = useMemo(
    () =>
      buildDistribution(scopeStats, dimensionLookup, links, {
        now,
        allPaths: new Set(docs.map((doc) => doc.path)),
      }),
    [dimensionLookup, docs, links, now, scopeStats],
  );
  const timeline = useMemo(
    () => buildTimeline(scopeStats, dimensionLookup, { limit: TIMELINE_LIMIT }),
    [dimensionLookup, scopeStats],
  );
  const distributionMax = useMemo(
    () => Math.max(1, ...distribution.dimensions.map((row) => row.count)),
    [distribution],
  );
  const presentDimensions = useMemo(() => {
    const present = new Set<BoardDimensionId>();
    for (const node of networkGraph.nodes) {
      if (node.dimensionId !== null) present.add(node.dimensionId);
    }
    return BOARD_DIMENSIONS.filter((dimension) => present.has(dimension.id));
  }, [networkGraph.nodes]);
  // 视图或筛选变化后，之前选中的维度可能已不存在；此时按未筛选处理。
  const activeDimensionFilter =
    networkDimensionFilter !== null &&
    presentDimensions.some((dimension) => dimension.id === networkDimensionFilter)
      ? networkDimensionFilter
      : null;
  const activeIsolatedOnly =
    networkIsolatedOnly && networkGraph.nodes.some((node) => node.isolated);
  const networkDimmedIds = useMemo(() => {
    if (activeDimensionFilter === null && !activeIsolatedOnly) return null;
    const dimmed = new Set<string>();
    for (const node of networkGraph.nodes) {
      // 选中节点始终高亮，避免筛选后失去当前查看的对象。
      if (node.id === networkSelectedId) continue;
      const matchDimension =
        activeDimensionFilter === null || node.dimensionId === activeDimensionFilter;
      const matchIsolated = !activeIsolatedOnly || node.isolated;
      if (!matchDimension || !matchIsolated) dimmed.add(node.id);
    }
    return dimmed;
  }, [activeDimensionFilter, activeIsolatedOnly, networkGraph.nodes, networkSelectedId]);
  const heatmapMonths = useMemo(
    () => buildHeatmapMonthLabels(heatmapWeeks),
    [heatmapWeeks],
  );
  const networkSelection = useMemo(
    () => networkGraph.nodes.find((node) => node.id === networkSelectedId) ?? null,
    [networkGraph.nodes, networkSelectedId],
  );

  const classifiedCount = useMemo(
    () => filteredDocs.filter((doc) => (dimensionLookup.get(doc.path)?.length ?? 0) > 0).length,
    [dimensionLookup, filteredDocs],
  );

  const averageNow = useMemo(
    () => scopeMetrics.dimensions.reduce((sum, dimension) => sum + dimension.score, 0) / 8,
    [scopeMetrics],
  );

  const visibleDocs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const out: BoardDocT0[] = [];
    for (const doc of filteredDocs) {
      const dims = dimensionLookup.get(doc.path);
      if (listFilter === 'unclassified' && dims !== undefined && dims.length > 0) continue;
      if (needle !== '') {
        const title = docStats.get(doc.path)?.title ?? titleFromPath(doc.path);
        if (!`${title}\n${doc.path}`.toLowerCase().includes(needle)) continue;
      }
      out.push(doc);
      if (out.length >= LIST_LIMIT) break;
    }
    return out;
  }, [dimensionLookup, docStats, filteredDocs, listFilter, query]);

  const selected = useMemo(() => {
    if (selectedPath === null) return null;
    const doc = filteredDocs.find((entry) => entry.path === selectedPath);
    if (doc === undefined) return null;
    const entry = classify.get(doc.path);
    const dims = dimensionLookup.get(doc.path) ?? [];
    return {
      doc,
      title: docStats.get(doc.path)?.title ?? titleFromPath(doc.path),
      dims,
      explicit: entry !== undefined,
      needsReview: entry !== undefined && classificationNeedsReview(entry, doc.sha256),
    };
  }, [classify, dimensionLookup, docStats, filteredDocs, selectedPath]);

  function persistClassify(next: BoardClassifyMap): void {
    setClassify(next);
    if (vaultId === null) return;
    setClassifyWarning(saveClassifications(storage, vaultId, next));
  }

  function toggleDimension(doc: BoardDocT0, dimension: BoardDimensionId): void {
    const current = classify.get(doc.path)?.dimensions ?? [];
    const nextDims = current.includes(dimension)
      ? current.filter((item) => item !== dimension)
      : [...current, dimension];
    persistClassify(setBoardClassification(classify, doc.path, doc.sha256, nextDims, Date.now()));
  }

  function submitRule(): void {
    const next = addDimensionRule(rules, rulePattern, ruleDimension);
    if (next === rules) return;
    setRules(next);
    setRulePattern('');
    if (vaultId !== null) setRulesWarning(saveDimensionRules(storage, vaultId, next));
  }

  function deleteRule(index: number): void {
    const next = removeDimensionRule(rules, index);
    if (next === rules) return;
    setRules(next);
    if (vaultId !== null) setRulesWarning(saveDimensionRules(storage, vaultId, next));
  }

  function selectDocument(path: string): void {
    setSelectedPath(path);
    setNetworkSelectedId(path);
  }

  function selectNetworkNode(nodeId: string): void {
    if (isNetworkGroupId(nodeId)) {
      setNetworkSelectedId(nodeId);
      return;
    }
    selectDocument(nodeId);
  }

  function toggleSection(key: keyof typeof collapsed): void {
    setCollapsed((current) => ({ ...current, [key]: !current[key] }));
  }

  const hasDimensions = scopeMetrics.dimensions.some((dimension) => dimension.docs > 0);
  const coveredDelta =
    previous === null ? null : scopeMetrics.coveredDimensions - previous.coveredDimensions;
  const averageDelta = previous === null ? null : averageNow - averageScore(previous);

  return (
    <section className={styles.board} aria-label="知识看板">
      <div className={styles.inner}>
        <header className={styles.header}>
          <div className={styles.heading}>
            <h1 className={styles.title}>知识看板</h1>
            <p className={styles.subtitle}>知识库概览 · 基于库索引的只读分析</p>
          </div>
          <button type="button" className={styles.backButton} onClick={onBackToCanvas}>
            回到画布
          </button>
        </header>

        {docs.length === 0 ? (
          <section className={styles.empty} aria-label="空库提示">
            <span className={styles.emptyMark} aria-hidden="true" />
            <p className={styles.emptyTitle}>库中暂无文档</p>
            <p className={styles.emptyHint}>
              在左侧文档库新建文章，或向库目录放入 Markdown 文件后回到看板查看统计。
            </p>
          </section>
        ) : (
          <>
            {activeDate === null ? null : (
              <div className={styles.filterBar} role="status">
                <span className={styles.filterChip}>筛选：{activeDate}</span>
                <span className={styles.filterCount}>命中 {filteredDocs.length} 篇</span>
                <button
                  type="button"
                  className={styles.filterClear}
                  onClick={() => setActiveDate(null)}
                >
                  清除
                </button>
              </div>
            )}

            <div className={styles.dashboard}>
            <section className={`${styles.card} ${styles.cardKpis}`} aria-label="关键指标">
              <div className={styles.cardHeader}>
                <div>
                  <h2 className={styles.cardTitle}>关键指标</h2>
                  <p className={styles.cardSub}>
                    {activeDate === null ? '全库概览 · 随筛选联动' : `筛选：${activeDate}`}
                  </p>
                </div>
              </div>
              <ul className={styles.kpiStack}>
                <li className={styles.kpiRow}>
                  <span className={styles.kpiLabel}>文档数</span>
                  <span className={styles.kpiHint}>
                    {activeDate === null ? '索引内 .md 文件' : '筛选日期内 .md 文件'}
                  </span>
                  <span className={`${styles.kpiValue} tabular-nums`}>{filteredDocs.length}</span>
                </li>
                <li className={styles.kpiRow}>
                  <span className={styles.kpiLabel}>库容量</span>
                  <span className={styles.kpiHint}>
                    {activeDate === null ? '全部文档字节数' : '筛选范围内字节数'}
                  </span>
                  <span className={`${styles.kpiValue} tabular-nums`}>
                    {formatBytes(summary.bytes)}
                  </span>
                </li>
                <li className={styles.kpiRow}>
                  <span className={styles.kpiLabel}>近 7 天修改</span>
                  <span className={styles.kpiHint}>
                    {activeDate === null ? '篇文档有改动' : '筛选范围内近 7 天有改动'}
                  </span>
                  <span className={`${styles.kpiValue} tabular-nums`}>{summary.modifiedWeek}</span>
                </li>
                <li className={styles.kpiRow}>
                  <span className={styles.kpiLabel}>今日修改</span>
                  <span className={styles.kpiHint}>
                    {activeDate === null ? '按本地日期统计' : '筛选范围内今日改动'}
                  </span>
                  <span className={`${styles.kpiValue} tabular-nums`}>{summary.modifiedToday}</span>
                </li>
              </ul>
            </section>

            <section className={`${styles.card} ${styles.cardHeatmap}`} aria-label="最近 182 天修改热力图">
              <div className={styles.cardHeader}>
                <div>
                  <h2 className={styles.cardTitle}>修改热力图</h2>
                  <p className={styles.cardSub}>最近 182 天 · 点击日期筛选</p>
                </div>
                <span className={styles.heatmapLegend} aria-hidden="true">
                  少
                  <span className={`${styles.heatSwatch} ${styles.heatCellLevel0}`} />
                  <span className={`${styles.heatSwatch} ${styles.heatCellLevel1}`} />
                  <span className={`${styles.heatSwatch} ${styles.heatCellLevel2}`} />
                  <span className={`${styles.heatSwatch} ${styles.heatCellLevel3}`} />
                  <span className={`${styles.heatSwatch} ${styles.heatCellLevel4}`} />
                  多
                </span>
              </div>
              <div className={styles.heatmapScroll}>
                <div className={styles.heatmapInner}>
                  <div className={styles.heatmapMonths} aria-hidden="true">
                    {heatmapMonths.map((month) => (
                      <span
                        key={`${month.index}-${month.label}`}
                        className={styles.heatmapMonth}
                        style={{ left: `${month.index * HEATMAP_COLUMN}px` }}
                      >
                        {month.label}
                      </span>
                    ))}
                  </div>
                  <div className={styles.heatmapBody}>
                    <div className={styles.heatmapWeekdays} aria-hidden="true">
                      {HEATMAP_WEEKDAYS.map((label, index) => (
                        <span key={index}>{label}</span>
                      ))}
                    </div>
                    <div className={styles.heatmapGrid} role="grid" aria-label="最近 182 天修改热力图">
                      {heatmapWeeks.map((week, weekIndex) => (
                        <div className={styles.heatmapWeek} key={weekIndex}>
                          {week.map((day, dayIndex) =>
                            day === null ? (
                              <span
                                key={dayIndex}
                                className={styles.heatCellBlank}
                                aria-hidden="true"
                              />
                            ) : (
                              <button
                                key={day.date}
                                type="button"
                                className={`${styles.heatCell} ${heatLevelClass(
                                  day.count,
                                  heatmapMax,
                                )} ${activeDate === day.date ? styles.heatCellActive : ''}`}
                                aria-label={`${day.date}，${day.count} 篇修改`}
                                aria-pressed={activeDate === day.date}
                                title={`${day.date} · ${day.count} 篇修改`}
                                onClick={() =>
                                  setActiveDate((current) =>
                                    current === day.date ? null : day.date,
                                  )
                                }
                              />
                            ),
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section className={`${styles.card} ${styles.cardNetwork}`} aria-label="知识网络">
              <div className={styles.cardHeader}>
                <div>
                  <h2 className={styles.cardTitle}>知识网络</h2>
                  <p className={styles.cardSub}>
                    {scopeStats.length} 篇 · {networkGraph.edges.length} 条连接
                    {networkGraph.aggregated ? ' · 超过 500 篇，已按主维度聚合' : ''}
                  </p>
                </div>
                <span className={styles.networkLegend}>
                  {presentDimensions.map((dimension) => (
                    <button
                      key={dimension.id}
                      type="button"
                      className={`${styles.networkLegendItem} ${styles.networkLegendButton} ${
                        activeDimensionFilter === dimension.id ? styles.networkLegendActive : ''
                      }`}
                      aria-pressed={activeDimensionFilter === dimension.id}
                      title={`只看「${dimension.shortLabel}」`}
                      onClick={() =>
                        setNetworkDimensionFilter((current) =>
                          current === dimension.id ? null : dimension.id,
                        )
                      }
                    >
                      <span
                        className={styles.dimensionDot}
                        style={{ background: dimension.color }}
                        aria-hidden="true"
                      />
                      {dimension.shortLabel}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={`${styles.networkLegendItem} ${styles.networkLegendButton} ${
                      activeIsolatedOnly ? styles.networkLegendActive : ''
                    }`}
                    aria-pressed={activeIsolatedOnly}
                    title="只看孤立文档"
                    onClick={() => setNetworkIsolatedOnly((current) => !current)}
                  >
                    <span className={styles.networkLegendIsolated} aria-hidden="true" />
                    孤立
                  </button>
                </span>
              </div>
              {networkGraph.nodes.length === 0 ? (
                <p className={styles.listEmpty}>当前范围内没有文档</p>
              ) : (
                <NetworkChart
                  graph={networkGraph}
                  selectedId={networkSelectedId}
                  dimmedIds={networkDimmedIds}
                  onSelect={selectNetworkNode}
                />
              )}
              {networkSelection === null ? null : (
                <div className={styles.networkDetail}>
                  <div className={styles.networkDetailMain}>
                    <span className={styles.networkDetailTitle}>{networkSelection.label}</span>
                    {isNetworkGroupId(networkSelection.id) ? (
                      <span className={styles.networkDetailMeta}>
                        维度分组 · {networkSelection.documentCount} 篇文档
                      </span>
                    ) : (
                      <span className={styles.networkDetailPath}>{networkSelection.id}</span>
                    )}
                  </div>
                  <span className={styles.networkDetailMeta}>
                    {networkSelection.degree} 条连接
                  </span>
                  {isNetworkGroupId(networkSelection.id) || onRevealDoc === undefined ? null : (
                    <button
                      type="button"
                      className={styles.locateButton}
                      onClick={() => onRevealDoc(networkSelection.id)}
                    >
                      在画布中定位
                    </button>
                  )}
                </div>
              )}
            </section>

            <div className={styles.columns}>
              <div className={styles.mainColumn}>
                <section className={`${styles.card} ${styles.cardTrend}`} aria-label="最近修改趋势">
                  <div className={styles.cardHeader}>
                    <div>
                      <h2 className={styles.cardTitle}>最近修改趋势</h2>
                      <p className={styles.cardSub}>
                        近 {TREND_DAYS} 天共 {trendTotal} 篇次修改
                      </p>
                    </div>
                    <span className={styles.legend}>
                      <span className={styles.legendMark} aria-hidden="true" />
                      每日修改文档数
                    </span>
                  </div>
                  <TrendChart points={trend} />
                </section>

                <section className={`${styles.card} ${styles.cardDist}`} aria-label="分布分析">
                  <div className={styles.cardHeader}>
                    <div>
                      <h2 className={styles.cardTitle}>分布分析</h2>
                      <p className={styles.cardSub}>维度标注、标签与结构问题 · 随日期筛选联动</p>
                    </div>
                  </div>
                  <div className={styles.distGrid}>
                    <div className={styles.distSection}>
                      <h3 className={styles.distTitle}>维度分布</h3>
                      <ul className={styles.distBars}>
                        {distribution.dimensions.map((row) => {
                          const meta = DIMENSION_BY_ID.get(row.id);
                          if (meta === undefined) return null;
                          return (
                            <li
                              key={row.id}
                              className={styles.distRow}
                              title={`${row.count} 篇 · 近 30 天活跃 ${row.active} 篇`}
                            >
                              <span className={styles.distName}>
                                <span
                                  className={styles.dimensionDot}
                                  style={{ background: meta.color }}
                                  aria-hidden="true"
                                />
                                {meta.shortLabel}
                              </span>
                              <span className={styles.distTrack}>
                                <span
                                  className={styles.distActive}
                                  style={{
                                    width: `${(row.active / distributionMax) * 100}%`,
                                    background: meta.color,
                                  }}
                                />
                                <span
                                  className={styles.distRest}
                                  style={{
                                    width: `${((row.count - row.active) / distributionMax) * 100}%`,
                                    background: meta.color,
                                  }}
                                />
                              </span>
                              <span className={`${styles.distCount} tabular-nums`}>
                                {row.count}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                      <p className={styles.distLegend}>实色 = 近 30 天有修改 · 淡色 = 更早 · 一篇可属多维</p>
                    </div>

                    <div className={styles.distSection}>
                      <h3 className={styles.distTitle}>标签 Top {NETWORK_TAG_LIMIT}</h3>
                      {distribution.tags.length === 0 ? (
                        <p className={styles.listEmpty}>暂无标签；正文读取完成后出现。</p>
                      ) : (
                        <ul className={styles.tagList}>
                          {distribution.tags.map((tag) => (
                            <li key={tag.tag} className={styles.tagChip}>
                              <span className={styles.tagName}>{tag.tag}</span>
                              <span className={`${styles.tagCount} tabular-nums`}>{tag.count}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {distribution.totalTags > distribution.tags.length ? (
                        <p className={styles.listHint}>
                          共 {distribution.totalTags} 个标签，仅显示前 {distribution.tags.length} 个
                        </p>
                      ) : null}
                    </div>

                    <div className={styles.distSection}>
                      <h3 className={styles.distTitle}>结构问题</h3>
                      <ul className={styles.issueStats}>
                        <li className={styles.issueStat}>
                          <span className={styles.issueLabel}>孤立文档</span>
                          <span className={`${styles.issueCount} tabular-nums`}>
                            {distribution.isolatedTotal}
                          </span>
                        </li>
                        <li className={styles.issueStat}>
                          <span className={styles.issueLabel}>断链</span>
                          <span className={`${styles.issueCount} tabular-nums`}>
                            {distribution.brokenLinksTotal}
                          </span>
                        </li>
                        <li className={styles.issueStat}>
                          <span className={styles.issueLabel}>未分类</span>
                          <span className={`${styles.issueCount} tabular-nums`}>
                            {distribution.unclassified}
                          </span>
                        </li>
                      </ul>
                      {distribution.isolatedTotal === 0 ? (
                        <p className={styles.listEmpty}>没有孤立文档</p>
                      ) : (
                        <ul className={styles.issueDocs}>
                          {distribution.isolated.slice(0, 5).map((row) => (
                            <li key={row.path}>
                              <button
                                type="button"
                                className={styles.issueDoc}
                                title={row.path}
                                onClick={() => selectDocument(row.path)}
                              >
                                {row.title}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      {distribution.brokenLinksTotal === 0 ? null : (
                        <ul className={styles.issueDocs}>
                          {distribution.brokenLinks.slice(0, 5).map((row) => (
                            <li
                              key={`${row.from}\u0000${row.to}`}
                              className={styles.issueBroken}
                              title={`${row.from} → ${row.to}`}
                            >
                              {row.fromTitle} →{' '}
                              <span className={styles.issueTarget}>{row.to}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </section>

                <section className={`${styles.card} ${styles.cardClassify}`} aria-label="八维分类">
                  <div className={styles.cardHeader}>
                    <div>
                      <h2 className={styles.cardTitle}>分类</h2>
                      <p className={styles.cardSub}>
                        已归类 {classifiedCount} / {filteredDocs.length} 篇 · 未分类{' '}
                        {filteredDocs.length - classifiedCount} 篇
                      </p>
                    </div>
                    <div className={styles.cardHeaderActions}>
                      <div className={styles.filters} role="group" aria-label="分类筛选">
                        <button
                          type="button"
                          className={`${styles.filterButton} ${
                            listFilter === 'all' ? styles.filterActive : ''
                          }`}
                          onClick={() => setListFilter('all')}
                        >
                          全部
                        </button>
                        <button
                          type="button"
                          className={`${styles.filterButton} ${
                            listFilter === 'unclassified' ? styles.filterActive : ''
                          }`}
                          onClick={() => setListFilter('unclassified')}
                        >
                          仅未分类
                        </button>
                      </div>
                      <SectionToggle
                        open={!collapsed.classify}
                        label="分类"
                        onToggle={() => toggleSection('classify')}
                      />
                    </div>
                  </div>

                  {collapsed.classify ? null : (
                  <>
                  {classifyWarning === null ? null : (
                    <p className={styles.warning} role="status">{classifyWarning}</p>
                  )}

                  <div className={styles.classifyBody}>
                    <div className={styles.docListPane}>
                      <input
                        className={styles.searchInput}
                        value={query}
                        placeholder="搜索标题或路径"
                        aria-label="搜索文档"
                        onChange={(event) => setQuery(event.target.value)}
                      />
                      {visibleDocs.length === 0 ? (
                        <p className={styles.listEmpty}>没有符合条件的文档</p>
                      ) : (
                        <ul className={styles.docList}>
                          {visibleDocs.map((doc) => {
                            const dims = dimensionLookup.get(doc.path) ?? [];
                            const inferred = dims.length > 0 && !classify.has(doc.path);
                            const title = docStats.get(doc.path)?.title ?? titleFromPath(doc.path);
                            return (
                              <li key={doc.path}>
                                <button
                                  type="button"
                                  className={`${styles.docRow} ${
                                    doc.path === selectedPath ? styles.docRowActive : ''
                                  }`}
                                  onClick={() => selectDocument(doc.path)}
                                  title={doc.path}
                                >
                                  <span className={styles.docRowTitle}>{title}</span>
                                  <span className={styles.docRowMeta}>
                                    {inferred ? (
                                      <span className={styles.inferredBadge}>规则</span>
                                    ) : null}
                                    {dims.length > 0 ? (
                                      <span className="tabular-nums">{dims.length} 维</span>
                                    ) : (
                                      <span className={styles.docRowMuted}>未分类</span>
                                    )}
                                  </span>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                      {visibleDocs.length >= LIST_LIMIT ? (
                        <p className={styles.listHint}>仅显示前 {LIST_LIMIT} 篇，请用搜索缩小范围</p>
                      ) : null}
                    </div>

                    <div className={styles.detailPane}>
                      {selected === null ? (
                        <p className={styles.detailEmpty}>选择左侧文档，勾选它所属的知识维度。</p>
                      ) : (
                        <>
                          <div className={styles.detailHeader}>
                            <span className={styles.detailTitle}>{selected.title}</span>
                            <span className={styles.detailPath}>{selected.doc.path}</span>
                          </div>
                          {onRevealDoc === undefined ? null : (
                            <button
                              type="button"
                              className={styles.locateButton}
                              onClick={() => onRevealDoc(selected.doc.path)}
                            >
                              在画布中定位
                            </button>
                          )}
                          {selected.needsReview ? (
                            <p className={styles.warning} role="status">
                              文档内容已变化，建议复核此前的分类。
                            </p>
                          ) : null}
                          {!selected.explicit && selected.dims.length > 0 ? (
                            <p className={styles.inferredHint}>
                              当前由标签规则预填，勾选任意维度后将写入你的标注。
                            </p>
                          ) : null}
                          <div className={styles.dimensionChecks}>
                            {BOARD_DIMENSIONS.map((dimension) => {
                              const checked = selected.dims.includes(dimension.id);
                              return (
                                <label key={dimension.id} className={styles.dimensionCheck}>
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => toggleDimension(selected.doc, dimension.id)}
                                  />
                                  <span
                                    className={styles.dimensionDot}
                                    style={{ background: dimension.color }}
                                    aria-hidden="true"
                                  />
                                  <span>{dimension.label}</span>
                                </label>
                              );
                            })}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                  </>
                  )}
                </section>
              </div>

              <aside className={styles.sideColumn}>
                <section className={`${styles.card} ${styles.cardRadar}`} aria-label="八维覆盖">
                  <div className={styles.cardHeader}>
                    <div>
                      <h2 className={styles.cardTitle}>八维覆盖</h2>
                      <p className={styles.cardSub}>
                        覆盖维度 {scopeMetrics.coveredDimensions} / 8
                      </p>
                    </div>
                    {scopeMetrics.balance === null ? null : (
                      <span className={styles.balanceBadge}>均衡度 {scopeMetrics.balance}</span>
                    )}
                  </div>

                  {!hasDimensions ? (
                    <div className={styles.radarEmpty}>
                      <p className={styles.radarEmptyTitle}>还没有维度标注</p>
                      <p className={styles.radarEmptyHint}>
                        在左侧「分类」中勾选文档维度，或在下方添加「标签 → 维度」规则自动预填。
                      </p>
                    </div>
                  ) : (
                    <>
                      <RadarChart metrics={scopeMetrics} />
                      <ul className={styles.dimensionBars}>
                        {scopeMetrics.dimensions.map((dimension) => {
                          const meta = DIMENSION_BY_ID.get(dimension.id);
                          if (meta === undefined) return null;
                          return (
                            <li
                              key={dimension.id}
                              className={styles.dimensionBar}
                              title={`覆盖 ${round(dimension.coverage)} · 密度 ${round(
                                dimension.density,
                              )} · 活跃 ${round(dimension.activity)}`}
                            >
                              <span className={styles.dimensionName}>
                                <span
                                  className={styles.dimensionDot}
                                  style={{ background: meta.color }}
                                  aria-hidden="true"
                                />
                                {meta.shortLabel}
                              </span>
                              <span className={styles.dimensionTrack}>
                                <span
                                  className={styles.dimensionFill}
                                  style={{
                                    width: `${Math.max(0, Math.min(100, dimension.coverage))}%`,
                                    background: meta.color,
                                  }}
                                />
                              </span>
                              <span className={`${styles.dimensionScore} tabular-nums`}>
                                {dimension.score}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                      <p className={styles.metricNote}>
                        {scopeMetrics.balance === null
                          ? '均衡度需至少 4 个维度有文档'
                          : `均衡度 ${scopeMetrics.balance}（维度间得分越接近越高）`}
                        {scopeMetrics.totals.links === 0
                          ? ' · 暂无文档间链接'
                          : ''}
                      </p>
                      {activeDate !== null || previous === null ? null : (
                        <div className={styles.deltaRow}>
                          <span className={styles.deltaLabel}>较上次（{dateLabel(previous.date)}）</span>
                          <span className={`${styles.deltaValue} tabular-nums`}>
                            覆盖 {signed(coveredDelta ?? 0)} · 均分{' '}
                            {signed(Math.round((averageDelta ?? 0) * 10) / 10)}
                          </span>
                        </div>
                      )}
                    </>
                  )}

                  {t1.status === 'loading' ? (
                    <p className={styles.t1Status} role="status">
                      正在读取正文标签 {t1.done} / {t1.total}
                    </p>
                  ) : null}
                  {t1.status === 'error' ? (
                    <p className={styles.warning} role="status">正文标签读取失败，规则预填可能不完整</p>
                  ) : null}
                  {t1.status === 'done' && t1.skipped > 0 ? (
                    <p className={styles.t1Status}>
                      {t1.skipped} 篇超过 1 MiB，未读取标签
                    </p>
                  ) : null}
                </section>

                <section className={`${styles.card} ${styles.cardRules}`} aria-label="标签映射规则">
                  <div className={styles.cardHeader}>
                    <div>
                      <h2 className={styles.cardTitle}>标签映射</h2>
                      <p className={styles.cardSub}>
                        {rules.length} 条规则 · 命中标签时预填维度，可被手动标注覆盖
                      </p>
                    </div>
                    <SectionToggle
                      open={!collapsed.rules}
                      label="标签映射"
                      onToggle={() => toggleSection('rules')}
                    />
                  </div>

                  {collapsed.rules ? null : (
                  <>
                  {rulesWarning === null ? null : (
                    <p className={styles.warning} role="status">{rulesWarning}</p>
                  )}

                  {rules.length === 0 ? (
                    <p className={styles.listEmpty}>暂无规则。例如「方法/* → 程序性知识」。</p>
                  ) : (
                    <ul className={styles.ruleList}>
                      {rules.map((rule, index) => (
                        <li key={`${rule.pattern}:${rule.dimension}:${index}`} className={styles.ruleRow}>
                          <span className={styles.rulePattern}>{rule.pattern}</span>
                          <span className={styles.ruleArrow} aria-hidden="true">→</span>
                          <span className={styles.ruleDimension}>
                            {DIMENSION_BY_ID.get(rule.dimension)?.shortLabel ?? rule.dimension}
                          </span>
                          <button
                            type="button"
                            className={styles.ruleRemove}
                            aria-label={`删除规则 ${rule.pattern}`}
                            onClick={() => deleteRule(index)}
                          >
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  <form
                    className={styles.ruleForm}
                    onSubmit={(event) => {
                      event.preventDefault();
                      submitRule();
                    }}
                  >
                    <input
                      className={styles.searchInput}
                      value={rulePattern}
                      placeholder="标签或通配，如 方法/*"
                      aria-label="标签匹配模式"
                      onChange={(event) => setRulePattern(event.target.value)}
                    />
                    <div className={styles.ruleFormRow}>
                      <select
                        className={styles.ruleSelect}
                        value={ruleDimension}
                        aria-label="目标维度"
                        onChange={(event) => setRuleDimension(event.target.value as BoardDimensionId)}
                      >
                        {BOARD_DIMENSIONS.map((dimension) => (
                          <option key={dimension.id} value={dimension.id}>
                            {dimension.label}
                          </option>
                        ))}
                      </select>
                      <button type="submit" className={styles.ruleAdd}>添加</button>
                    </div>
                  </form>
                  </>
                  )}
                </section>

                <section className={`${styles.card} ${styles.cardTimeline}`} aria-label="时间线">
                  <div className={styles.cardHeader}>
                    <div>
                      <h2 className={styles.cardTitle}>时间线</h2>
                      <p className={styles.cardSub}>
                        最近 {timeline.length} 条创建与修改 · 点击查看文档
                      </p>
                    </div>
                    <SectionToggle
                      open={!collapsed.timeline}
                      label="时间线"
                      onToggle={() => toggleSection('timeline')}
                    />
                  </div>
                  {collapsed.timeline ? null : timeline.length === 0 ? (
                    <p className={styles.listEmpty}>当前范围内没有记录</p>
                  ) : (
                    <ol className={styles.timelineList}>
                      {timeline.map((event) => (
                        <li key={event.key}>
                          <button
                            type="button"
                            className={`${styles.timelineItem} ${
                              selectedPath === event.path ? styles.timelineItemActive : ''
                            }`}
                            title={event.path}
                            onClick={() => selectDocument(event.path)}
                          >
                            <span
                              className={styles.timelineDot}
                              style={{ background: dimensionColor(event.dimensionId) }}
                              aria-hidden="true"
                            />
                            <span className={styles.timelineBody}>
                              <span className={styles.timelineTitle}>{event.title}</span>
                              <span className={styles.timelineMeta}>
                                <span
                                  className={
                                    event.kind === 'created'
                                      ? styles.timelineKindCreated
                                      : styles.timelineKindModified
                                  }
                                >
                                  {event.kind === 'created' ? '新建' : '修改'}
                                </span>
                                {event.date}
                              </span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              </aside>
            </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
