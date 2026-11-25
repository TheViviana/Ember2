/**
 * 冲突数据、命名与裁决；resolver 只操作调用方传入的状态，不另存文档集合。
 */
import type { ReadDocDto, StatDto } from '../types/ipc.ts';
import {
  toState,
  type ConflictChoice,
  type DocState,
  type MutableDoc,
  type SaveOutcome,
} from './doc-state.ts';
import { EmberIpcError, ipcFailure, toIpcError } from './errors.ts';
import { posixBaseName } from './path-utils.ts';
import { EXPECT_MISSING_SHA, type Clock, type VaultPort } from './ports.ts';
import type { Writer } from './writer.ts';

/** 磁盘相对 baseSha 的外部变化；等待用户裁决，不在事件路径写盘。 */
export interface ExternalChange {
  readonly kind: 'updated' | 'removed';
  readonly sha256: string | null;
  readonly bytes: number | null;
  readonly modifiedMs: number | null;
}

export function makeExternal(
  kind: 'updated' | 'removed',
  sha256: string | null,
  bytes: number | null,
  modifiedMs: number | null,
): ExternalChange {
  return Object.freeze({ kind, sha256, bytes, modifiedMs });
}

/** `<name>.conflict-<YYYYMMDD-HHmmss-SSS>[-N].md`，时间来自注入时钟（本地时区）。 */
export function conflictCopyPath(path: string, nowMs: number, revision = 1): string {
  const base = posixBaseName(path);
  const dir = path.slice(0, path.length - base.length);
  const stem = base.endsWith('.md') ? base.slice(0, -3) : base;
  const date = new Date(nowMs);
  const pad = (value: number, length = 2): string => String(value).padStart(length, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
  const suffix = revision === 1 ? '' : `-${revision}`;
  return `${dir}${stem}.conflict-${stamp}${suffix}.md`;
}

export interface ConflictResolverOptions {
  readonly docs: Map<string, MutableDoc>;
  readonly vault: VaultPort;
  readonly clock: Clock;
  readonly writer: Writer;
  readonly publish: () => void;
  readonly requestSave: (
    path: string,
    force: boolean,
    allowExternal?: boolean,
    expectedSha?: string | null,
  ) => Promise<SaveOutcome>;
  readonly isDisposed: () => boolean;
}

export function createConflictResolver(options: ConflictResolverOptions): {
  resolveExternal(path: string, choice: ConflictChoice): Promise<DocState>;
} {
  const { docs, vault, clock, writer, publish } = options;

  async function writeConflictCopy(path: string): Promise<void> {
    let read: ReadDocDto;
    try {
      read = await vault.read(path);
    } catch (rejection) {
      const error = toIpcError('vault_read', rejection);
      // 文件已被删除：没有可保存的外部内容，直接按“保留本地”继续。
      if (error.code === 'E_NOT_FOUND') return;
      throw error;
    }
    const text = read.text;
    const now = clock.now();
    let copyPath = conflictCopyPath(path, now);
    for (let revision = 2; ; revision += 1) {
      try {
        await vault.stat(copyPath);
      } catch (rejection) {
        const error = toIpcError('vault_stat', rejection);
        if (error.code === 'E_NOT_FOUND') break;
        throw error;
      }
      copyPath = conflictCopyPath(path, now, revision);
    }
    const outcome = await writer.submit(
      copyPath,
      {
        latestText: () => text,
        onStarted: () => undefined,
        onSettled: () => undefined,
      },
      true,
      EXPECT_MISSING_SHA,
    );
    if (!outcome.ok) throw outcome.error;
  }

  async function ensureOverwriteCurrent(doc: MutableDoc, expected: ExternalChange): Promise<void> {
    let current: StatDto | null = null;
    try {
      current = await vault.stat(doc.path);
    } catch (rejection) {
      const error = toIpcError('vault_stat', rejection);
      if (error.code !== 'E_NOT_FOUND') throw error;
    }
    if (
      (expected.kind === 'updated' && current?.sha256 === expected.sha256) ||
      (expected.kind === 'removed' && current === null)
    ) {
      return;
    }
    if (options.isDisposed() || docs.get(doc.path) !== doc) {
      throw ipcFailure('vault_write', 'E_UNKNOWN', 'document was closed');
    }
    doc.external = current
      ? makeExternal('updated', current.sha256, current.bytes, current.modifiedMs)
      : makeExternal('removed', null, null, null);
    publish();
    throw ipcFailure(
      'vault_write',
      'E_INVALID_ARG',
      'disk changed again; resolve the new external change first',
    );
  }

  async function resolveExternal(path: string, choice: ConflictChoice): Promise<DocState> {
    const doc = docs.get(path);
    if (!doc || options.isDisposed()) {
      throw ipcFailure('vault_read', 'E_NOT_FOUND', `document is not open: ${path}`);
    }
    if (doc.saving) throw ipcFailure('vault_read', 'E_INVALID_ARG', 'document is saving');
    const external = doc.external;
    if (!external) return toState(doc);

    if (choice === 'reload') {
      // 裁决期间编辑器仍可输入；读取结果只代表点击时的磁盘，不能覆盖新正文。
      const generation = doc.saveGeneration;
      const localText = doc.text;
      let read: ReadDocDto;
      try {
        read = await vault.read(path);
      } catch (rejection) {
        throw rejection instanceof EmberIpcError ? rejection : toIpcError('vault_read', rejection);
      }
      if (options.isDisposed() || docs.get(path) !== doc) {
        throw ipcFailure('vault_read', 'E_UNKNOWN', 'document was closed');
      }
      let current: StatDto | null = null;
      try {
        current = await vault.stat(path);
      } catch (rejection) {
        const error = toIpcError('vault_stat', rejection);
        if (error.code !== 'E_NOT_FOUND') throw error;
      }
      if (options.isDisposed() || docs.get(path) !== doc) {
        throw ipcFailure('vault_read', 'E_UNKNOWN', 'document was closed');
      }
      if (doc.text !== localText || doc.saveGeneration !== generation) {
        // 用户点击后继续输入：保留新正文，重新标记冲突，等下一次裁决。
        doc.external = current
          ? makeExternal('updated', current.sha256, current.bytes, current.modifiedMs)
          : makeExternal('removed', null, null, null);
        publish();
        throw ipcFailure(
          'vault_read',
          'E_INVALID_ARG',
          'document changed during reload; resolve the conflict again',
        );
      }
      if (
        external.kind !== 'updated' ||
        read.sha256 !== external.sha256 ||
        current?.sha256 !== external.sha256
      ) {
        doc.external = current
          ? makeExternal('updated', current.sha256, current.bytes, current.modifiedMs)
          : makeExternal('removed', null, null, null);
        publish();
        throw ipcFailure(
          'vault_read',
          'E_INVALID_ARG',
          'disk changed again; resolve the new external change first',
        );
      }
      doc.text = read.text;
      doc.baseText = read.text;
      doc.baseSha = read.sha256;
      doc.external = null;
      doc.error = null;
      doc.saveGeneration += 1;
      publish();
      return toState(doc);
    }

    if (external.kind === 'updated') await writeConflictCopy(path);
    if (options.isDisposed()) throw ipcFailure('vault_write', 'E_UNKNOWN', 'core is disposed');
    await ensureOverwriteCurrent(doc, external);
    // 覆盖期间保留原冲突；写失败时 dirty + external 不变，普通保存仍会被阻断。
    const outcome = await options.requestSave(
      path, true, true, external.sha256 ?? EXPECT_MISSING_SHA,
    );
    if (!outcome.ok) {
      if (outcome.error.code === 'E_INVALID_ARG') {
        // 条件写失败后只复核并刷新冲突，绝不自动重放旧裁决。
        await ensureOverwriteCurrent(doc, external);
      }
      throw outcome.error;
    }
    const after = docs.get(path);
    if (!after) throw ipcFailure('vault_write', 'E_UNKNOWN', 'document was closed');
    // 写盘期间若收到更新的外部版本，只清除本次已裁决的冲突对象。
    if (after.external === external) {
      after.external = null;
      publish();
    }
    return toState(after);
  }

  return { resolveExternal };
}
