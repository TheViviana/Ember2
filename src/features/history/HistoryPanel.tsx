import { useCallback, useEffect, useRef, useState } from 'react';
import {
  deleteHistoryVersion,
  historyUnavailableReason,
  loadHistoryTimeline,
  purgeHistory,
  readHistoryVersion,
  restoreHistoryVersion,
  type HistoryDiffData,
  type HistoryPanelEffects,
  type HistoryVersion,
  type HistoryVersionTarget,
} from './history-flow.ts';
import type { LineDiffOperation } from './line-diff.ts';
import styles from './history.module.css';

export type {
  CurrentDocumentSnapshot,
  HistoryPanelEffects,
  HistoryRestoreRequest,
  HistorySnapshot,
  HistoryVersion,
} from './history-flow.ts';

export interface HistoryPanelProps {
  readonly path: string | null;
  readonly docId: string | null;
  readonly effects: HistoryPanelEffects;
  readonly onClose: () => void;
  readonly confirmDelete?: (version: string) => boolean;
  readonly confirmPurge?: () => boolean;
}

type BusyOperation = 'list' | 'read' | 'restore' | 'delete' | 'purge';

const BUSY_LABEL: Readonly<Record<BusyOperation, string>> = {
  list: '正在读取历史时间线…',
  read: '正在读取版本并计算 diff…',
  restore: '正在保存并恢复历史版本…',
  delete: '正在删除历史版本…',
  purge: '正在清空历史版本…',
};

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function DiffRow({ operation }: { readonly operation: LineDiffOperation }) {
  const className = operation.type === 'insert'
    ? styles.insert
    : operation.type === 'delete'
      ? styles.delete
      : styles.equal;
  const marker = operation.type === 'insert' ? '+' : operation.type === 'delete' ? '−' : ' ';
  return (
    <div className={className} data-diff-type={operation.type}>
      <span className={styles.lineNumber}>{operation.oldLine ?? ''}</span>
      <span className={styles.lineNumber}>{operation.newLine ?? ''}</span>
      <code className={styles.diffText}>{marker} {operation.text.length === 0 ? ' ' : operation.text}</code>
    </div>
  );
}

export function HistoryPanel({
  path,
  docId,
  effects,
  onClose,
  confirmDelete,
  confirmPurge,
}: HistoryPanelProps) {
  const [versions, setVersions] = useState<readonly HistoryVersion[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [view, setView] = useState<HistoryDiffData | null>(null);
  const [busy, setBusy] = useState<BusyOperation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busyRef = useRef(false);
  const operationRef = useRef(0);
  const unavailableReason = historyUnavailableReason(path, docId);

  const readSelection = useCallback(async (
    target: HistoryVersionTarget,
    operation: number,
  ): Promise<void> => {
    setBusy('read');
    setError(null);
    setView(null);
    const result = await readHistoryVersion(target, effects);
    if (operation !== operationRef.current) return;
    if (result.status === 'ok') {
      setView(result.value);
    } else if (result.status === 'error') {
      setError(result.error);
    }
    busyRef.current = false;
    setBusy(null);
  }, [effects]);

  const reload = useCallback(async (): Promise<void> => {
    if (busyRef.current) return;
    const operation = ++operationRef.current;
    setVersions([]);
    setSelectedVersion(null);
    setView(null);
    setError(null);
    setNotice(null);
    if (unavailableReason !== null || path === null || docId === null) {
      busyRef.current = false;
      setBusy(null);
      return;
    }
    busyRef.current = true;
    setBusy('list');
    const result = await loadHistoryTimeline(docId, effects);
    if (operation !== operationRef.current) return;
    if (result.status !== 'ok') {
      if (result.status === 'error') setError(result.error);
      busyRef.current = false;
      setBusy(null);
      return;
    }
    setVersions(result.value);
    const latest = result.value.at(-1);
    if (latest === undefined) {
      busyRef.current = false;
      setBusy(null);
      return;
    }
    setSelectedVersion(latest.version);
    await readSelection({ path, docId, version: latest.version }, operation);
  }, [docId, effects, path, readSelection, unavailableReason]);

  useEffect(() => {
    void reload();
    return () => {
      operationRef.current += 1;
      busyRef.current = false;
    };
  }, [reload]);

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busyRef.current) onClose();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onClose]);

  const select = async (version: string): Promise<void> => {
    if (busyRef.current || path === null || docId === null || unavailableReason !== null) return;
    busyRef.current = true;
    const operation = ++operationRef.current;
    setSelectedVersion(version);
    setNotice(null);
    await readSelection({ path, docId, version }, operation);
  };

  const restore = async (): Promise<void> => {
    if (busyRef.current || selectedVersion === null || path === null || docId === null) return;
    busyRef.current = true;
    const operation = ++operationRef.current;
    setBusy('restore');
    setError(null);
    setNotice(null);
    const result = await restoreHistoryVersion({ path, docId, version: selectedVersion }, effects);
    if (operation !== operationRef.current) return;
    if (result.status === 'ok') {
      setVersions(result.value.versions);
      setView(result.value);
      setNotice('已恢复所选版本，当前文档已同步。');
    } else if (result.status === 'error') {
      setError(result.error);
    }
    busyRef.current = false;
    setBusy(null);
  };

  const remove = async (): Promise<void> => {
    if (busyRef.current || selectedVersion === null || path === null || docId === null) return;
    busyRef.current = true;
    const operation = ++operationRef.current;
    const version = selectedVersion;
    setBusy('delete');
    setError(null);
    setNotice(null);
    const confirm = confirmDelete ?? ((candidate: string): boolean => window.confirm(
      `确定永久删除历史版本 ${candidate} 吗？当前文档不会被改写。`,
    ));
    const result = await deleteHistoryVersion({ path, docId, version }, effects, confirm);
    if (operation !== operationRef.current) return;
    if (result.status === 'error') setError(result.error);
    if (result.status === 'ok') {
      setVersions(result.value);
      setNotice('所选历史版本已删除，当前文档未改写。');
      if (result.value.some((item) => item.version === version)) {
        busyRef.current = false;
        setBusy(null);
        return;
      }
      const latest = result.value.at(-1);
      setSelectedVersion(latest?.version ?? null);
      if (latest !== undefined) {
        await readSelection({ path, docId, version: latest.version }, operation);
        return;
      }
      setView(null);
    }
    busyRef.current = false;
    setBusy(null);
  };

  const purge = async (): Promise<void> => {
    if (busyRef.current || path === null || docId === null) return;
    busyRef.current = true;
    const operation = ++operationRef.current;
    setBusy('purge');
    setError(null);
    setNotice(null);
    const confirm = confirmPurge ?? ((): boolean => window.confirm(
      '确定永久清空当前文档的全部历史版本吗？当前文档不会被改写。',
    ));
    const result = await purgeHistory(docId, effects, confirm);
    if (operation !== operationRef.current) return;
    if (result.status === 'error') setError(result.error);
    if (result.status === 'ok') {
      setVersions(result.value);
      setNotice('历史版本已清空，当前文档未改写。');
      const latest = result.value.at(-1);
      setSelectedVersion(latest?.version ?? null);
      if (latest !== undefined) {
        await readSelection({ path, docId, version: latest.version }, operation);
        return;
      }
      setView(null);
    }
    busyRef.current = false;
    setBusy(null);
  };

  return (
    <div className={styles.host} style={{ zIndex: 3000 }}>
      <div
        className={styles.backdrop}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && busy === null) onClose();
        }}
      >
        <section className={styles.panel} role="dialog" aria-modal="true" aria-label="历史版本" aria-busy={busy !== null}>
          <header className={styles.header}>
            <div className={styles.heading}>
              <h2 className={styles.title}>历史版本</h2>
              <p className={styles.path} title={path ?? undefined}>{path ?? '未打开文档'}</p>
            </div>
            <button type="button" className={styles.closeButton} onClick={onClose} disabled={busy !== null} aria-label="关闭历史版本">×</button>
          </header>

          {unavailableReason !== null ? (
            <p className={styles.unavailable} role="status">{unavailableReason}</p>
          ) : (
            <div className={styles.content}>
              <aside className={styles.timeline} aria-label="历史时间线">
                <div className={styles.timelineTools}>
                  <span>{versions.length} 个版本</span>
                  <button type="button" onClick={() => { void reload(); }} disabled={busy !== null}>刷新</button>
                </div>
                <div className={styles.versionList} role="listbox" aria-label="选择历史版本">
                  {versions.length === 0 && busy === null ? <p className={styles.empty}>暂无历史版本</p> : null}
                  {versions.map((item) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={selectedVersion === item.version}
                      className={selectedVersion === item.version ? styles.selectedVersion : styles.version}
                      key={item.version}
                      onClick={() => { void select(item.version); }}
                      disabled={busy !== null}
                    >
                      <span>{formatTime(item.createdAt)}</span>
                      <code>{item.version}</code>
                      <span>{formatBytes(item.bytes)}</span>
                    </button>
                  ))}
                </div>
                <button type="button" className={styles.purgeButton} onClick={() => { void purge(); }} disabled={busy !== null || versions.length === 0}>
                  清空全部历史
                </button>
              </aside>

              <section className={styles.preview} aria-label="当前与历史版本差异">
                <div className={styles.previewTools}>
                  <span>当前 → 所选历史</span>
                  <span className={styles.spacer} />
                  <button type="button" onClick={() => { void restore(); }} disabled={busy !== null || selectedVersion === null}>恢复此版本</button>
                  <button type="button" onClick={() => { void remove(); }} disabled={busy !== null || selectedVersion === null}>删除此版本</button>
                </div>
                {busy !== null ? <p className={styles.status} role="status">{BUSY_LABEL[busy]}</p> : null}
                {error !== null ? <p className={styles.error} role="alert">{error}</p> : null}
                {notice !== null ? <p className={styles.notice} role="status">{notice}</p> : null}
                {view?.diff.simplified === true ? <p className={styles.warning} role="status">版本过大，已简化 diff</p> : null}
                <div className={styles.diff} aria-label="行级 diff">
                  {view === null && busy === null ? <p className={styles.empty}>选择版本后显示当前 ↔ 历史 diff</p> : null}
                  {view?.diff.operations.map((operation, index) => (
                    <DiffRow operation={operation} key={`${operation.oldLine ?? 0}:${operation.newLine ?? 0}:${index}`} />
                  ))}
                </div>
              </section>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
