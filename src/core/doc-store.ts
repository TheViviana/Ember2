/**
 * 文档状态与冲突矩阵（PLAN §6 P2 doc-store，≤400 行）。
 *
 * 铁律：
 * - 外部事件路径（handleChanges）只做内存迁移与只读 vault_read，永不发起 vault_write；
 * - 写盘一律走 writer 的单写队列；本模块只决定“写什么、何时写、冲突时怎么办”；
 * - 一切等待都经注入的 Clock.wait，内核不直接摸 setTimeout。
 *
 * 冲突矩阵：
 * - 未打开：只更新索引（core 负责），这里直接忽略；
 * - 打开且 clean：自动重读一次；
 * - 打开且 dirty / saving：只标记 externalChange，绝不覆盖正文；
 * - removed + clean：关闭文档；dirty：标记 removed；
 * - renamed：迁移打开的文档（目标也打开时保留目标）；
 * - 同批按 path 去重，后出现的覆盖前面的；
 * - 事件 sha 命中 baseSha / recentSelfWrites / 在飞写入结果 → 回声，忽略。
 */
import type { FileChangeDto, ReadDocDto } from '../types/ipc.ts';
import { conflictStamp, createConflictResolver, makeExternal } from './conflict.ts';
import { migrateDocumentPath } from './doc-migrate.ts';
import {
  isDirty,
  makeDoc,
  toState,
  type DocState,
  type DocStore,
  type DocStoreOptions,
  type MutableDoc,
  type ReloadTarget,
  type SaveOutcome,
} from './doc-state.ts';
import { EmberIpcError, ipcFailure, toIpcError } from './errors.ts';
import { posixParentDir } from './path-utils.ts';
import { createSlice, type Slice } from './store.ts';
import { createWriter, type WriteOutcome, type WriteRequest, type Writer } from './writer.ts';

export type { ExternalChange } from './conflict.ts';
export type {
  ConflictChoice,
  DocState,
  DocStore,
  DocStoreOptions,
  SaveOutcome,
} from './doc-state.ts';

function failure(error: EmberIpcError): SaveOutcome {
  return { ok: false, error, conflict: null };
}

export interface PathResolvingDocStore extends DocStore {
  handleChanges(
    changes: readonly FileChangeDto[],
    isIndexed?: (path: string) => boolean,
  ): void;
  waitForReloads(paths: readonly string[]): Promise<void>;
  resolveDocPath(from: string): string | null;
}

interface InferredRenames {
  readonly renamed: FileChangeDto[];
  readonly consumedPaths: ReadonlySet<string>;
}

/**
 * macOS 单端事件兜底：仅为已打开文档配对唯一的、尚未入索引的 created。
 *
 * 必须 fail closed：删除 A 与新建无关文件 C 可能出现在同一事件批里，仅凭
 * 「唯一 created」合成 renamed 会把编辑器绑定到错误路径。因此额外要求
 * 同目录且 content sha 等于文档的 baseSha（改名不改内容）；不满足就按
 * 「删除 + 新建」处理，dirty 文档走删除冲突，由用户裁决。
 */
function inferRenames(
  changes: readonly FileChangeDto[],
  docs: ReadonlyMap<string, MutableDoc>,
  isIndexed: (path: string) => boolean,
): InferredRenames {
  const created = changes.filter(
    (change) => change.kind === 'created' && !isIndexed(change.path),
  );
  const proposed: { readonly from: string; readonly created: FileChangeDto }[] = [];
  for (const removed of changes) {
    if (removed.kind !== 'removed') continue;
    const doc = docs.get(removed.path);
    if (!doc) continue;
    const candidates = created.filter(
      (change) =>
        change.path !== removed.path &&
        posixParentDir(change.path) === posixParentDir(removed.path) &&
        change.sha256 !== undefined &&
        change.sha256 === doc.baseSha,
    );
    const target = candidates.length === 1 ? candidates[0] : undefined;
    if (target) proposed.push({ from: removed.path, created: target });
  }

  // 同一个 created 不能同时充当多个 removed 的改名终点。
  const targetCounts = new Map<string, number>();
  for (const pair of proposed) {
    targetCounts.set(pair.created.path, (targetCounts.get(pair.created.path) ?? 0) + 1);
  }
  const renamed: FileChangeDto[] = [];
  const consumedPaths = new Set<string>();
  for (const pair of proposed) {
    if (targetCounts.get(pair.created.path) !== 1) continue;
    renamed.push({ ...pair.created, kind: 'renamed', from: pair.from });
    consumedPaths.add(pair.from);
    consumedPaths.add(pair.created.path);
  }
  return { renamed, consumedPaths };
}

export function createDocStore(options: DocStoreOptions): PathResolvingDocStore {
  const { vault, clock } = options;
  const docs = new Map<string, MutableDoc>();
  const aliases = new Map<string, string>();
  const slice: Slice<ReadonlyMap<string, DocState>> = createSlice<ReadonlyMap<string, DocState>>(
    new Map(),
  );
  const opening = new Map<string, Promise<DocState>>();
  const pendingReloads = new Map<MutableDoc, Promise<void>>();
  let disposed = false;

  const writer: Writer = createWriter({
    vault,
    clock,
    ttlMs: options.selfWriteTtlMs,
    onSelfWrite: options.onSelfWrite,
    redirectError: (path) => {
      const doc = docs.get(path);
      return doc?.external
        ? ipcFailure('vault_write', 'E_INVALID_ARG', 'redirect target has an external change')
        : null;
    },
    onError: options.onError,
  });

  function publish(): void {
    const next = new Map<string, DocState>();
    for (const [path, doc] of docs) next.set(path, toState(doc));
    slice.set(next);
  }

  // ------------------------------------------------------------- 状态迁移

  function closeDoc(path: string): void {
    const doc = docs.get(path);
    if (!doc) return;
    doc.saveGeneration += 1;
    doc.reloadTarget = null;
    docs.delete(path);
    publish();
  }

  function migrate(from: string, to: string): void {
    const doc = migrateDocumentPath(docs, from, to, aliases);
    writer.rekey(from, to);
    if (doc) publish();
  }

  function clearConflictCopy(doc: MutableDoc): void {
    doc.conflictCopy = null;
    doc.conflictCopyFor = null;
    doc.conflictCopyFailed = false;
  }

  /**
   * 冲突副本只存一次：按外部 sha（删除用 `removed`）去重。
   * 快照是「冲突发生那一刻」的草稿；失败不阻断裁决，但必须让用户知道没存成。
   */
  function noteConflict(doc: MutableDoc, key: string): void {
    if (disposed || doc.conflictCopyFor === key) return;
    doc.conflictCopy = null;
    doc.conflictCopyFailed = false;
    doc.conflictCopyFor = key;
    const text = doc.text;
    const stamp = conflictStamp(clock.now());
    void (async () => {
      try {
        const copy = await vault.saveConflictCopy(doc.path, text, stamp);
        if (disposed || docs.get(doc.path) !== doc || doc.conflictCopyFor !== key) return;
        doc.conflictCopy = copy;
        publish();
      } catch (error) {
        if (disposed || docs.get(doc.path) !== doc || doc.conflictCopyFor !== key) return;
        doc.conflictCopyFailed = true;
        publish();
        console.warn('[ember] 冲突副本保存失败', doc.path, error);
      }
    })();
  }

  function markExternal(doc: MutableDoc, target: ReloadTarget): void {
    doc.external = makeExternal('updated', target.sha256, target.bytes, target.modifiedMs);
    noteConflict(doc, target.sha256);
    publish();
  }

  // ----------------------------------------------------------- 外部变更

  function scheduleReload(doc: MutableDoc, target: ReloadTarget): void {
    doc.reloadTarget = target;
    if (doc.reloadRunning) return;
    doc.reloadRunning = true;
    const task = (async () => {
      try {
        while (!disposed) {
          const currentTarget = doc.reloadTarget;
          if (!currentTarget) break;
          doc.reloadTarget = null;
          if (docs.get(doc.path) !== doc) break;
          if (isDirty(doc) || doc.saving) {
            markExternal(doc, currentTarget);
            continue;
          }
          try {
            const read = await vault.read(doc.path);
            const current = await vault.stat(doc.path);
            if (disposed || docs.get(doc.path) !== doc) break;
            if (isDirty(doc) || doc.saving) {
              markExternal(doc, current);
              continue;
            }
            if (read.sha256 !== currentTarget.sha256 || current.sha256 !== currentTarget.sha256) {
              markExternal(doc, current);
              continue;
            }
            doc.text = read.text;
            doc.baseText = read.text;
            doc.baseSha = read.sha256;
            doc.external = null;
            clearConflictCopy(doc);
            doc.error = null;
            publish();
          } catch (rejection) {
            if (disposed || docs.get(doc.path) !== doc) break;
            const error = toIpcError('vault_read', rejection);
            if (error.code === 'E_NOT_FOUND' && !isDirty(doc)) {
              closeDoc(doc.path);
              break;
            }
            doc.error = error;
            publish();
            options.onError(error);
          }
        }
      } finally {
        doc.reloadRunning = false;
      }
    })();
    pendingReloads.set(doc, task);
    const settled = (): void => {
      if (pendingReloads.get(doc) === task) pendingReloads.delete(doc);
    };
    void task.then(settled, settled);
  }

  function applyChange(doc: MutableDoc, change: FileChangeDto): void {
    if (change.kind === 'removed') {
      if (isDirty(doc)) {
        doc.external = makeExternal('removed', null, null, null);
        noteConflict(doc, 'removed');
        publish();
      } else {
        closeDoc(doc.path);
      }
      return;
    }
    const sha256 = change.sha256;
    if (sha256 === undefined) return;
    if (sha256 === doc.baseSha) {
      // 磁盘回到已知版本：此前的冲突标记自动解除。
      if (doc.external) {
        doc.external = null;
        clearConflictCopy(doc);
        publish();
      }
      return;
    }
    if (writer.consumeSelf(doc.path, sha256)) return;
    const target: ReloadTarget = {
      sha256,
      bytes: change.bytes ?? null,
      modifiedMs: change.modifiedMs ?? null,
    };
    if (isDirty(doc) || doc.saving) {
      markExternal(doc, target);
      return;
    }
    scheduleReload(doc, target);
  }

  function handleChanges(
    changes: readonly FileChangeDto[],
    isIndexed: (path: string) => boolean = () => false,
  ): void {
    if (disposed || docs.size === 0) return;
    const deduped = new Map<string, FileChangeDto>();
    for (const change of changes) deduped.set(change.path, change);
    const batch = [...deduped.values()];
    const inferred = inferRenames(batch, docs, isIndexed);
    // 所有 renamed（含合成）先于 removed，避免 clean 文档被提前关闭。
    const ordered = [
      ...batch.filter((change) => change.kind === 'renamed'),
      ...inferred.renamed,
      ...batch.filter(
        (change) => change.kind !== 'renamed' && !inferred.consumedPaths.has(change.path),
      ),
    ];
    for (const change of ordered) {
      if (change.kind === 'renamed' && change.from !== undefined) {
        migrate(change.from, change.path);
      }
      const doc = docs.get(change.path);
      if (!doc) continue;
      if (
        writer.isInFlight(change.path) &&
        (change.kind === 'created' || change.kind === 'updated')
      ) {
        // 可能是自己写入的回声；等写盘结果出来再对比 sha。
        doc.pendingExternal = change;
        continue;
      }
      applyChange(doc, change);
    }
  }

  async function waitForReloads(paths: readonly string[]): Promise<void> {
    const waiting = new Set<Promise<void>>();
    for (const path of paths) {
      const doc = docs.get(path);
      const reload = doc ? pendingReloads.get(doc) : undefined;
      if (reload) waiting.add(reload);
    }
    await Promise.all(waiting);
  }

  // --------------------------------------------------------------- 写盘

  function settleWrite(doc: MutableDoc, outcome: WriteOutcome, writtenText: string | null): void {
    if (disposed) return;
    const current = docs.get(doc.path) === doc;
    if (outcome.ok) {
      if (writtenText !== null) {
        doc.baseText = writtenText;
        doc.baseSha = outcome.sha256;
      }
      if (!current) return;
      doc.saving = false;
      doc.error = null;
      const deferred = doc.pendingExternal;
      doc.pendingExternal = null;
      // 结束写盘后才知道自己写出的 sha：一致的 deferred 就是回声。
      if (deferred && writtenText !== null) {
        if (deferred.kind === 'removed' || deferred.sha256 !== outcome.sha256) {
          applyChange(doc, deferred);
        }
      }
      publish();
      return;
    }
    if (!current) return;
    doc.saving = false;
    doc.error = outcome.error;
    const deferred = doc.pendingExternal;
    doc.pendingExternal = null;
    if (deferred) applyChange(doc, deferred);
    if (outcome.conflict) {
      doc.external = outcome.conflict;
      noteConflict(doc, outcome.conflict.sha256 ?? 'removed');
    }
    publish();
  }

  function makeRequest(doc: MutableDoc): WriteRequest {
    return {
      latestText: () => doc.text,
      onStarted: () => {
        if (disposed || docs.get(doc.path) !== doc) return;
        doc.saving = true;
        publish();
      },
      onSettled: (outcome, writtenText) => {
        settleWrite(doc, outcome, writtenText);
      },
    };
  }

  function requestSave(
    path: string, force: boolean, allowExternal = false, expectedSha?: string | null,
  ): Promise<SaveOutcome> {
    if (disposed) {
      return Promise.resolve(failure(ipcFailure('vault_write', 'E_UNKNOWN', 'core is disposed')));
    }
    const doc = docs.get(path);
    if (!doc) {
      return Promise.resolve(
        failure(ipcFailure('vault_write', 'E_NOT_FOUND', `document is not open: ${path}`)),
      );
    }
    const locked = writer.lockedError();
    if (locked) {
      if (doc.error !== locked) {
        doc.error = locked;
        publish();
      }
      return Promise.resolve({ ok: false, error: locked, conflict: null });
    }
    if (doc.external && !allowExternal) {
      return Promise.resolve({
        ok: false,
        error: ipcFailure(
          'vault_write',
          'E_INVALID_ARG',
          'external change pending; resolve it first',
        ),
        conflict: doc.external,
      });
    }
    if (!force && doc.text === doc.baseText) {
      return Promise.resolve({ ok: true, sha256: doc.baseSha });
    }
    doc.saveGeneration += 1;
    return writer.submit(path, makeRequest(doc), force, expectedSha === undefined ? doc.baseSha : expectedSha);
  }

  function scheduleAutoSave(doc: MutableDoc): void {
    const generation = ++doc.saveGeneration;
    void (async () => {
      await clock.wait(options.autoSaveDelayMs);
      if (disposed) return;
      const current = docs.get(doc.path);
      if (!current || current !== doc || current.saveGeneration !== generation) return;
      if (!isDirty(current) || current.external || writer.lockedError()) return;
      void requestSave(current.path, false);
    })();
  }

  // ----------------------------------------------------------- 打开 / 编辑

  async function readAndStore(path: string): Promise<DocState> {
    let read: ReadDocDto;
    try {
      read = await vault.read(path);
    } catch (rejection) {
      throw rejection instanceof EmberIpcError ? rejection : toIpcError('vault_read', rejection);
    }
    if (disposed) throw ipcFailure('vault_read', 'E_UNKNOWN', 'core is disposed');
    const concurrent = docs.get(path);
    if (concurrent) return toState(concurrent);
    const doc = makeDoc(read);
    docs.set(path, doc);
    publish();
    return toState(doc);
  }

  async function open(path: string): Promise<DocState> {
    if (disposed) throw ipcFailure('vault_read', 'E_UNKNOWN', 'core is disposed');
    if (!options.isReady()) throw ipcFailure('vault_read', 'E_INVALID_ARG', 'core is not ready');
    const existing = docs.get(path);
    if (existing) return toState(existing);
    const runningOpen = opening.get(path);
    if (runningOpen) return runningOpen;
    const task = readAndStore(path);
    opening.set(path, task);
    try {
      return await task;
    } finally {
      if (opening.get(path) === task) opening.delete(path);
    }
  }

  function edit(path: string, text: string): void {
    const doc = docs.get(path);
    if (!doc || disposed || doc.text === text) return;
    doc.text = text;
    doc.error = null;
    scheduleAutoSave(doc);
    publish();
  }

  // --------------------------------------------------------------- 冲突裁决

  const conflictResolver = createConflictResolver({
    docs,
    vault,
    clock,
    writer,
    publish,
    requestSave,
    isDisposed: () => disposed,
  });

  // ------------------------------------------------------------ 生命周期

  /**
   * 关窗落盘：保存 → 等队列 → 重新收集。
   *
   * 入口只收集一次 dirty 会漏掉写盘期间的新输入：旧正文保存成功后，新正文
   * 可能仍在防抖窗口内，flush 已返回而窗口已关闭。这里最多三轮兜底；
   * 仍有 dirty 说明输入没有停下，抛错取消关窗而不是静默丢字。
   * 主修复是关窗期间锁住编辑器（`editor-lock-registry`），本循环只兜住
   * 锁定生效前与非 UI 路径产生的编辑。
   */
  const FLUSH_ROUNDS = 3;

  async function flush(): Promise<void> {
    for (let round = 0; round < FLUSH_ROUNDS; round += 1) {
      const saves: Promise<SaveOutcome>[] = [];
      for (const doc of docs.values()) {
        if (isDirty(doc)) saves.push(requestSave(doc.path, false));
      }
      await writer.flush();
      for (const outcome of await Promise.all(saves)) {
        if (!outcome.ok) throw outcome.error;
      }
      if (![...docs.values()].some(isDirty)) return;
    }
    throw ipcFailure(
      'vault_write',
      'E_INVALID_ARG',
      'document changed during flush; save and close again',
    );
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    writer.dispose();
    opening.clear();
    pendingReloads.clear();
    docs.clear();
    aliases.clear();
    slice.set(new Map());
  }

  return {
    snapshot: () => slice.getSnapshot(),
    subscribe: (listener) => slice.subscribe(listener),
    get: (path) => {
      const doc = docs.get(path);
      return doc ? toState(doc) : null;
    },
    resolveDocPath: (from) => (disposed ? null : (aliases.get(from) ?? null)),
    open,
    close: closeDoc,
    edit,
    save: (path) => requestSave(path, false),
    resolveExternal: (path, choice) => conflictResolver.resolveExternal(path, choice),
    handleChanges,
    waitForReloads,
    flush,
    dispose,
  };
}
