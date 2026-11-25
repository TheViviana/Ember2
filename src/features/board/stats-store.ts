/**
 * CR-20261123-69 / S1：T1 正文统计构建器。
 *
 * - 并发 4（可注入），AbortSignal 取消；
 * - 缓存 `ember2:board:stats:v1:<vaultId>`，键 = path，值带 sha256，只存聚合不含正文；
 * - 超过 1 MiB 的文档不读取正文，计入总数但字数 / 标签为空（v2 §2.1 规则 2）；
 * - 单篇读取失败不阻断整批，失败项单独返回供 UI 提示。
 *
 * 本模块不直接读盘：reader 由调用方注入（生产环境走 vault_read，测试用假实现）。
 */
import { formatUnknownError } from '../../core/errors.ts';
import {
  MAX_STAT_BYTES,
  parseDocStat,
  type BoardDocStat,
} from './model.ts';

export const BOARD_STATS_STORAGE_PREFIX = 'ember2:board:stats:v1:';
export const BOARD_STATS_SCHEMA_VERSION = 1;
export const BOARD_STATS_CONCURRENCY = 4;

const MAX_CONCURRENCY = 16;

export function statsStorageKey(vaultId: string): string {
  return `${BOARD_STATS_STORAGE_PREFIX}${vaultId}`;
}

export interface BoardStatsTarget {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly modifiedMs: number;
}

export interface BoardStatsRead {
  readonly sha256: string;
  readonly text: string;
}

export interface BoardStatsReader {
  (path: string): Promise<BoardStatsRead>;
}

export interface StatsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 缓存只保存正文派生的聚合值；bytes / modifiedMs 每次从索引重新取。 */
export interface BoardStatsCacheEntry {
  readonly sha256: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly wordCount: number;
  readonly skipped: boolean;
  readonly createdMs: number | null;
}

export type BoardStatsCache = ReadonlyMap<string, BoardStatsCacheEntry>;

export interface BoardStatsProgress {
  readonly done: number;
  readonly total: number;
  readonly failed: number;
  readonly skipped: number;
  readonly fromCache: number;
}

export interface BoardStatsFailure {
  readonly path: string;
  readonly reason: string;
}

export interface BuildBoardStatsOptions {
  readonly docs: readonly BoardStatsTarget[];
  readonly read: BoardStatsReader;
  readonly storage?: StatsStorage;
  readonly vaultId?: string;
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: BoardStatsProgress) => void;
}

export interface BoardStatsBuildResult {
  readonly stats: readonly BoardDocStat[];
  readonly failures: readonly BoardStatsFailure[];
  readonly cancelled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCacheEntry(value: unknown): BoardStatsCacheEntry | null {
  if (!isRecord(value)) return null;
  const { sha256, title, wordCount, skipped, createdMs } = value;
  const tags = value['tags'];
  if (typeof sha256 !== 'string' || typeof title !== 'string') return null;
  if (typeof wordCount !== 'number' || !Number.isFinite(wordCount)) return null;
  if (typeof skipped !== 'boolean') return null;
  if (createdMs !== null && (typeof createdMs !== 'number' || !Number.isFinite(createdMs))) {
    return null;
  }
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) return null;
  return Object.freeze({
    sha256,
    title,
    tags: Object.freeze(tags.filter((tag): tag is string => typeof tag === 'string')),
    wordCount,
    skipped,
    createdMs: typeof createdMs === 'number' ? createdMs : null,
  });
}

/** 读取缓存；损坏 / 版本不符 / 单条无效都只丢弃，不抛错（缓存永远是可选的）。 */
export function loadStatsCache(storage: StatsStorage, vaultId: string): BoardStatsCache {
  const map = new Map<string, BoardStatsCacheEntry>();
  let raw: string | null;
  try {
    raw = storage.getItem(statsStorageKey(vaultId));
  } catch {
    return map;
  }
  if (raw === null) return map;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return map;
  }
  if (!isRecord(parsed) || parsed['version'] !== BOARD_STATS_SCHEMA_VERSION) return map;
  const items = parsed['items'];
  if (!isRecord(items)) return map;
  for (const [path, value] of Object.entries(items)) {
    if (path === '') continue;
    const entry = parseCacheEntry(value);
    if (entry !== null) map.set(path, entry);
  }
  return map;
}

/** 写入缓存；失败静默（缓存是加速手段，不阻断看板）。 */
export function saveStatsCache(
  storage: StatsStorage,
  vaultId: string,
  cache: BoardStatsCache,
): void {
  const items: Record<string, BoardStatsCacheEntry> = {};
  for (const [path, entry] of cache) items[path] = entry;
  try {
    storage.setItem(
      statsStorageKey(vaultId),
      JSON.stringify({ version: BOARD_STATS_SCHEMA_VERSION, items }),
    );
  } catch {
    // localStorage 满 / 隐私模式：忽略。
  }
}

/** `vault://file-changed` 精确失效：只删对应 path，后续按需重读。 */
export function invalidateStatsCache(
  storage: StatsStorage,
  vaultId: string,
  paths: readonly string[],
): void {
  if (paths.length === 0) return;
  const cache = loadStatsCache(storage, vaultId);
  const next = new Map(cache);
  let changed = false;
  for (const path of paths) {
    if (next.delete(path)) changed = true;
  }
  if (changed) saveStatsCache(storage, vaultId, next);
}

function statFromCache(target: BoardStatsTarget, entry: BoardStatsCacheEntry): BoardDocStat {
  return Object.freeze({
    path: target.path,
    sha256: entry.sha256,
    bytes: target.bytes,
    modifiedMs: target.modifiedMs,
    title: entry.title,
    tags: entry.tags,
    wordCount: entry.wordCount,
    skipped: entry.skipped,
    createdMs: entry.createdMs,
  });
}

function cacheEntryOf(stat: BoardDocStat): BoardStatsCacheEntry {
  return Object.freeze({
    sha256: stat.sha256,
    title: stat.title,
    tags: stat.tags,
    wordCount: stat.wordCount,
    skipped: stat.skipped,
    createdMs: stat.createdMs,
  });
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

export async function buildBoardStats(
  options: BuildBoardStatsOptions,
): Promise<BoardStatsBuildResult> {
  const { docs, read, storage, vaultId, signal } = options;
  const cacheEnabled = storage !== undefined && vaultId !== undefined;

  const targetPaths = new Set(docs.map((doc) => doc.path));
  const cache = new Map<string, BoardStatsCacheEntry>();
  if (cacheEnabled) {
    for (const [path, entry] of loadStatsCache(storage, vaultId)) {
      if (targetPaths.has(path)) cache.set(path, entry);
    }
  }

  // 用函数读取取消状态，避免控制流收窄把 signal.aborted 固化为 false。
  const isAborted = (): boolean => signal?.aborted === true;

  const total = docs.length;
  const slots = new Array<BoardDocStat | undefined>(total);
  const failures: BoardStatsFailure[] = [];
  let cancelled = isAborted();
  let done = 0;
  let fromCache = 0;

  const report = (): void => {
    options.onProgress?.({
      done,
      total,
      failed: failures.length,
      skipped: slots.filter((slot) => slot?.skipped === true).length,
      fromCache,
    });
  };

  if (total === 0) {
    return { stats: [], failures, cancelled };
  }

  const requested = Math.floor(options.concurrency ?? BOARD_STATS_CONCURRENCY);
  const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Number.isFinite(requested) ? requested : 1));
  let next = 0;

  const finish = (): void => {
    if (cacheEnabled) saveStatsCache(storage, vaultId, cache);
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (cancelled || isAborted()) {
        cancelled = true;
        return;
      }
      const index = next;
      next += 1;
      if (index >= total) return;
      const target = docs[index];
      if (target === undefined) return;

      const cached = cache.get(target.path);
      if (cached !== undefined && cached.sha256 === target.sha256) {
        slots[index] = statFromCache(target, cached);
        done += 1;
        fromCache += 1;
        report();
        continue;
      }

      let stat: BoardDocStat;
      if (target.bytes > MAX_STAT_BYTES) {
        stat = parseDocStat({ ...target, text: '' });
        cache.set(target.path, cacheEntryOf(stat));
      } else {
        try {
          const readResult = await read(target.path);
          if (cancelled || isAborted()) {
            cancelled = true;
            return;
          }
          const sha256 = readResult.sha256 === '' ? target.sha256 : readResult.sha256;
          stat = parseDocStat({
            path: target.path,
            sha256,
            bytes: target.bytes,
            modifiedMs: target.modifiedMs,
            text: readResult.text,
          });
          cache.set(target.path, cacheEntryOf(stat));
        } catch (error) {
          if (isAborted() || isAbortError(error)) {
            cancelled = true;
            return;
          }
          failures.push({
            path: target.path,
            reason: formatUnknownError(error, '读取失败'),
          });
          done += 1;
          report();
          continue;
        }
      }

      slots[index] = stat;
      done += 1;
      report();
    }
  };

  try {
    await Promise.all(Array.from({ length: concurrency }, worker));
  } finally {
    if (!cancelled) finish();
  }

  const stats: BoardDocStat[] = [];
  for (const slot of slots) {
    if (slot !== undefined) stats.push(slot);
  }
  return { stats, failures, cancelled };
}
