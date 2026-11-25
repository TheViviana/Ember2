/**
 * 打开文档的公共类型与快照转换；不持有文档集合或订阅状态。
 */
import type { FileChangeDto, ReadDocDto, WriteDocDto } from '../types/ipc.ts';
import type { ExternalChange } from './conflict.ts';
import type { EmberIpcError } from './errors.ts';
import type { Clock, Unsubscribe, VaultPort } from './ports.ts';

/** UI 可见的打开文档快照；`text` 已含未落盘的乐观更新。 */
export interface DocState {
  readonly path: string;
  readonly text: string;
  /** 最近一次成功读盘 / 写盘的 sha。 */
  readonly baseSha: string;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly error: EmberIpcError | null;
  readonly external: ExternalChange | null;
}

export type SaveOutcome =
  | { readonly ok: true; readonly sha256: string }
  | {
      readonly ok: false;
      readonly error: EmberIpcError;
      /** 非空表示被外部变更挡住，需先 resolveExternal。 */
      readonly conflict: ExternalChange | null;
    };

export type ConflictChoice = 'reload' | 'overwrite';

export interface DocStoreOptions {
  readonly vault: VaultPort;
  readonly clock: Clock;
  /** 编辑后自动保存的防抖窗口（前端策略，不是 Rust 常量）。 */
  readonly autoSaveDelayMs: number;
  /** 启动完成后才允许读写。 */
  readonly isReady: () => boolean;
  /** 契约：recentSelfWrites TTL = 2 × watcherDebounceMs。 */
  readonly selfWriteTtlMs: () => number;
  /** 自写落盘后同步索引元数据（Rust 会抑制对应 watcher 事件）。 */
  readonly onSelfWrite: (write: WriteDocDto) => void;
  readonly onError: (error: EmberIpcError) => void;
}

export interface DocStore {
  snapshot(): ReadonlyMap<string, DocState>;
  subscribe(listener: (docs: ReadonlyMap<string, DocState>) => void): Unsubscribe;
  get(path: string): DocState | null;
  open(path: string): Promise<DocState>;
  close(path: string): void;
  edit(path: string, text: string): void;
  save(path: string): Promise<SaveOutcome>;
  resolveExternal(path: string, choice: ConflictChoice): Promise<DocState>;
  handleChanges(changes: readonly FileChangeDto[]): void;
  /** 写队列排空（关窗 flush / 测试）。 */
  flush(): Promise<void>;
  dispose(): void;
}

export interface MutableDoc {
  path: string;
  text: string;
  baseText: string;
  baseSha: string;
  saving: boolean;
  error: EmberIpcError | null;
  external: ExternalChange | null;
  /** 在飞写入期间收到的 updated/created，等写完再判定是否回声。 */
  pendingExternal: FileChangeDto | null;
  reloadTarget: ReloadTarget | null;
  reloadRunning: boolean;
  /** 每次编辑 / 显式保存自增；防抖回调据此判断是否过期。 */
  saveGeneration: number;
}

export interface ReloadTarget {
  readonly sha256: string;
  readonly bytes: number | null;
  readonly modifiedMs: number | null;
}

export function makeDoc(read: ReadDocDto): MutableDoc {
  return {
    path: read.path,
    text: read.text,
    baseText: read.text,
    baseSha: read.sha256,
    saving: false,
    error: null,
    external: null,
    pendingExternal: null,
    reloadTarget: null,
    reloadRunning: false,
    saveGeneration: 0,
  };
}

export function toState(doc: MutableDoc): DocState {
  return Object.freeze({
    path: doc.path,
    text: doc.text,
    baseSha: doc.baseSha,
    dirty: isDirty(doc),
    saving: doc.saving,
    error: doc.error,
    external: doc.external,
  });
}

export function isDirty(doc: MutableDoc): boolean {
  return doc.text !== doc.baseText;
}
