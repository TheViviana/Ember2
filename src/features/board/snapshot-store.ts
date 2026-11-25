/**
 * CR-20261123-69 / S3：看板快照（环比）。
 *
 * 每次打开看板、正文统计完成（或失败降级）后追加一份快照，按库隔离存
 * `ember2:board:snapshots:v1:<vaultId>`。只保留最近 60 份：
 * - 首次使用没有任何历史 → UI 隐藏「较上次」；
 * - 之后任一启动都能与上一次快照比较（不要求跨月）。
 */
import {
  BOARD_DIMENSIONS,
  type BoardDimensionId,
  type BoardMetrics,
} from './model.ts';

export const BOARD_SNAPSHOTS_STORAGE_PREFIX = 'ember2:board:snapshots:v1:';
export const BOARD_SNAPSHOTS_SCHEMA_VERSION = 1;
export const BOARD_SNAPSHOTS_MAX = 60;

export function snapshotsStorageKey(vaultId: string): string {
  return `${BOARD_SNAPSHOTS_STORAGE_PREFIX}${vaultId}`;
}

export interface BoardSnapshot {
  readonly generatedAt: number;
  /** 本地日期 YYYY-MM-DD。 */
  readonly date: string;
  readonly docs: number;
  readonly links: number;
  readonly unclassified: number;
  readonly coveredDimensions: number;
  readonly balance: number | null;
  readonly scores: Readonly<Record<BoardDimensionId, number>>;
}

export interface SnapshotsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptyScores(): Record<BoardDimensionId, number> {
  return {
    factual: 0,
    conceptual: 0,
    procedural: 0,
    metacognitive: 0,
    explicit: 0,
    tacit: 0,
    interpersonal: 0,
    value: 0,
  };
}

export function createBoardSnapshot(metrics: BoardMetrics, now: number): BoardSnapshot {
  const scores = emptyScores();
  for (const dimension of metrics.dimensions) scores[dimension.id] = dimension.score;
  return Object.freeze({
    generatedAt: now,
    date: snapshotDate(now),
    docs: metrics.totals.docs,
    links: metrics.totals.links,
    unclassified: metrics.totals.unclassified,
    coveredDimensions: metrics.coveredDimensions,
    balance: metrics.balance,
    scores: Object.freeze(scores),
  });
}

/** 本地日期（sv-SE 固定输出 YYYY-MM-DD，不受系统区域格式影响）。 */
export function snapshotDate(now: number): string {
  return new Date(now).toLocaleDateString('sv-SE');
}

function parseSnapshot(value: unknown): BoardSnapshot | null {
  if (!isRecord(value)) return null;
  const generatedAt = value['generatedAt'];
  const date = value['date'];
  const docs = value['docs'];
  const links = value['links'];
  const unclassified = value['unclassified'];
  const coveredDimensions = value['coveredDimensions'];
  const balance = value['balance'];
  const scores = value['scores'];
  if (typeof generatedAt !== 'number' || !Number.isFinite(generatedAt)) return null;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (typeof docs !== 'number' || typeof links !== 'number') return null;
  if (typeof unclassified !== 'number' || typeof coveredDimensions !== 'number') return null;
  if (balance !== null && (typeof balance !== 'number' || !Number.isFinite(balance))) return null;
  if (!isRecord(scores)) return null;

  const parsedScores = emptyScores();
  for (const dimension of BOARD_DIMENSIONS) {
    const score = scores[dimension.id];
    if (typeof score !== 'number' || !Number.isFinite(score)) return null;
    parsedScores[dimension.id] = score;
  }
  return Object.freeze({
    generatedAt,
    date,
    docs,
    links,
    unclassified,
    coveredDimensions,
    balance,
    scores: Object.freeze(parsedScores),
  });
}

export function loadSnapshots(
  storage: SnapshotsStorage,
  vaultId: string,
): readonly BoardSnapshot[] {
  let raw: string | null;
  try {
    raw = storage.getItem(snapshotsStorageKey(vaultId));
  } catch {
    return [];
  }
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || parsed['version'] !== BOARD_SNAPSHOTS_SCHEMA_VERSION) return [];
  const items = parsed['items'];
  if (!Array.isArray(items)) return [];
  const snapshots: BoardSnapshot[] = [];
  for (const value of items) {
    const snapshot = parseSnapshot(value);
    if (snapshot !== null) snapshots.push(snapshot);
  }
  return snapshots.sort((a, b) => a.generatedAt - b.generatedAt);
}

/** 追加一份快照并按 generatedAt 保留最近 N 份；返回更新后的列表。 */
export function recordSnapshot(
  storage: SnapshotsStorage,
  vaultId: string,
  snapshot: BoardSnapshot,
  maxEntries: number = BOARD_SNAPSHOTS_MAX,
): readonly BoardSnapshot[] {
  const next = [...loadSnapshots(storage, vaultId), snapshot];
  next.sort((a, b) => a.generatedAt - b.generatedAt);
  const trimmed = next.slice(Math.max(0, next.length - Math.max(1, maxEntries)));
  try {
    storage.setItem(
      snapshotsStorageKey(vaultId),
      JSON.stringify({ version: BOARD_SNAPSHOTS_SCHEMA_VERSION, items: trimmed }),
    );
  } catch {
    // 快照是增强信息，写入失败不影响看板。
  }
  return Object.freeze(trimmed);
}

/** 严格早于当前启动时间的最新快照；首次使用返回 null。 */
export function previousSnapshot(
  snapshots: readonly BoardSnapshot[],
  currentGeneratedAt: number,
): BoardSnapshot | null {
  let found: BoardSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.generatedAt >= currentGeneratedAt) continue;
    if (found === null || snapshot.generatedAt > found.generatedAt) found = snapshot;
  }
  return found;
}

export function averageScore(snapshot: BoardSnapshot): number {
  const total = BOARD_DIMENSIONS.reduce(
    (sum, dimension) => sum + (snapshot.scores[dimension.id] ?? 0),
    0,
  );
  return total / BOARD_DIMENSIONS.length;
}
