/**
 * 画布 per-id 保存队列（CR-20261116-02 §7）。
 *
 * 设计要点：
 * - **同 id 串行**：每个 id 一个 FIFO + 一个 `running` 标志，同一时刻只有一个 worker；
 * - **跨 id 不互阻**：不同 id 各自启动 worker，互不等待；
 * - **出队时取 sha**：`expectedSha` 在写盘前从该 id 的最新状态读取，第二次写能看到第一次的 sha；
 * - **结算时机**：`save` 同步入队并返回 Promise；成功写入后才 resolve，失败 reject；
 * - **关窗**：`beginClosing` 后已入队继续执行（由 `flush` 等待），新 `save` 立即 `E_CLOSING`；
 * - **flush**：排空返回逐项结果 + `pendingIds`；超时返回 `E_FLUSH_TIMEOUT`（`ok:false`）。
 *
 * 竞态防护复用 P2 既有模式，不新建并行机制：per-key FIFO + `running` 单 worker
 * （`src/core/writer.ts:59-64/276-295`）、在飞 `open` 去重（`src/core/doc-store.ts:55/329-337`）、
 * 注入式 `Clock`（`src/core/ports.ts:48-55`）、rejection 归一化 `toIpcError`（`src/core/errors.ts:94`）。
 */
import { EmberIpcError, ipcFailure, toIpcError } from '../errors.ts';
import { EXPECT_MISSING_SHA, type Clock } from '../ports.ts';
import type {
  CanvasFlushReport,
  CanvasOpenResult,
  CanvasPort,
  CanvasSaveOptions,
  CanvasSaveResult,
  CanvasSaveSuccess,
  CanvasStore,
} from './ports.ts';

/** 与 CR §7.2 一致的 flush 默认超时。 */
export const CANVAS_FLUSH_TIMEOUT_MS = 5000;

interface CanvasTask {
  readonly text: string;
  readonly backupV1: boolean;
  readonly resolve: (value: CanvasSaveSuccess) => void;
  readonly reject: (error: EmberIpcError) => void;
  done: boolean;
}

interface CanvasState {
  /** 该 id 的最新已知 sha；`EXPECT_MISSING_SHA` 表示期望目标不存在。 */
  sha256: string;
  readonly queue: CanvasTask[];
  running: boolean;
}

export interface CanvasStoreOptions {
  readonly port: CanvasPort;
  readonly clock: Clock;
  readonly flushTimeoutMs?: number;
}

export function createCanvasStore(options: CanvasStoreOptions): CanvasStore {
  const { port, clock } = options;
  const defaultTimeoutMs = options.flushTimeoutMs ?? CANVAS_FLUSH_TIMEOUT_MS;

  const states = new Map<string, CanvasState>();
  /** 在飞 `open` 去重：同一 id 的并发 open 共享一次读盘。 */
  const opening = new Map<string, Promise<CanvasOpenResult>>();
  /** 尚未被 flush 消费的结算结果（成功与失败都在此，顺序即结算顺序）。 */
  const settled: CanvasSaveResult[] = [];
  const idleWaiters = new Set<() => void>();
  let outstanding = 0;
  let closing = false;

  function closingError(): EmberIpcError {
    return new EmberIpcError(
      'canvas_write',
      'E_CLOSING',
      'canvas store is closing',
      'E_CLOSING',
    );
  }

  function timeoutError(timeoutMs: number): EmberIpcError {
    return new EmberIpcError(
      'canvas_flush',
      'E_FLUSH_TIMEOUT',
      `canvas flush timed out after ${timeoutMs} ms`,
      'E_FLUSH_TIMEOUT',
    );
  }

  function isIdle(): boolean {
    return outstanding === 0;
  }

  function notifyIdle(): void {
    if (!isIdle()) return;
    for (const resolve of [...idleWaiters]) resolve();
    idleWaiters.clear();
  }

  function waitForIdle(): Promise<void> {
    if (isIdle()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      idleWaiters.add(resolve);
    });
  }

  function takeResults(): CanvasSaveResult[] {
    return settled.splice(0, settled.length);
  }

  /**
   * 取「未被同一 id 后续成功覆盖」的失败。
   *
   * 同一 id 若在某次失败之后又有成功结算，说明该 id 内容已正确落盘，旧失败
   * 不得污染 flush 的 ok/error 判定（E_CONFLICT / E_IO 重试成功后关窗场景）。
   * results 仍保留全部结算项（禁止静默丢弃），仅判定忽略已被覆盖的旧失败。
   */
  function unresolvedFailure(results: CanvasSaveResult[]): CanvasSaveResult | undefined {
    const latestIndexByid = new Map<string, number>();
    results.forEach((result, index) => latestIndexByid.set(result.id, index));
    return results.find(
      (result, index) => !result.ok && latestIndexByid.get(result.id) === index,
    );
  }

  function pendingIds(): string[] {
    const ids: string[] = [];
    for (const [id, state] of states) {
      if (state.running || state.queue.length > 0) ids.push(id);
    }
    return ids;
  }

  function finish(task: CanvasTask, result: CanvasSaveResult): void {
    if (task.done) return;
    task.done = true;
    settled.push(result);
    outstanding -= 1;
    if (result.ok) task.resolve({ id: result.id, sha256: result.sha256, modifiedMs: result.modifiedMs });
    else task.reject(result.error);
    notifyIdle();
  }

  /** 写盘；`expectedSha` 必须在此刻读取，禁止在入队时固化（§7.2）。 */
  async function execute(id: string, state: CanvasState, task: CanvasTask): Promise<void> {
    const expectedSha = state.sha256;
    try {
      const write = await port.write(id, task.text, expectedSha, { backupV1: task.backupV1 });
      state.sha256 = write.sha256;
      finish(task, {
        id,
        ok: true,
        sha256: write.sha256,
        modifiedMs: write.modifiedMs,
      });
    } catch (rejection) {
      finish(task, { id, ok: false, error: toIpcError('canvas_write', rejection) });
    }
  }

  function schedule(id: string, state: CanvasState): void {
    if (state.running) return;
    state.running = true;
    void (async () => {
      try {
        while (state.queue.length > 0) {
          const task = state.queue.shift();
          if (!task) break;
          await execute(id, state, task);
        }
      } finally {
        // 队列检查与这里之间没有 await，新任务不会漏掉本轮排空。
        state.running = false;
      }
    })();
  }

  /**
   * 登记/刷新该 id 的 sha。若该 id 正有任务在飞或排队，读盘的快照可能已过期，
   * 保留现有 sha，让写成功后的回填写入最新值，避免把状态回退成旧版本。
   */
  function rememberState(id: string, sha256: string): CanvasState {
    const existing = states.get(id);
    if (existing) {
      if (!existing.running && existing.queue.length === 0) existing.sha256 = sha256;
      return existing;
    }
    const created: CanvasState = { sha256, queue: [], running: false };
    states.set(id, created);
    return created;
  }

  async function readAndRecord(id: string): Promise<CanvasOpenResult> {
    try {
      const read = await port.read(id);
      rememberState(id, read.sha256);
      return {
        exists: true,
        text: read.text,
        sha256: read.sha256,
        modifiedMs: read.modifiedMs,
      };
    } catch (rejection) {
      const error = toIpcError('canvas_read', rejection);
      if (error.code !== 'E_NOT_FOUND') throw error;
      rememberState(id, EXPECT_MISSING_SHA);
      return { exists: false, text: null, sha256: EXPECT_MISSING_SHA, modifiedMs: null };
    }
  }

  function open(id: string): Promise<CanvasOpenResult> {
    const running = opening.get(id);
    if (running) return running;
    const task = readAndRecord(id);
    opening.set(id, task);
    return task.finally(() => {
      if (opening.get(id) === task) opening.delete(id);
    });
  }

  function save(
    id: string,
    text: string,
    saveOptions: CanvasSaveOptions = {},
  ): Promise<CanvasSaveSuccess> {
    if (closing) return Promise.reject(closingError());
    const state = states.get(id);
    // 未 open 直接 save：立即拒绝，不触盘（§7.2）。
    if (!state) {
      return Promise.reject(
        ipcFailure('canvas_write', 'E_INVALID_ARG', `canvas is not open: ${id}`),
      );
    }
    outstanding += 1;
    return new Promise<CanvasSaveSuccess>((resolve, reject) => {
      state.queue.push({
        text,
        backupV1: saveOptions.backupV1 === true,
        resolve,
        reject,
        done: false,
      });
      schedule(id, state);
    });
  }

  async function flush(
    flushOptions: { readonly timeoutMs?: number } = {},
  ): Promise<CanvasFlushReport> {
    const timeoutMs = flushOptions.timeoutMs ?? defaultTimeoutMs;
    if (!isIdle()) {
      const outcome = await Promise.race([
        waitForIdle().then(() => 'drained' as const),
        clock.wait(timeoutMs).then(() => 'timeout' as const),
      ]);
      if (outcome === 'timeout') {
        return {
          ok: false,
          timedOut: true,
          error: timeoutError(timeoutMs),
          results: takeResults(),
          pendingIds: pendingIds(),
        };
      }
    }
    const results = takeResults();
    const failed = unresolvedFailure(results);
    return {
      ok: failed === undefined,
      timedOut: false,
      error: failed !== undefined && !failed.ok ? failed.error : null,
      results,
      pendingIds: [],
    };
  }

  return {
    list: () => port.list(),
    open,
    save,
    beginClosing: () => {
      closing = true;
    },
    cancelClosing: () => {
      closing = false;
    },
    flush,
  };
}
