/**
 * 内核测试替身：内存版 VaultPort / EventPort 与可推进的 FakeClock。
 *
 * 只依赖 `src/core` 的端口契约与 `node:crypto`，不碰 Tauri、不碰真实文件系统，
 * 让 core 的行为（启动、写队列、事件合并）可以在毫秒内被完整验证。
 */
import { createHash } from 'node:crypto';
import { EmberIpcError } from '../../src/core/errors.ts';
import type { CanvasPort } from '../../src/core/canvas/ports.ts';
import type { Clock, EventPort, Unsubscribe, VaultPort } from '../../src/core/ports.ts';
import type {
  CanvasEntryDto,
  DirEntryDto,
  FileChangedDto,
  ReadCanvasDto,
  ReadDocDto,
  ScanDocDto,
  StatDto,
  TrashResultDto,
  VaultConstantsDto,
  VaultIdentityDto,
  WatchErrorPayload,
  WriteCanvasDto,
  WriteDocDto,
} from '../../src/types/ipc.ts';

// ------------------------------------------------------------------ FakeClock

interface FakeTimer {
  at: number;
  resolve: () => void;
}

/**
 * 假时钟：wait 只登记到期点，advance 推进「虚拟时间」并按顺序唤醒。
 * 防抖测试因此不需要真实等待任何秒数。
 */
export class FakeClock implements Clock {
  private current: number;
  private timers: FakeTimer[] = [];

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  wait(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.timers.push({ at: this.current + ms, resolve });
    });
  }

  /** 推进虚拟时间，逐个触发到期 wait，并排空由此产生的微任务。 */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      const index = this.nextDueIndex(target);
      if (index === -1) break;
      const timer = this.timers[index];
      this.timers.splice(index, 1);
      if (!timer) break;
      this.current = timer.at;
      timer.resolve();
      // 等待被唤醒的异步链继续推进（不消耗真实时间）。
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
    this.current = target;
  }

  /** 尚未触发的 wait 数量，便于断言防抖确实在等待。 */
  get pendingCount(): number {
    return this.timers.length;
  }

  private nextDueIndex(target: number): number {
    let found = -1;
    for (let i = 0; i < this.timers.length; i += 1) {
      const timer = this.timers[i];
      if (!timer || timer.at > target) continue;
      const best = found === -1 ? null : this.timers[found];
      if (best === null || best === undefined || timer.at < best.at) found = i;
    }
    return found;
  }
}

// --------------------------------------------------------------- FakeVaultPort

interface FakeFile {
  text: string;
  modifiedMs: number;
}

export interface FakeWriteCall {
  path: string;
  text: string;
  expectedSha: string | null;
}

export interface FakeReadCall {
  path: string;
}

/** 内存库：以相对路径为键，行为对齐契约 §III 的 vault_* 语义。 */
export class FakeVaultPort implements VaultPort {
  readonly files = new Map<string, FakeFile>();
  readonly writeCalls: FakeWriteCall[] = [];
  readonly readCalls: FakeReadCall[] = [];
  readonly removedPaths: string[] = [];
  /** 按方法名注入失败（如 'identity' / 'write' / 'read'）。 */
  readonly failures = new Map<string, EmberIpcError>();

  identityCalls = 0;
  constantsCalls = 0;
  scanCalls = 0;

  identityValue: VaultIdentityDto = {
    vaultId: 'vault-test',
    root: '/tmp/ember-vault-test',
    schemaVersion: 1,
    readonly: false,
  };

  constantsValue: VaultConstantsDto = {
    maxDocBytes: 16 * 1024 * 1024,
    maxImageBytes: 20 * 1024 * 1024,
    maxMediaBytes: 500 * 1024 * 1024,
    historyKeep: 20,
    historyBudgetBytes: 64 * 1024 * 1024,
    trashRetentionDays: 7,
    watcherDebounceMs: 500,
    maxScanDepth: 32,
  };

  private stamp = 0;

  /** 写入一条初始文件；`text` 直接给正文，或给 { text, modifiedMs }。 */
  seed(path: string, text: string, modifiedMs?: number): void {
    this.stamp += 1;
    this.files.set(path, { text, modifiedMs: modifiedMs ?? this.stamp });
  }

  identity(): Promise<VaultIdentityDto> {
    this.identityCalls += 1;
    const failure = this.failures.get('identity');
    if (failure) return Promise.reject(failure);
    return Promise.resolve(this.identityValue);
  }

  constants(): Promise<VaultConstantsDto> {
    this.constantsCalls += 1;
    const failure = this.failures.get('constants');
    if (failure) return Promise.reject(failure);
    return Promise.resolve(this.constantsValue);
  }

  scan(): Promise<ScanDocDto[]> {
    this.scanCalls += 1;
    const failure = this.failures.get('scan');
    if (failure) return Promise.reject(failure);
    const docs: ScanDocDto[] = [...this.files.entries()]
      .map(([path, file]) => ({
        path,
        bytes: byteLength(file.text),
        sha256: sha256(file.text),
        modifiedMs: file.modifiedMs,
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return Promise.resolve(docs);
  }

  read(path: string): Promise<ReadDocDto> {
    this.readCalls.push({ path });
    const failure = this.failures.get('read');
    if (failure) return Promise.reject(failure);
    const file = this.files.get(path);
    if (!file) return Promise.reject(notFound(path));
    return Promise.resolve({
      path,
      text: file.text,
      bytes: byteLength(file.text),
      sha256: sha256(file.text),
      modifiedMs: file.modifiedMs,
    });
  }

  write(path: string, text: string, expectedSha: string | null = null): Promise<WriteDocDto> {
    this.writeCalls.push({ path, text, expectedSha });
    const failure = this.failures.get('write');
    if (failure) return Promise.reject(failure);
    const current = this.files.get(path);
    const matches = expectedSha === ''
      ? current === undefined
      : current !== undefined && sha256(current.text) === expectedSha;
    if (expectedSha !== null && !matches) {
      return Promise.reject(
        new EmberIpcError(
          'vault_write',
          'E_INVALID_ARG',
          'document changed before write',
          'E_INVALID_ARG',
        ),
      );
    }
    this.stamp += 1;
    this.files.set(path, { text, modifiedMs: this.stamp });
    return Promise.resolve({ path, bytes: byteLength(text), sha256: sha256(text) });
  }

  stat(path: string): Promise<StatDto> {
    const failure = this.failures.get('stat');
    if (failure) return Promise.reject(failure);
    const file = this.files.get(path);
    if (!file) return Promise.reject(notFound(path));
    return Promise.resolve({
      path,
      bytes: byteLength(file.text),
      sha256: sha256(file.text),
      modifiedMs: file.modifiedMs,
    });
  }

  list(path = ''): Promise<DirEntryDto[]> {
    const failure = this.failures.get('list');
    if (failure) return Promise.reject(failure);
    const prefix = path === '' ? '' : `${path}/`;
    const seenDirs = new Set<string>();
    const entries: DirEntryDto[] = [];
    for (const [filePath, file] of this.files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      if (rest === '') continue;
      const slash = rest.indexOf('/');
      if (slash === -1) {
        entries.push({
          name: rest,
          path: filePath,
          kind: 'file',
          bytes: byteLength(file.text),
          modifiedMs: file.modifiedMs,
        });
        continue;
      }
      const dirName = rest.slice(0, slash);
      const dirPath = `${prefix}${dirName}`;
      if (seenDirs.has(dirPath)) continue;
      seenDirs.add(dirPath);
      entries.push({ name: dirName, path: dirPath, kind: 'dir', bytes: 0, modifiedMs: 0 });
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return Promise.resolve(entries);
  }

  rename(from: string, to: string): Promise<WriteDocDto> {
    const failure = this.failures.get('rename');
    if (failure) return Promise.reject(failure);
    const file = this.files.get(from);
    if (!file) return Promise.reject(notFound(from));
    if (this.files.has(to)) {
      return Promise.reject(
        new EmberIpcError('vault_rename', 'E_INVALID_ARG', `target exists: ${to}`, 'E_INVALID_ARG'),
      );
    }
    this.files.delete(from);
    this.stamp += 1;
    this.files.set(to, { text: file.text, modifiedMs: this.stamp });
    return Promise.resolve({ path: to, bytes: byteLength(file.text), sha256: sha256(file.text) });
  }

  remove(path: string): Promise<TrashResultDto> {
    const failure = this.failures.get('remove');
    if (failure) return Promise.reject(failure);
    if (!this.files.delete(path)) return Promise.reject(notFound(path));
    this.removedPaths.push(path);
    this.stamp += 1;
    return Promise.resolve({ via: 'workbench', trashId: `trash-${this.stamp}` });
  }
}

// --------------------------------------------------------------- FakeEventPort

/** 手动发事件的事件端口：测试里调用 emitFileChanged / emitWatchError。 */
export class FakeEventPort implements EventPort {
  private fileChangedHandlers = new Set<(payload: FileChangedDto) => void>();
  private watchErrorHandlers = new Set<(payload: WatchErrorPayload) => void>();

  onFileChanged(handler: (payload: FileChangedDto) => void): Promise<Unsubscribe> {
    this.fileChangedHandlers.add(handler);
    return Promise.resolve(() => {
      this.fileChangedHandlers.delete(handler);
    });
  }

  onWatchError(handler: (payload: WatchErrorPayload) => void): Promise<Unsubscribe> {
    this.watchErrorHandlers.add(handler);
    return Promise.resolve(() => {
      this.watchErrorHandlers.delete(handler);
    });
  }

  emitFileChanged(payload: FileChangedDto): void {
    for (const handler of [...this.fileChangedHandlers]) handler(payload);
  }

  emitWatchError(payload: WatchErrorPayload): void {
    for (const handler of [...this.watchErrorHandlers]) handler(payload);
  }

  get fileChangedListenerCount(): number {
    return this.fileChangedHandlers.size;
  }

  get watchErrorListenerCount(): number {
    return this.watchErrorHandlers.size;
  }
}

// --------------------------------------------------------------- FakeCanvasPort

export interface FakeCanvasWriteCall {
  id: string;
  text: string;
  expectedSha: string;
  backupV1: boolean;
}

interface CanvasGate {
  promise: Promise<void>;
  release: () => void;
}

/**
 * 内存画布：只模拟 CR-20261116-02 §3 的三条命令，不含 Rust 侧的 id 白名单、
 * 大小上限与编码校验（那些属于 Rust 契约，已在 src-tauri 公证）。
 *
 * `holdWrite(id)` 用来卡住某个 id 的写盘，验证「写盘完成后才结算」；
 * `failNext(method, error)` 用来注入一次性失败（如 E_DISK_FULL）。
 */
export class FakeCanvasPort implements CanvasPort {
  readonly files = new Map<string, FakeFile>();
  readonly writeCalls: FakeCanvasWriteCall[] = [];
  readonly readCalls: string[] = [];
  /** `list` 原样返回；测试自行填 `valid:false` 条目验证透传。 */
  entries: CanvasEntryDto[] = [];
  listCalls = 0;
  private readonly failures = new Map<string, EmberIpcError[]>();
  private readonly gates = new Map<string, CanvasGate>();
  private stamp = 0;

  seed(id: string, text: string, modifiedMs?: number): void {
    this.stamp += 1;
    this.files.set(id, { text, modifiedMs: modifiedMs ?? this.stamp });
  }

  failNext(method: 'list' | 'read' | 'write', error: EmberIpcError): void {
    const queue = this.failures.get(method) ?? [];
    queue.push(error);
    this.failures.set(method, queue);
  }

  /** 卡住该 id 的写盘；返回释放函数。 */
  holdWrite(id: string): () => void {
    let release: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gates.set(id, { promise, release });
    return () => {
      const gate = this.gates.get(id);
      if (!gate) return;
      this.gates.delete(id);
      gate.release();
    };
  }

  private takeFailure(method: string): EmberIpcError | null {
    const queue = this.failures.get(method);
    if (!queue || queue.length === 0) return null;
    return queue.shift() ?? null;
  }

  list(): Promise<CanvasEntryDto[]> {
    this.listCalls += 1;
    const failure = this.takeFailure('list');
    if (failure) return Promise.reject(failure);
    return Promise.resolve(this.entries.map((entry) => ({ ...entry })));
  }

  read(id: string): Promise<ReadCanvasDto> {
    this.readCalls.push(id);
    const failure = this.takeFailure('read');
    if (failure) return Promise.reject(failure);
    const file = this.files.get(id);
    if (!file) {
      return Promise.reject(
        new EmberIpcError('canvas_read', 'E_NOT_FOUND', `canvas not found: ${id}`, 'E_NOT_FOUND'),
      );
    }
    return Promise.resolve({
      id,
      path: canvasPath(id),
      text: file.text,
      bytes: byteLength(file.text),
      sha256: sha256(file.text),
      modifiedMs: file.modifiedMs,
    });
  }

  async write(
    id: string,
    text: string,
    expectedSha: string,
    options: { backupV1?: boolean } = {},
  ): Promise<WriteCanvasDto> {
    this.writeCalls.push({ id, text, expectedSha, backupV1: options.backupV1 === true });
    const failure = this.takeFailure('write');
    if (failure) throw failure;
    const gate = this.gates.get(id);
    if (gate) await gate.promise;
    const current = this.files.get(id);
    const matches =
      expectedSha === ''
        ? current === undefined
        : current !== undefined && sha256(current.text) === expectedSha;
    if (!matches) {
      throw new EmberIpcError(
        'canvas_write',
        'E_CONFLICT',
        'canvas changed before write',
        'E_CONFLICT',
        { currentSha: current ? sha256(current.text) : null },
      );
    }
    this.stamp += 1;
    this.files.set(id, { text, modifiedMs: this.stamp });
    return {
      id,
      path: canvasPath(id),
      bytes: byteLength(text),
      sha256: sha256(text),
      modifiedMs: this.stamp,
    };
  }
}

// -------------------------------------------------------------------- helpers

function canvasPath(id: string): string {
  return `.workbench/canvas/${id}.canvas.json`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function notFound(path: string): EmberIpcError {
  return new EmberIpcError('vault', 'E_NOT_FOUND', `not found: ${path}`, 'E_NOT_FOUND');
}
