/**
 * 单写队列（PLAN §6 P2）：全局 FIFO、同一时刻只有一个 vault_write 在飞、
 * 同一路径只保留最新待写；另负责自写回声登记（recentSelfWrites）与 E_READONLY 全局锁写。
 *
 * 队列只认 `WriteRequest` 的回调，不认识文档模型；文档状态由 doc-store 在回调里维护。
 * 所有等待都由调用方注入的 Clock 完成。
 */
import type { WriteDocDto } from '../types/ipc.ts';
import { EmberIpcError, toIpcError } from './errors.ts';
import type { Clock, VaultPort } from './ports.ts';

export interface WriteConflict {
  readonly kind: 'updated' | 'removed';
  readonly sha256: string | null;
  readonly bytes: number | null;
  readonly modifiedMs: number | null;
}

export type WriteOutcome =
  | { readonly ok: true; readonly sha256: string }
  | { readonly ok: false; readonly error: EmberIpcError; readonly conflict: WriteConflict | null };

export interface WriteRequest {
  /** 真正开始写时才取正文，保证同路径只落最新内容。 */
  latestText(): string;
  onStarted(): void;
  /** `writtenText` 为空表示没有真正写盘（锁写 / 失败）。 */
  onSettled(outcome: WriteOutcome, writtenText: string | null): void;
}

export interface WriterOptions {
  readonly vault: VaultPort;
  readonly clock: Clock;
  /** 契约：recentSelfWrites TTL = 2 × watcherDebounceMs。 */
  readonly ttlMs: () => number;
  /** 自写落盘后同步索引（Rust 会抑制对应的 watcher 事件）。 */
  readonly onSelfWrite: (write: WriteDocDto) => void;
  /** 重定向目标已有外部冲突时返回错误；writer 不直接读取文档状态。 */
  readonly redirectError: (path: string) => EmberIpcError | null;
  readonly onError: (error: EmberIpcError) => void;
}

export interface Writer {
  submit(
    path: string,
    request: WriteRequest,
    force: boolean,
    expectedSha?: string | null,
  ): Promise<WriteOutcome>;
  isInFlight(path: string): boolean;
  /** 外部 rename：迁移尚未开始的待写与回声记录。 */
  rekey(from: string, to: string): void;
  consumeSelf(path: string, sha256: string): boolean;
  lockedError(): EmberIpcError | null;
  flush(): Promise<void>;
  dispose(): void;
}

interface PendingEntry {
  readonly request: WriteRequest;
  force: boolean;
  expectedSha: string | null;
  readonly waiters: ((outcome: WriteOutcome) => void)[];
}

interface SelfWriteEntry {
  readonly sha256: string;
  readonly expiresAt: number;
}

function failure(error: EmberIpcError, conflict: WriteConflict | null = null): WriteOutcome {
  return { ok: false, error, conflict };
}

export function createWriter(options: WriterOptions): Writer {
  const { vault, clock } = options;
  const pending = new Map<string, PendingEntry>();
  const selfWrites = new Map<string, SelfWriteEntry[]>();
  const inFlight = new Set<string>();
  /** 仅给在飞写使用的 rename 重定向；待写项直接 rekey，不留 tombstone。 */
  const redirects = new Map<string, string>();
  /** stat 期间目标尚未进入 inFlight；连续 rename 必须能作废这次重定向。 */
  const redirectingPaths = new Set<string>();
  const idleWaiters = new Set<() => void>();
  let running = false;
  let disposed = false;
  let lockError: EmberIpcError | null = null;

  function recordSelf(path: string, sha256: string): void {
    const now = clock.now();
    const ttl = options.ttlMs();
    if (ttl <= 0) return;
    const alive = (selfWrites.get(path) ?? []).filter((entry) => entry.expiresAt > now);
    alive.push({ sha256, expiresAt: now + ttl });
    selfWrites.set(path, alive);
  }

  function consumeSelf(path: string, sha256: string): boolean {
    const entries = selfWrites.get(path);
    if (!entries) return false;
    const now = clock.now();
    let hit = false;
    const alive: SelfWriteEntry[] = [];
    for (const entry of entries) {
      if (entry.expiresAt <= now) continue;
      if (!hit && entry.sha256 === sha256) {
        hit = true;
        continue;
      }
      alive.push(entry);
    }
    if (alive.length === 0) selfWrites.delete(path);
    else selfWrites.set(path, alive);
    return hit;
  }

  function settle(entry: PendingEntry, outcome: WriteOutcome, writtenText: string | null): void {
    entry.request.onSettled(outcome, writtenText);
    for (const resolve of entry.waiters) resolve(outcome);
  }

  function lock(error: EmberIpcError): void {
    if (lockError) return;
    lockError = error;
    for (const entry of pending.values()) settle(entry, failure(error), null);
    pending.clear();
  }

  function takeRedirect(path: string): string | null {
    let target = redirects.get(path);
    if (target === undefined) return null;
    redirects.delete(path);
    const seen = new Set([path]);
    while (!seen.has(target)) {
      seen.add(target);
      const next = redirects.get(target);
      if (next === undefined) break;
      target = next;
    }
    return target === path ? null : target;
  }

  /** 已发出的 IPC 无法撤销；只在磁盘仍是本次写入版本时清理旧路径残留。 */
  async function cleanupStaleWrite(path: string, result: WriteDocDto): Promise<EmberIpcError | null> {
    try {
      const current = await vault.stat(path);
      if (current.sha256 !== result.sha256) return null;
    } catch (rejection) {
      const error = toIpcError('vault_stat', rejection);
      return error.code === 'E_NOT_FOUND' ? null : error;
    }
    try {
      await vault.remove(path);
      return null;
    } catch (rejection) {
      const error = toIpcError('vault_remove', rejection);
      return error.code === 'E_NOT_FOUND' ? null : error;
    }
  }

  async function detectWriteConflict(
    path: string, expectedSha: string, error: EmberIpcError,
  ): Promise<WriteConflict | null> {
    if (error.code !== 'E_INVALID_ARG') return null;
    try {
      const current = await vault.stat(path);
      if (current.sha256 === expectedSha) return null;
      return {
        kind: 'updated',
        sha256: current.sha256,
        bytes: current.bytes,
        modifiedMs: current.modifiedMs,
      };
    } catch (rejection) {
      const statError = toIpcError('vault_stat', rejection);
      if (statError.code !== 'E_NOT_FOUND' || expectedSha === '') return null;
      return { kind: 'removed', sha256: null, bytes: null, modifiedMs: null };
    }
  }

  function failWrite(
    entry: PendingEntry, error: EmberIpcError, conflict: WriteConflict | null = null,
  ): void {
    if (error.code === 'E_READONLY') lock(error);
    if (!disposed) options.onError(error);
    settle(entry, failure(error, conflict), null);
  }

  async function writeRedirect(target: string, entry: PendingEntry): Promise<void> {
    const before = options.redirectError(target);
    if (before) {
      failWrite(entry, before);
      return;
    }
    let expectedSha: string;
    redirectingPaths.add(target);
    try {
      expectedSha = (await vault.stat(target)).sha256;
    } catch (rejection) {
      redirectingPaths.delete(target);
      const error = toIpcError('vault_stat', rejection);
      const conflict: WriteConflict | null = error.code === 'E_NOT_FOUND'
        ? { kind: 'removed', sha256: null, bytes: null, modifiedMs: null }
        : null;
      failWrite(entry, error, conflict);
      return;
    }
    if (!redirectingPaths.delete(target)) {
      failWrite(entry, new EmberIpcError(
        'vault_write',
        'E_INVALID_ARG',
        'redirect target renamed during stat',
        'E_INVALID_ARG',
      ));
      return;
    }
    // stat 期间收到目标冲突时不得续写；之后的 external 由 Rust 条件写拦截。
    const after = options.redirectError(target);
    if (after) {
      failWrite(entry, after);
      return;
    }
    await writeOnce(target, entry, expectedSha);
  }

  async function writeOnce(
    path: string,
    entry: PendingEntry,
    expectedSha: string | null = entry.expectedSha,
  ): Promise<void> {
    const text = entry.request.latestText();
    entry.request.onStarted();
    inFlight.add(path);
    let result: WriteDocDto;
    try {
      result = await vault.write(path, text, expectedSha);
    } catch (rejection) {
      inFlight.delete(path);
      const error = toIpcError('vault_write', rejection);
      const target = error.code === 'E_READONLY' ? null : takeRedirect(path);
      if (target !== null && !disposed) {
        await writeRedirect(target, entry);
        return;
      }
      const conflict = expectedSha === null ? null : await detectWriteConflict(path, expectedSha, error);
      failWrite(entry, error, conflict);
      return;
    }
    inFlight.delete(path);
    const target = takeRedirect(path);
    if (target !== null) {
      const cleanupError = await cleanupStaleWrite(path, result);
      if (cleanupError) {
        failWrite(entry, cleanupError);
        return;
      }
      if (disposed) {
        settle(entry, { ok: true, sha256: result.sha256 }, text);
        return;
      }
      await writeRedirect(target, entry);
      return;
    }
    const queued = pending.get(path);
    if (expectedSha !== null && queued?.expectedSha === expectedSha) {
      // 同路径后续保存接住本次自写结果；真正的外部版本仍由下一次条件写拦截。
      queued.expectedSha = result.sha256;
    }
    if (!disposed) {
      recordSelf(path, result.sha256);
      options.onSelfWrite(result);
    }
    settle(entry, { ok: true, sha256: result.sha256 }, text);
  }

  function kick(): void {
    if (running || disposed) return;
    running = true;
    void (async () => {
      while (!disposed && pending.size > 0) {
        const next = pending.entries().next();
        if (next.done === true) break;
        const [path, entry] = next.value;
        pending.delete(path);
        await writeOnce(path, entry);
      }
      running = false;
      if (!disposed && pending.size > 0) {
        kick();
        return;
      }
      for (const resolve of [...idleWaiters]) resolve();
      idleWaiters.clear();
    })();
  }

  function submit(
    path: string,
    request: WriteRequest,
    force: boolean,
    expectedSha: string | null = null,
  ): Promise<WriteOutcome> {
    return new Promise<WriteOutcome>((resolve) => {
      if (disposed) {
        resolve(failure(new EmberIpcError('vault_write', 'E_UNKNOWN', 'core is disposed', 'E_UNKNOWN')));
        return;
      }
      if (lockError) {
        resolve(failure(lockError));
        return;
      }
      const existing = pending.get(path);
      if (existing) {
        existing.force = existing.force || force;
        // 后续普通保存不得把已登记的条件写降级为无条件覆盖。
        existing.expectedSha = existing.expectedSha ?? expectedSha;
        existing.waiters.push(resolve);
        return;
      }
      pending.set(path, { request, force, expectedSha, waiters: [resolve] });
      kick();
    });
  }

  function rekey(from: string, to: string): void {
    if (from !== to) redirectingPaths.delete(from);
    // rename 链也要更新旧 tombstone；若又改回源路径，则在飞写不再过期。
    for (const [stale, target] of redirects) {
      if (target !== from) continue;
      if (stale === to) redirects.delete(stale);
      else redirects.set(stale, to);
    }
    if (inFlight.has(from) && from !== to) redirects.set(from, to);
    const entry = pending.get(from);
    if (entry && from !== to) {
      const target = pending.get(to);
      pending.delete(from);
      if (target) {
        // 目标请求优先；源等待者跟随目标结果，不能用源正文覆盖目标后报成功。
        target.force = target.force || entry.force;
        target.waiters.push(...entry.waiters);
      } else {
        pending.set(to, entry);
      }
    }
    const writes = selfWrites.get(from);
    if (writes) {
      selfWrites.delete(from);
      selfWrites.set(to, writes);
    }
  }

  function flush(): Promise<void> {
    if (disposed || (!running && pending.size === 0)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      idleWaiters.add(resolve);
    });
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    const error = new EmberIpcError('vault_write', 'E_UNKNOWN', 'core is disposed', 'E_UNKNOWN');
    for (const entry of pending.values()) settle(entry, failure(error), null);
    pending.clear();
    selfWrites.clear();
    redirects.clear();
    redirectingPaths.clear();
    for (const resolve of [...idleWaiters]) resolve();
    idleWaiters.clear();
  }

  return {
    submit,
    isInFlight: (path) => inFlight.has(path),
    rekey,
    consumeSelf,
    lockedError: () => lockError,
    flush,
    dispose,
  };
}
