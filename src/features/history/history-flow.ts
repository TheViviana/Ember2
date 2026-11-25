import { diffLines, type LineDiffResult } from './line-diff.ts';
import { formatUnknownError } from '../../core/errors.ts';

export interface HistoryVersion {
  readonly version: string;
  readonly createdAt: string;
  readonly bytes: number;
}

export interface HistorySnapshot {
  readonly text: string;
}

export interface CurrentDocumentSnapshot {
  readonly text: string;
  readonly sha256: string;
}

export interface HistoryRestoreRequest {
  readonly path: string;
  readonly docId: string;
  readonly version: string;
  readonly expectedSha: string;
}

export interface HistoryPanelEffects {
  list(docId: string): Promise<readonly HistoryVersion[]>;
  read(docId: string, version: string): Promise<HistorySnapshot>;
  readCurrent(path: string): Promise<CurrentDocumentSnapshot>;
  flush(): Promise<void>;
  restore(request: HistoryRestoreRequest): Promise<unknown>;
  delete(docId: string, version: string): Promise<unknown>;
  purge(docId: string): Promise<unknown>;
  reconcile(path: string): Promise<void>;
}

export interface HistoryDiffData {
  readonly current: CurrentDocumentSnapshot;
  readonly historical: HistorySnapshot;
  readonly diff: LineDiffResult;
}

export interface HistoryViewData extends HistoryDiffData {
  readonly versions: readonly HistoryVersion[];
}

export type HistoryFlowResult<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'cancelled' }
  | { readonly status: 'error'; readonly error: string };

export interface HistoryVersionTarget {
  readonly path: string;
  readonly docId: string;
  readonly version: string;
}

export function isValidHistoryDocId(docId: string): boolean {
  return /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i.test(docId);
}

export function historyUnavailableReason(path: string | null, docId: string | null): string | null {
  if (path === null || path.trim().length === 0) return '请打开一个文档后查看历史版本。';
  if (docId === null || docId.length === 0) return '当前文档没有 id，无法使用历史版本。';
  if (!isValidHistoryDocId(docId)) return '当前文档 id 不是合法 ULID，无法使用历史版本。';
  return null;
}

async function readDiff(
  path: string,
  docId: string,
  version: string,
  effects: HistoryPanelEffects,
): Promise<HistoryDiffData> {
  const [current, historical] = await Promise.all([
    effects.readCurrent(path),
    effects.read(docId, version),
  ]);
  return { current, historical, diff: diffLines(current.text, historical.text) };
}

async function readView(target: HistoryVersionTarget, effects: HistoryPanelEffects): Promise<HistoryViewData> {
  const [versions, view] = await Promise.all([
    effects.list(target.docId),
    readDiff(target.path, target.docId, target.version, effects),
  ]);
  return { versions, ...view };
}

export async function loadHistoryTimeline(
  docId: string,
  effects: HistoryPanelEffects,
): Promise<HistoryFlowResult<readonly HistoryVersion[]>> {
  if (!isValidHistoryDocId(docId)) {
    return { status: 'error', error: '当前文档没有合法 ULID id，无法读取历史版本。' };
  }
  try {
    return { status: 'ok', value: await effects.list(docId) };
  } catch (error: unknown) {
    return { status: 'error', error: `读取历史时间线失败：${formatUnknownError(error, String(error))}` };
  }
}

export async function readHistoryVersion(
  target: HistoryVersionTarget,
  effects: HistoryPanelEffects,
): Promise<HistoryFlowResult<HistoryDiffData>> {
  try {
    return { status: 'ok', value: await readDiff(target.path, target.docId, target.version, effects) };
  } catch (error: unknown) {
    return {
      status: 'error',
      error: `读取当前文档或历史版本失败：${formatUnknownError(error, String(error))}`,
    };
  }
}

export async function restoreHistoryVersion(
  target: HistoryVersionTarget,
  effects: HistoryPanelEffects,
): Promise<HistoryFlowResult<HistoryViewData>> {
  if (historyUnavailableReason(target.path, target.docId) !== null) {
    return { status: 'error', error: '当前文档缺少有效 path 或 ULID id，未恢复历史版本。' };
  }
  try {
    await effects.flush();
  } catch (error: unknown) {
    return { status: 'error', error: `保存当前文档失败，未恢复历史版本：${formatUnknownError(error, String(error))}` };
  }

  let current: CurrentDocumentSnapshot;
  try {
    current = await effects.readCurrent(target.path);
  } catch (error: unknown) {
    return { status: 'error', error: `读取最新当前文档失败，未恢复历史版本：${formatUnknownError(error, String(error))}` };
  }

  try {
    await effects.restore({ ...target, expectedSha: current.sha256 });
  } catch (error: unknown) {
    return { status: 'error', error: `恢复失败，当前文档未覆盖：${formatUnknownError(error, String(error))}` };
  }

  try {
    await effects.reconcile(target.path);
  } catch (error: unknown) {
    return { status: 'error', error: `版本已恢复，但同步当前文档失败：${formatUnknownError(error, String(error))}` };
  }

  try {
    return { status: 'ok', value: await readView(target, effects) };
  } catch (error: unknown) {
    return {
      status: 'error',
      error: `版本已恢复，但刷新历史时间线或 diff 失败：${formatUnknownError(error, String(error))}`,
    };
  }
}

export async function deleteHistoryVersion(
  target: HistoryVersionTarget,
  effects: HistoryPanelEffects,
  confirm: (version: string) => boolean,
): Promise<HistoryFlowResult<readonly HistoryVersion[]>> {
  if (!confirm(target.version)) return { status: 'cancelled' };
  try {
    await effects.delete(target.docId, target.version);
  } catch (error: unknown) {
    return { status: 'error', error: `删除历史版本失败：${formatUnknownError(error, String(error))}` };
  }
  try {
    return { status: 'ok', value: await effects.list(target.docId) };
  } catch (error: unknown) {
    return { status: 'error', error: `版本已删除，但刷新时间线失败：${formatUnknownError(error, String(error))}` };
  }
}

export async function purgeHistory(
  docId: string,
  effects: HistoryPanelEffects,
  confirm: () => boolean,
): Promise<HistoryFlowResult<readonly HistoryVersion[]>> {
  if (!confirm()) return { status: 'cancelled' };
  try {
    await effects.purge(docId);
  } catch (error: unknown) {
    return { status: 'error', error: `清空历史版本失败：${formatUnknownError(error, String(error))}` };
  }
  try {
    return { status: 'ok', value: await effects.list(docId) };
  } catch (error: unknown) {
    return { status: 'error', error: `历史版本已清空，但刷新时间线失败：${formatUnknownError(error, String(error))}` };
  }
}
