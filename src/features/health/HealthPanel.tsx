import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cleanupWorkbenchTrash,
  formatTrashBytes,
  loadWorkbenchTrash,
  summarizeTrash,
  type HealthPanelEffects,
  type TrashSummary,
  type WorkbenchTrashCleanupError,
  type WorkbenchTrashEntry,
} from './health-flow.ts';
import styles from './health.module.css';
import shared from '../settings/settings-shared.module.css';

export type { HealthPanelEffects, WorkbenchTrashEntry } from './health-flow.ts';

export interface HealthSettingsBodyProps {
  readonly effects: HealthPanelEffects;
  readonly confirmCleanup?: (summary: TrashSummary) => boolean;
}

function formatDeletedAt(value: string | null): string {
  if (value === null) return '删除时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

export function HealthSettingsBody({ effects, confirmCleanup }: HealthSettingsBodyProps) {
  const [entries, setEntries] = useState<readonly WorkbenchTrashEntry[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [cleanupErrors, setCleanupErrors] = useState<readonly WorkbenchTrashCleanupError[]>([]);
  const [busy, setBusy] = useState<'list' | 'cleanup' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busyRef = useRef(false);
  const operationRef = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    const operation = ++operationRef.current;
    setBusy('list');
    setError(null);
    setNotice(null);
    const result = await loadWorkbenchTrash(effects);
    if (operation !== operationRef.current) return;
    if (result.status === 'ok') {
      setEntries(result.value);
      setSelected(new Set());
      setCleanupErrors([]);
    } else if (result.status === 'error') {
      setError(result.error);
    }
    busyRef.current = false;
    setBusy(null);
  }, [effects]);

  useEffect(() => {
    void reload();
    return () => {
      operationRef.current += 1;
      busyRef.current = false;
    };
  }, [reload]);

  const summary = useMemo(() => summarizeTrash(entries), [entries]);
  const errorsById = useMemo(
    () => new Map(cleanupErrors.map((item) => [item.id, item])),
    [cleanupErrors],
  );

  const toggle = (id: string): void => {
    if (busyRef.current) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const cleanup = async (): Promise<void> => {
    if (busyRef.current || selected.size === 0) return;
    busyRef.current = true;
    const operation = ++operationRef.current;
    setBusy('cleanup');
    setError(null);
    setNotice(null);
    const confirm = confirmCleanup ?? ((selection: TrashSummary): boolean => window.confirm(
      `确定永久删除选中的 ${selection.count} 项（${formatTrashBytes(selection.totalBytes)}）吗？此操作仅整理 Workbench 回收站，无法撤销。`,
    ));
    const result = await cleanupWorkbenchTrash(entries, [...selected], effects, confirm);
    if (operation !== operationRef.current) return;
    if (result.status !== 'cancelled') {
      setEntries(result.value.entries);
      const failures = result.value.cleanup?.errors ?? [];
      setCleanupErrors(failures);
      const retained = new Set(entries.filter((entry) => failures.some((item) => item.id === entry.id)).map((entry) => entry.id));
      setSelected(retained);
      if (result.value.cleanup !== null) {
        setNotice(`已永久删除 ${result.value.cleanup.removedIds.length} 项；${failures.length} 项未删除。`);
      }
    }
    if (result.status === 'error') setError(result.error);
    busyRef.current = false;
    setBusy(null);
  };

  return (
    <div className={styles.body} aria-label="健康检查" aria-busy={busy !== null}>
          <div className={styles.toolbar}>
            <p className={styles.summary} aria-live="polite">
              Workbench 回收站：{summary.count} 项，共 {formatTrashBytes(summary.totalBytes)}
            </p>
            <button type="button" onClick={() => { void reload(); }} disabled={busy !== null}>
              {busy === 'list' ? '刷新中…' : '刷新'}
            </button>
          </div>

          {error !== null ? <p className={styles.error} role="alert">{error}</p> : null}
          {notice !== null ? <p className={styles.notice} role="status">{notice}</p> : null}

          <div className={styles.list} role="list" aria-label="Workbench 回收站条目">
            {entries.length === 0 && busy !== 'list' ? (
              <p className={styles.empty}>Workbench 回收站为空（0 项，0 B）。</p>
            ) : null}
            {entries.map((entry) => {
              const itemError = errorsById.get(entry.id);
              return (
                <div className={styles.row} role="listitem" key={entry.id}>
                  <input
                    className={styles.checkbox}
                    type="checkbox"
                    checked={selected.has(entry.id)}
                    onChange={() => { toggle(entry.id); }}
                    disabled={busy !== null}
                    aria-label={`选择 ${entry.path ?? entry.id}`}
                  />
                  <div className={styles.itemMain}>
                    <p className={styles.path} title={entry.path ?? undefined}>{entry.path ?? '原路径未知'}</p>
                    <p className={styles.meta}>{formatDeletedAt(entry.deletedAt)} · {formatTrashBytes(entry.bytes)}</p>
                    {itemError !== undefined ? (
                      <p className={styles.itemError} role="alert">未删除：{itemError.code}：{itemError.message}</p>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>

          <section className={shared.dangerZone} aria-label="危险区：永久删除">
            <h3 className={shared.dangerTitle}>危险区</h3>
            <p className={shared.dangerHint}>
              永久删除会移除 Workbench 回收站中的文件，无法撤销；请先确认勾选项。
            </p>
            <footer className={styles.footer}>
              <span className={styles.selection}>已选择 {selected.size} 项</span>
              <span className={styles.spacer} />
              <button
                type="button"
                className={styles.dangerButton}
                onClick={() => { void cleanup(); }}
                disabled={busy !== null || selected.size === 0}
              >
                {busy === 'cleanup' ? '正在永久删除…' : '永久删除所选'}
              </button>
            </footer>
          </section>
    </div>
  );
}
