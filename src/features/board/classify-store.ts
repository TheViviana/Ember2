/**
 * CR-20261123-69 / S1：八维分类「旁路覆盖层」。
 *
 * 不写文档 frontmatter（避免每次分类触发历史版本与 watcher 事件），而是按库隔离
 * 存在 localStorage：`ember2:board:classify:v1:<vaultId>`。
 *
 * 键 = 文档相对路径，值 = { sha256, dimensions, updatedAt }：
 * - sha256 用于判断「分类后内容是否变化」，变化时保留维度但可标「需复核」；
 * - storage 可注入，便于单测与降级（读失败不影响看板其余数据）。
 */
import { normalizeDimensions, type BoardDimensionId } from './model.ts';

export const BOARD_CLASSIFY_STORAGE_PREFIX = 'ember2:board:classify:v1:';
export const BOARD_CLASSIFY_SCHEMA_VERSION = 1;

export function classifyStorageKey(vaultId: string): string {
  return `${BOARD_CLASSIFY_STORAGE_PREFIX}${vaultId}`;
}

export interface BoardClassifyEntry {
  readonly sha256: string;
  readonly dimensions: readonly BoardDimensionId[];
  readonly updatedAt: number;
}

export type BoardClassifyMap = ReadonlyMap<string, BoardClassifyEntry>;

export interface ClassifyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface LoadedClassifications {
  readonly map: BoardClassifyMap;
  /** 覆盖层整体损坏或含无效条目时的用户提示；正常为 null。 */
  readonly warning: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEntry(value: unknown): BoardClassifyEntry | null {
  if (!isRecord(value)) return null;
  const sha256 = value['sha256'];
  const updatedAt = value['updatedAt'];
  const dimensions = value['dimensions'];
  if (typeof sha256 !== 'string') return null;
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null;
  if (!Array.isArray(dimensions)) return null;
  const normalized = normalizeDimensions(dimensions);
  if (normalized.length === 0) return null;
  return Object.freeze({
    sha256,
    dimensions: Object.freeze(normalized),
    updatedAt,
  });
}

export function loadClassifications(
  storage: ClassifyStorage,
  vaultId: string,
): LoadedClassifications {
  let raw: string | null;
  try {
    raw = storage.getItem(classifyStorageKey(vaultId));
  } catch {
    return { map: new Map(), warning: '分类覆盖层读取失败，本次按未分类显示' };
  }
  if (raw === null) return { map: new Map(), warning: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { map: new Map(), warning: '分类覆盖层无法解析，已忽略' };
  }
  if (!isRecord(parsed) || parsed['version'] !== BOARD_CLASSIFY_SCHEMA_VERSION) {
    return { map: new Map(), warning: '分类覆盖层格式无效，已忽略' };
  }
  const items = parsed['items'];
  if (!isRecord(items)) {
    return { map: new Map(), warning: '分类覆盖层格式无效，已忽略' };
  }

  const map = new Map<string, BoardClassifyEntry>();
  let invalid = 0;
  for (const [path, value] of Object.entries(items)) {
    if (path === '') {
      invalid += 1;
      continue;
    }
    const entry = parseEntry(value);
    if (entry === null) {
      invalid += 1;
      continue;
    }
    map.set(path, entry);
  }
  return {
    map,
    warning: invalid === 0 ? null : `分类覆盖层含 ${invalid} 条无效记录，已忽略`,
  };
}

/** 保存整张表；返回 null 表示成功，否则为面向用户的错误提示。 */
export function saveClassifications(
  storage: ClassifyStorage,
  vaultId: string,
  map: BoardClassifyMap,
): string | null {
  const items: Record<string, BoardClassifyEntry> = {};
  for (const [path, entry] of map) {
    if (path === '' || entry.dimensions.length === 0) continue;
    items[path] = {
      sha256: entry.sha256,
      dimensions: entry.dimensions,
      updatedAt: entry.updatedAt,
    };
  }
  try {
    storage.setItem(
      classifyStorageKey(vaultId),
      JSON.stringify({ version: BOARD_CLASSIFY_SCHEMA_VERSION, items }),
    );
    return null;
  } catch {
    return '分类覆盖层保存失败，本次更改未持久化';
  }
}

/** 写入 / 覆盖单个文档的分类；空维度等于删除。返回新表，不改入参。 */
export function setBoardClassification(
  map: BoardClassifyMap,
  path: string,
  sha256: string,
  dimensions: readonly BoardDimensionId[],
  updatedAt: number,
): BoardClassifyMap {
  const next = new Map(map);
  const normalized = normalizeDimensions(dimensions);
  if (path === '' || normalized.length === 0) {
    next.delete(path);
    return next;
  }
  next.set(path, { sha256, dimensions: Object.freeze(normalized), updatedAt });
  return next;
}

export function removeBoardClassification(
  map: BoardClassifyMap,
  path: string,
): BoardClassifyMap {
  if (!map.has(path)) return map;
  const next = new Map(map);
  next.delete(path);
  return next;
}

/** 文档内容已变化（sha 不一致）→ 维度保留但提示复核。 */
export function classificationNeedsReview(
  entry: BoardClassifyEntry,
  currentSha256: string,
): boolean {
  return entry.sha256 !== '' && entry.sha256 !== currentSha256;
}

/** 转成 buildBoardMetrics 需要的 path → dimensions 查表（不带 sha）。 */
export function toDimensionLookup(
  map: BoardClassifyMap,
): ReadonlyMap<string, readonly BoardDimensionId[]> {
  const lookup = new Map<string, readonly BoardDimensionId[]>();
  for (const [path, entry] of map) {
    if (entry.dimensions.length > 0) lookup.set(path, entry.dimensions);
  }
  return lookup;
}
