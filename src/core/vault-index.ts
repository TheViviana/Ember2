/**
 * 库索引：`vault_scan` 全量快照 + `vault://file-changed` 增量补丁。
 *
 * - 索引是纯数据：本模块不 invoke、不订阅、不摸定时器，全部输入由调用方传入；
 * - `docs` 只保存元数据（路径 / 大小 / 哈希 / 修改时间），正文缓存是打开文档后的事；
 * - 索引只产出 `docs`；UI 目录树由 app/tree/build-tree.ts 从 `docs` 派生；
 * - 变更先按 path 去重（同批只保留最后一条）；路径过滤完全由 Rust 扫描与 watcher 负责；
 * - 无实际差异时返回同一个快照引用，调用方据此决定是否通知订阅者。
 */
import type { FileChangeDto, ScanDocDto } from '../types/ipc.ts';

export interface DocMeta {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly modifiedMs: number;
}

export interface VaultIndexSnapshot {
  readonly docs: ReadonlyMap<string, DocMeta>;
}

export interface IndexUpdate {
  readonly snapshot: VaultIndexSnapshot;
  /** false 表示整批变更对索引无损，调用方不应发通知。 */
  readonly changed: boolean;
}

/** 从扫描结果建立索引；重复路径由后出现的条目覆盖（scan 本应已去重）。 */
export function createIndex(entries: readonly ScanDocDto[]): VaultIndexSnapshot {
  const docs = new Map<string, DocMeta>();
  for (const entry of entries) {
    docs.set(entry.path, {
      path: entry.path,
      bytes: entry.bytes,
      sha256: entry.sha256,
      modifiedMs: entry.modifiedMs,
    });
  }
  return Object.freeze({ docs });
}

/** 应用一批 `vault://file-changed`；同一批内同一路径只保留最后一条。 */
export function applyFileChanges(
  index: VaultIndexSnapshot,
  changes: readonly FileChangeDto[],
): IndexUpdate {
  if (changes.length === 0) return { snapshot: index, changed: false };

  const deduped = new Map<string, FileChangeDto>();
  for (const change of changes) deduped.set(change.path, change);

  const docs = new Map(index.docs);
  let changed = false;

  for (const change of deduped.values()) {
    switch (change.kind) {
      case 'created':
      case 'updated': {
        const meta = metaFromChange(change, docs.get(change.path));
        if (meta && setIfChanged(docs, meta)) changed = true;
        break;
      }
      case 'removed': {
        if (docs.delete(change.path)) changed = true;
        break;
      }
      case 'renamed': {
        const from = change.from;
        const previous = from === undefined ? undefined : docs.get(from);
        if (from !== undefined && docs.delete(from)) changed = true;
        const meta = metaFromChange(change, previous);
        if (meta && setIfChanged(docs, meta)) changed = true;
        break;
      }
    }
  }

  if (!changed) return { snapshot: index, changed: false };
  return { snapshot: Object.freeze({ docs }), changed: true };
}

/** `bytes` / `modifiedMs` 缺失时沿用旧值，避免把不完整事件写成元数据。 */
function metaFromChange(change: FileChangeDto, previous: DocMeta | undefined): DocMeta | null {
  const sha256 = change.sha256;
  if (sha256 === undefined) return null;
  return {
    path: change.path,
    bytes: change.bytes ?? previous?.bytes ?? 0,
    sha256,
    modifiedMs: change.modifiedMs ?? previous?.modifiedMs ?? 0,
  };
}

function setIfChanged(docs: Map<string, DocMeta>, meta: DocMeta): boolean {
  const previous = docs.get(meta.path);
  if (previous && sameMeta(previous, meta)) return false;
  docs.set(meta.path, meta);
  return true;
}

function sameMeta(a: DocMeta, b: DocMeta): boolean {
  return a.bytes === b.bytes && a.sha256 === b.sha256 && a.modifiedMs === b.modifiedMs;
}
