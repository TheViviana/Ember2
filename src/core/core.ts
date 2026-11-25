/**
 * EmberCore：前端内核的唯一实例入口。
 *
 * 生命周期：idle → starting → ready | failed；dispose() 之后一切操作变为 no-op。
 * - 快照只读，UI 通过 subscribe 获取；
 * - 事件（core:ready / core:error / core:disposed）与快照分离，便于日志与 toast；
 * - 启动失败不自动重试，交由上层显式重建实例。
 *
 * core 不直接 invoke、不直接 listen：依赖全部由 `EmberCoreOptions` 注入（I11）。
 */
import type {
  FileChangeDto,
  FileChangedDto,
  ScanDocDto,
  VaultConstantsDto,
  VaultIdentityDto,
  WriteDocDto,
} from '../types/ipc.ts';
import type { CanvasFlushReport, CanvasPort, CanvasStore } from './canvas/ports.ts';
import { createCanvasStore } from './canvas/store.ts';
import {
  createDocStore,
  type ConflictChoice,
  type DocState,
  type PathResolvingDocStore,
  type SaveOutcome,
} from './doc-store.ts';
import { EmberIpcError, ipcFailure, toIpcError } from './errors.ts';
import {
  createEventBus,
  type CoreEvent,
  type EventBus,
} from './events.ts';
import type { Clock, EventPort, Unsubscribe, VaultPort } from './ports.ts';
import { EXPECT_MISSING_SHA } from './ports.ts';
import { createSlice, type Slice } from './store.ts';
import { applyFileChanges, createIndex, type VaultIndexSnapshot } from './vault-index.ts';

export type CoreStatus = 'idle' | 'starting' | 'ready' | 'failed' | 'disposed';

export interface CoreSnapshot {
  readonly status: CoreStatus;
  readonly identity: VaultIdentityDto | null;
  readonly constants: VaultConstantsDto | null;
  readonly lastError: EmberIpcError | null;
}

export interface EmberCoreOptions {
  readonly vault: VaultPort;
  readonly events: EventPort;
  /** C3 写队列与防抖使用；在此注入以保证内核永不直接摸真实定时器。 */
  readonly clock: Clock;
  /** 编辑后自动保存的防抖窗口；缺省 1000 ms（前端策略，不是 Rust 常量）。 */
  readonly autoSaveDelayMs?: number;
  /**
   * 画布端口（提交 4 / H3）：**可选**，缺省时挂载禁用态 store。
   * 追加可选字段不改变 `createEmberCore` 签名，既有调用零改动。
   */
  readonly canvas?: CanvasPort;
}

/** CR-20261119-08：文档库新建入口的判别返回。只返回结果，不抛错。 */
export type CreateDocReason =
  | 'EXISTS'
  | 'PATH_ABSOLUTE'
  | 'PATH_ESCAPE'
  | 'PATH_HIDDEN'
  | 'PATH_EMPTY'
  | 'PATH_EXT'
  | 'IO'
  | 'READONLY'
  | 'VAULT_LOCKED'
  | 'LOCK_LOST'
  | 'PATH_ESCAPE_VAULT'
  | 'BAD_REQUEST';

export type CreateDocResult =
  | { ok: true; rel: string }
  | { ok: false; reason: CreateDocReason; message: string };

/** CR-R3-1a：带外写盘结果。只返回判别结果，不抛错；绕过 writer 队列（同 createDoc）。 */
export type WriteDocTextResult =
  | { readonly ok: true; readonly write: WriteDocDto }
  | { readonly ok: false; readonly reason: 'dirty' }
  | { readonly ok: false; readonly reason: 'conflict' | 'io'; readonly error: EmberIpcError };

export interface EmberCore {
  getSnapshot(): CoreSnapshot;
  subscribe(listener: (snapshot: CoreSnapshot) => void): Unsubscribe;
  /** 库索引快照；启动完成后才有内容，之后随 `vault://file-changed` 增量更新。 */
  getIndex(): VaultIndexSnapshot;
  subscribeIndex(listener: (index: VaultIndexSnapshot) => void): Unsubscribe;
  /** 已打开文档的快照（正文已含乐观更新）。 */
  getDocuments(): ReadonlyMap<string, DocState>;
  subscribeDocuments(listener: (docs: ReadonlyMap<string, DocState>) => void): Unsubscribe;
  getDocument(path: string): DocState | null;
  /** 外部改名后的路径别名；未知、未迁移或 disposed 后返回 null。 */
  resolveDocPath(from: string): string | null;
  openDoc(path: string): Promise<DocState>;
  closeDoc(path: string): void;
  editDoc(path: string, text: string): void;
  saveDoc(path: string): Promise<SaveOutcome>;
  /** 冲突裁决：reload 丢弃本地重读；overwrite 先把外部内容写成冲突副本再覆盖。 */
  resolveDocConflict(path: string, choice: ConflictChoice): Promise<DocState>;
  /** 等写队列排空（关窗 flush / 测试）。 */
  flushDocs(): Promise<void>;
  /** 带外写后按磁盘当前状态对齐索引与已打开文档；干净文档等待 reload 完成。 */
  reconcilePaths(paths: readonly string[]): Promise<void>;
  /** CR-20261119-08：create-only 新建 `.md`。只返回判别结果，不抛错；绕过 writer 队列。 */
  createDoc(rel: string): Promise<CreateDocResult>;
  /**
   * CR-R3-1a：带外写盘入口。已打开且 dirty / saving 时拒写（不触盘）；
   * 成功后 handleSelfWrite 同步索引，已打开文档经 reconcilePaths 重读。
   */
  writeDocText(path: string, text: string, expectedSha: string): Promise<WriteDocTextResult>;
  /**
   * 画布读写入口。恒非 null：未注入 `CanvasPort` 时为禁用态 store
   * （`save` / `open` / `list` 返回 `E_INVALID_ARG`，`flush` 立即 `ok:true`）。
   */
  readonly canvas: CanvasStore;
  readonly events: EventBus<CoreEvent>;
  /** 幂等：并发 / 重复调用复用同一次启动。 */
  start(): Promise<void>;
  /** 幂等：退订全部事件并进入 disposed。 */
  dispose(): void;
}

const INITIAL_SNAPSHOT: CoreSnapshot = Object.freeze({
  status: 'idle',
  identity: null,
  constants: null,
  lastError: null,
});

function normalizeReconcilePath(path: string): string {
  const slashed = path.replace(/\\/g, '/');
  const rooted = slashed.startsWith('/');
  const segments: string[] = [];
  for (const segment of slashed.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..' && segments.length > 0 && segments[segments.length - 1] !== '..') {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return `${rooted ? '/' : ''}${segments.join('/')}`;
}

/**
 * 禁用态画布 store（未注入 `CanvasPort`）：所有读写入口返回 `E_INVALID_ARG`。
 *
 * `flush` 立即返回 `ok:true` + 空 `results` / `pendingIds`，语义是
 * 「画布功能未启用，无待保存内容」，**不表示**「已排空真实队列」；
 * 关窗接线不得据此宣称画布已安全落盘。
 */
function createDisabledCanvasStore(): CanvasStore {
  function disabled(command: string, id?: string): Promise<never> {
    return Promise.reject(
      ipcFailure(
        command,
        'E_INVALID_ARG',
        id === undefined ? 'canvas is not enabled' : `canvas is not enabled: ${id}`,
      ),
    );
  }

  return {
    list: () => disabled('list_canvases'),
    open: (id) => disabled('canvas_read', id),
    save: (id, _text, _options) => disabled('canvas_write', id),
    beginClosing: () => undefined,
    cancelClosing: () => undefined,
    flush: () =>
      Promise.resolve<CanvasFlushReport>({
        ok: true,
        timedOut: false,
        error: null,
        results: [],
        pendingIds: [],
      }),
  };
}

export function createEmberCore(options: EmberCoreOptions): EmberCore {
  const { vault, events } = options;
  const slice: Slice<CoreSnapshot> = createSlice(INITIAL_SNAPSHOT);
  const indexSlice: Slice<VaultIndexSnapshot> = createSlice(createIndex([]));
  const bus: EventBus<CoreEvent> = createEventBus<CoreEvent>();
  const subscriptions = new Set<Unsubscribe>();
  let startPromise: Promise<void> | null = null;
  /** scan 期间只缓冲，全量索引建立后按到达顺序回放。 */
  let fileChangeBuffer: FileChangedDto[] | null = null;

  /** 自写落盘后同步索引：Rust 侧会抑制对应的 watcher 事件，索引不能等事件。 */
  function handleSelfWrite(write: WriteDocDto): void {
    if (isDisposed()) return;
    const update = applyFileChanges(indexSlice.getSnapshot(), [
      {
        kind: 'updated',
        path: write.path,
        bytes: write.bytes,
        sha256: write.sha256,
        modifiedMs: options.clock.now(),
      },
    ]);
    if (update.changed) indexSlice.set(update.snapshot);
  }

  /** CR-20261119-08：IPC → CreateDocReason 映射。只在 createDoc 内部使用。 */
  function mapIpcError(rejection: unknown): CreateDocResult {
    const err = rejection instanceof EmberIpcError ? rejection : toIpcError('vault_write', rejection);
    const msg = err.message;
    switch (err.code) {
      case 'E_VAULT_LOCKED':
        return { ok: false, reason: 'VAULT_LOCKED', message: '知识库被其他进程占用，请关闭后重试' };
      case 'E_READONLY':
        return { ok: false, reason: 'READONLY', message: '知识库当前为只读状态' };
      case 'E_LOCK_LOST':
        return { ok: false, reason: 'LOCK_LOST', message: '与知识库的连接已中断' };
      case 'E_PATH_ESCAPE':
      case 'E_RESERVED_PATH':
        return { ok: false, reason: 'PATH_ESCAPE_VAULT', message: '路径越出知识库边界' };
      case 'E_PERM':
      case 'E_DISK_FULL':
      case 'E_TOO_LARGE':
      case 'E_IO':
      case 'E_ENCODING':
      case 'E_MEDIA_TYPE':
      case 'E_MEDIA_TOO_LARGE':
      case 'E_TRASH_FAILED':
        return { ok: false, reason: 'IO', message: `新建失败：${msg}` };
      default:
        return { ok: false, reason: 'BAD_REQUEST', message: `新建失败：${msg}` };
    }
  }

  /**
   * CR-20261119-08：create-only 新建 `.md`。直接调 vault_write expectedSha:''，绕过 writer 队列。
   * 两步防护：stat 预检腿 + 写入失败后二次 stat 兜底腿；并发由三重兜底覆盖。
   * 只返回判别结果，不抛错。索引在闭包内同步更新，对外经 indexSlice.getSnapshot/subscribe 观察。
   * modifiedMs 必须来自 vault.stat 精确值——stat 失败时直接返回 IO 错误，不用 clock.now 兜底。
   */
  async function createDoc(rel: string): Promise<CreateDocResult> {
    if (isDisposed()) {
      return { ok: false, reason: 'BAD_REQUEST', message: '内核已关闭，无法新建文档' };
    }

    // 预检腿：stat 成功即已存在；E_NOT_FOUND 继续到 write；其他错误映射。
    try {
      await vault.stat(rel);
      return { ok: false, reason: 'EXISTS', message: '文件已存在，请换一个名字' };
    } catch (rejection) {
      const ie = rejection instanceof EmberIpcError ? rejection : toIpcError('vault_stat', rejection);
      if (ie.code !== 'E_NOT_FOUND') {
        return mapIpcError(ie);
      }
    }

    // 写入：expectedSha='' = create-only；并发由三重兜底（stat 预检 + expectedSha + 兜底腿 stat）覆盖。
    let writeResult: WriteDocDto;
    try {
      writeResult = await vault.write(rel, '', EXPECT_MISSING_SHA);
    } catch (rejection) {
      const ie = rejection instanceof EmberIpcError ? rejection : toIpcError('vault_write', rejection);
      if (ie.code === 'E_INVALID_ARG') {
        // 兜底腿：竞态窗口内外部已创建，二次 stat 命中则翻转为 EXISTS。
        try {
          await vault.stat(rel);
          return { ok: false, reason: 'EXISTS', message: '文件已存在，请换一个名字' };
        } catch (statRejection) {
          // 双重异常：write 冲突 + stat 也失败；emit 让上层可见，再按原始 write 错误返回
          if (!isDisposed()) {
            bus.emit({
              type: 'core:error',
              error: statRejection instanceof EmberIpcError ? statRejection : toIpcError('vault_stat', statRejection),
            });
          }
        }
        return mapIpcError(ie);
      }
      return mapIpcError(ie);
    }

    // 写入成功：vault.stat 取 FS 精确 modifiedMs（不回退 clock.now——stat 失败即 IO 错误）。
    let modifiedMs: number;
    try {
      modifiedMs = (await vault.stat(rel)).modifiedMs;
    } catch (rejection) {
      const ie = rejection instanceof EmberIpcError ? rejection : toIpcError('vault_stat', rejection);
      if (!isDisposed()) {
        bus.emit({ type: 'core:error', error: ie });
      }
      return mapIpcError(ie);
    }

    const update = applyFileChanges(indexSlice.getSnapshot(), [
      {
        kind: 'created',
        path: writeResult.path,
        bytes: writeResult.bytes,
        sha256: writeResult.sha256,
        modifiedMs,
      },
    ]);
    if (update.changed) indexSlice.set(update.snapshot);

    return { ok: true, rel };
  }

  const docStore: PathResolvingDocStore = createDocStore({
    vault,
    clock: options.clock,
    autoSaveDelayMs: options.autoSaveDelayMs ?? 1000,
    isReady: () => slice.getSnapshot().status === 'ready',
    selfWriteTtlMs: () => {
      const constants = slice.getSnapshot().constants;
      return constants ? constants.watcherDebounceMs * 2 : 0;
    },
    onSelfWrite: handleSelfWrite,
    onError: (error) => {
      if (!isDisposed()) bus.emit({ type: 'core:error', error });
    },
  });

  /** 注入端口时建立真实队列；缺省挂禁用态 store，`core.canvas` 恒非 null（H3）。 */
  const canvasStore: CanvasStore =
    options.canvas === undefined
      ? createDisabledCanvasStore()
      : createCanvasStore({ port: options.canvas, clock: options.clock });

  function isDisposed(): boolean {
    return slice.getSnapshot().status === 'disposed';
  }

  function track(unsubscribe: Unsubscribe): void {
    if (isDisposed()) {
      unsubscribe();
      return;
    }
    subscriptions.add(unsubscribe);
  }

  function fail(command: string, rejection: unknown): void {
    if (isDisposed()) return;
    const error = rejection instanceof EmberIpcError ? rejection : toIpcError(command, rejection);
    slice.set({ status: 'failed', identity: null, constants: null, lastError: error });
    bus.emit({ type: 'core:error', error });
  }

  function applyFileChanged(payload: FileChangedDto): void {
    // 配对推断必须查询变更前索引；索引本身仍先于文档状态发布更新。
    const previousIndex = indexSlice.getSnapshot();
    const update = applyFileChanges(previousIndex, payload.changes);
    if (update.changed) indexSlice.set(update.snapshot);
    // 文档侧只做内存迁移与只读重读，绝不在此发起写盘。
    docStore.handleChanges(payload.changes, (path) => previousIndex.docs.has(path));
  }

  async function reconcilePaths(input: readonly string[]): Promise<void> {
    if (isDisposed()) return;
    const paths = [...new Set(input.map(normalizeReconcilePath).filter((path) => path !== ''))];
    const changes: FileChangeDto[] = [];
    for (const path of paths) {
      try {
        const current = await vault.stat(path);
        changes.push({
          kind: indexSlice.getSnapshot().docs.has(path) ? 'updated' : 'created',
          path,
          bytes: current.bytes,
          sha256: current.sha256,
          modifiedMs: current.modifiedMs,
        });
      } catch (rejection) {
        const error = toIpcError('vault_stat', rejection);
        if (error.code !== 'E_NOT_FOUND') throw error;
        changes.push({ kind: 'removed', path });
      }
    }
    applyFileChanged({ changes });
    await docStore.waitForReloads(paths);
  }

  /**
   * E_INVALID_ARG 既可能是条件写冲突，也可能是路径越界 / 非 `.md` 等；
   * 只有 stat 复核当前 sha 与 expectedSha 不一致时才判定 conflict（同 writer.detectWriteConflict）。
   */
  async function isExpectedShaConflict(path: string, expectedSha: string): Promise<boolean> {
    try {
      const current = await vault.stat(path);
      return current.sha256 !== expectedSha;
    } catch (rejection) {
      const error = toIpcError('vault_stat', rejection);
      // expectedSha==='' 表示期望文件不存在：stat 报 E_NOT_FOUND 说明写本应成功，
      // 此时的 E_INVALID_ARG 不是 sha 冲突，归 io。
      if (error.code === 'E_NOT_FOUND' && expectedSha === EXPECT_MISSING_SHA) return false;
      return false;
    }
  }

  /**
   * CR-R3-1a：带外写盘。绕过 writer 队列（同 createDoc），直接 vault.write 条件写：
   * - 已打开且 dirty / saving → 拒写，不触盘；
   * 写入成功 → handleSelfWrite 同步索引；已打开则 reconcilePaths 让 clean 文档重读、订阅者收新正文；
   * expectedSha 不符 → conflict；其余错误 → io。
   */
  async function writeDocText(
    path: string,
    text: string,
    expectedSha: string,
  ): Promise<WriteDocTextResult> {
    if (isDisposed()) {
      return {
        ok: false,
        reason: 'io',
        error: ipcFailure('vault_write', 'E_UNKNOWN', 'core is disposed'),
      };
    }
    const doc = docStore.get(path);
    if (doc && (doc.dirty || doc.saving)) {
      return { ok: false, reason: 'dirty' };
    }
    let write: WriteDocDto;
    try {
      write = await vault.write(path, text, expectedSha);
    } catch (rejection) {
      const error =
        rejection instanceof EmberIpcError ? rejection : toIpcError('vault_write', rejection);
      if (error.code === 'E_INVALID_ARG' && (await isExpectedShaConflict(path, expectedSha))) {
        return { ok: false, reason: 'conflict', error };
      }
      return { ok: false, reason: 'io', error };
    }
    handleSelfWrite(write);
    if (docStore.get(path) !== null) {
      await reconcilePaths([path]);
    }
    return { ok: true, write };
  }

  /** 外部变更先并入索引；没有实际差异时不动快照、不发通知。 */
  function handleFileChanged(payload: FileChangedDto): void {
    if (isDisposed()) return;
    if (fileChangeBuffer) {
      fileChangeBuffer.push(payload);
      return;
    }
    if (slice.getSnapshot().status === 'ready') applyFileChanged(payload);
  }

  /**
   * 监听失败不阻塞启动（契约 §III 全局事件）：只上报 core:error，状态仍是 ready。
   * 两个订阅互相独立，其中一个失败不影响另一个。
   */
  async function attachEvents(): Promise<void> {
    if (isDisposed()) return;
    try {
      const offFileChanged = await events.onFileChanged((payload) => {
        handleFileChanged(payload);
      });
      track(offFileChanged);
    } catch (rejection) {
      bus.emit({ type: 'core:error', error: toIpcError('vault://file-changed', rejection) });
    }
    if (isDisposed()) return;
    try {
      const off = await events.onWatchError((payload) => {
        bus.emit({ type: 'core:error', error: toIpcError('vault://watch-error', payload) });
      });
      track(off);
    } catch (rejection) {
      bus.emit({ type: 'core:error', error: toIpcError('vault://watch-error', rejection) });
    }
  }

  async function runStart(): Promise<void> {
    if (isDisposed()) return;
    slice.set({ status: 'starting', identity: null, constants: null, lastError: null });

    let identity: VaultIdentityDto;
    try {
      identity = await vault.identity();
    } catch (rejection) {
      fail('vault_identity', rejection);
      return;
    }
    if (isDisposed()) return;

    let constants: VaultConstantsDto;
    try {
      constants = await vault.constants();
    } catch (rejection) {
      fail('vault_constants', rejection);
      return;
    }
    if (isDisposed()) return;

    fileChangeBuffer = [];
    await attachEvents();
    if (isDisposed()) {
      fileChangeBuffer = null;
      return;
    }

    let scans: ScanDocDto[];
    try {
      scans = await vault.scan();
    } catch (rejection) {
      fileChangeBuffer = null;
      fail('vault_scan', rejection);
      return;
    }
    if (isDisposed()) {
      fileChangeBuffer = null;
      return;
    }

    indexSlice.set(createIndex(scans));
    const buffered = fileChangeBuffer;
    fileChangeBuffer = null;
    for (const payload of buffered ?? []) applyFileChanged(payload);
    slice.set({ status: 'ready', identity, constants, lastError: null });
    bus.emit({ type: 'core:ready', identity, constants });
  }

  function start(): Promise<void> {
    startPromise ??= runStart();
    return startPromise;
  }

  function dispose(): void {
    if (isDisposed()) return;
    fileChangeBuffer = null;
    docStore.dispose();
    // 只收起新写入，不隐式丢弃已入队任务：由调用方 flush 等待（§12.6.3 / §7.2）。
    canvasStore.beginClosing();
    const current = slice.getSnapshot();
    slice.set({ ...current, status: 'disposed' });
    for (const unsubscribe of subscriptions) unsubscribe();
    subscriptions.clear();
    bus.emit({ type: 'core:disposed' });
  }

  return {
    getSnapshot: () => slice.getSnapshot(),
    subscribe: (listener) => slice.subscribe(listener),
    getIndex: () => indexSlice.getSnapshot(),
    subscribeIndex: (listener) => indexSlice.subscribe(listener),
    getDocuments: () => docStore.snapshot(),
    subscribeDocuments: (listener) => docStore.subscribe(listener),
    getDocument: (path) => docStore.get(path),
    resolveDocPath: (from) => docStore.resolveDocPath(from),
    openDoc: (path) => docStore.open(path),
    closeDoc: (path) => {
      docStore.close(path);
    },
    editDoc: (path, text) => {
      docStore.edit(path, text);
    },
    saveDoc: (path) => docStore.save(path),
    resolveDocConflict: (path, choice) => docStore.resolveExternal(path, choice),
    flushDocs: () => docStore.flush(),
    reconcilePaths,
    createDoc,
    writeDocText,
    canvas: canvasStore,
    events: bus,
    start,
    dispose,
  };
}
