import { useEffect, useRef, useState } from 'react';
import { Z_MODAL } from '../../windows/layer-z.ts';
import {
  initialImportItems,
  runImport,
  type ImportConflict,
  type ImportItem,
  type ImportRunResult,
  type ImportRunnerEffects,
} from './import-runner.ts';
import styles from './import.module.css';

export interface ImportDialogEffects extends ImportRunnerEffects {
  pickFiles(): Promise<readonly string[]>;
}

export interface ImportDialogProps {
  readonly initialPaths: readonly string[];
  readonly defaultTargetDir: string;
  readonly effects: ImportDialogEffects;
  readonly onClose: () => void;
}

const STATUS_LABEL = {
  pending: '等待',
  running: '导入中',
  imported: '已导入',
  skipped: '已跳过',
  failed: '失败',
} as const;

function fileName(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized;
}

export function ImportDialog({ initialPaths, defaultTargetDir, effects, onClose }: ImportDialogProps) {
  const [items, setItems] = useState<readonly ImportItem[]>(() => initialImportItems(initialPaths));
  const [targetDir, setTargetDir] = useState(defaultTargetDir);
  const [conflict, setConflict] = useState<ImportConflict>('skip');
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [result, setResult] = useState<ImportRunResult | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => () => {
    mountedRef.current = false;
    cancelRef.current = true;
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !running) onClose();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onClose, running]);

  const pick = async (): Promise<void> => {
    setPickError(null);
    try {
      const paths = await effects.pickFiles();
      if (paths.length === 0 || !mountedRef.current) return;
      setItems((current) => initialImportItems([...current.map((item) => item.sourcePath), ...paths]));
      setResult(null);
    } catch (error: unknown) {
      if (mountedRef.current) setPickError(error instanceof Error ? error.message : String(error));
    }
  };

  const start = async (): Promise<void> => {
    if (running || items.length === 0) return;
    setRunning(true);
    setCancelling(false);
    setResult(null);
    setPickError(null);
    cancelRef.current = false;
    const completed = await runImport(
      items.map((item) => item.sourcePath),
      targetDir.trim(),
      conflict,
      effects,
      {
        onChange(next, active) {
          if (!mountedRef.current) return;
          setItems(next);
          setActiveIndex(active);
        },
        shouldCancel: () => cancelRef.current,
      },
    );
    if (!mountedRef.current) return;
    setItems(completed.items);
    setResult(completed);
    setActiveIndex(null);
    setRunning(false);
    setCancelling(false);
  };

  const processed = items.filter((item) => ['imported', 'skipped', 'failed'].includes(item.status)).length;
  const activePath = activeIndex === null ? null : items[activeIndex]?.sourcePath ?? null;

  return (
    <div className={styles.host} style={{ zIndex: Z_MODAL }}>
      <div
        className={styles.backdrop}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !running) onClose();
        }}
      >
        <section className={styles.panel} role="dialog" aria-modal="true" aria-label="导入 Markdown" aria-busy={running}>
          <header className={styles.header}>
            <h2 className={styles.title}>导入 Markdown</h2>
            <button type="button" className={styles.closeButton} onClick={onClose} disabled={running} aria-label="关闭导入">×</button>
          </header>
          <div className={styles.controls}>
            <label className={styles.field}>
              目标目录（库内相对路径，空值表示库根）
              <input value={targetDir} onChange={(event) => setTargetDir(event.target.value)} disabled={running} spellCheck={false} />
            </label>
            <label className={styles.field}>
              同名文件
              <select value={conflict} onChange={(event) => setConflict(event.target.value as ImportConflict)} disabled={running}>
                <option value="skip">跳过</option>
                <option value="rename">保留两者（自动改名）</option>
              </select>
            </label>
            <button type="button" className={styles.pickButton} onClick={() => { void pick(); }} disabled={running}>选择 Markdown 文件</button>
          </div>
          <div className={styles.list} role="list">
            {items.length === 0 ? <p className={styles.empty}>选择文件，或将 Finder 中的 Markdown 拖到文档列表。</p> : null}
            {items.map((item, index) => (
              <div className={styles.row} role="listitem" key={item.sourcePath}>
                <span className={styles.path} title={item.sourcePath}>{item.path ?? item.sourcePath}</span>
                <span className={styles.status}>{STATUS_LABEL[item.status]}</span>
                <button
                  type="button"
                  className={styles.removeButton}
                  aria-label={`移除 ${fileName(item.sourcePath)}`}
                  disabled={running}
                  onClick={() => setItems((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                >
                  移除
                </button>
                {item.message !== null ? <p className={styles.message}>{item.message}</p> : null}
              </div>
            ))}
          </div>
          <p className={styles.progress} aria-live="polite">
            {running
              ? `${processed} / ${items.length}${activePath !== null ? ` · 当前：${fileName(activePath)}` : ''}${cancelling ? ' · 将在当前文件结束后取消' : ''}`
              : `${processed} / ${items.length}`}
          </p>
          {pickError !== null ? <p className={styles.error} role="alert">文件选择失败：{pickError}</p> : null}
          {result?.fatalError != null ? <p className={styles.error} role="alert">{result.fatalError}</p> : null}
          {result !== null ? (
            <p className={styles.summary} role="status">
              已导入 {result.imported}，跳过 {result.skipped}，失败 {result.failed}{result.cancelled ? '；已取消后续文件，已导入文件保留' : ''}
            </p>
          ) : null}
          <footer className={styles.footer}>
            <span className={styles.hint}>原文件保持不变；不会覆盖同名文档。</span>
            <span className={styles.spacer} />
            {running ? (
              <button type="button" disabled={cancelling} onClick={() => { cancelRef.current = true; setCancelling(true); }}>取消后续导入</button>
            ) : (
              <button type="button" onClick={onClose}>关闭</button>
            )}
            <button type="button" className={styles.primary} onClick={() => { void start(); }} disabled={running || items.length === 0}>
              {running ? '导入中…' : '开始导入'}
            </button>
          </footer>
        </section>
      </div>
    </div>
  );
}
