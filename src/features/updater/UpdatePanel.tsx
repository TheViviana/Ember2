/**
 * 设置壳「关于」页：当前版本与检查更新。
 *
 * 原 UpdatePanel 去掉宿主 / 遮罩 / 标题 / 关闭按钮，外框由 SettingsShell 提供。
 */
import { useCallback, useEffect, useState } from 'react';
import type { PendingUpdate, UpdateProgress } from '../../data/updater-port.ts';
import {
  formatProgress,
  loadAutoCheck,
  normalizeReleaseNotes,
  saveAutoCheck,
} from './model.ts';
import styles from './update-panel.module.css';
import { formatUnknownError } from '../../core/errors.ts';

export interface UpdatePanelEffects {
  currentVersion(): Promise<string>;
  check(): Promise<PendingUpdate | null>;
}

export interface AboutSettingsBodyProps {
  readonly effects: UpdatePanelEffects;
}

type Phase = 'idle' | 'checking' | 'uptodate' | 'available' | 'installing' | 'installed';

export function AboutSettingsBody({ effects }: AboutSettingsBodyProps) {
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [pending, setPending] = useState<PendingUpdate | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoCheck, setAutoCheck] = useState(() => loadAutoCheck(window.localStorage));
  const [autoCheckError, setAutoCheckError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    void effects.currentVersion().then((version) => {
      if (!disposed) setCurrentVersion(version);
    }).catch((cause: unknown) => {
      if (!disposed) setError(`读取当前版本失败：${formatUnknownError(cause, '未知更新错误')}`);
    });
    return () => {
      disposed = true;
    };
  }, [effects]);

  const check = useCallback(async (): Promise<void> => {
    setPhase('checking');
    setError(null);
    setProgress(null);
    setPending(null);
    try {
      const next = await effects.check();
      if (next === null) {
        setPhase('uptodate');
        return;
      }
      setPending(next);
      setPhase('available');
    } catch (cause: unknown) {
      setPhase('idle');
      setError(`检查更新失败：${formatUnknownError(cause, '未知更新错误')}`);
    }
  }, [effects]);

  const install = useCallback(async (): Promise<void> => {
    if (pending === null) return;
    setPhase('installing');
    setError(null);
    setProgress({ downloaded: 0, total: null });
    try {
      await pending.downloadAndInstall((next) => setProgress(next));
      setPhase('installed');
    } catch (cause: unknown) {
      setPhase('available');
      setError(`下载或安装失败：${formatUnknownError(cause, '未知更新错误')}`);
    }
  }, [pending]);

  const toggleAutoCheck = (): void => {
    const next = !autoCheck;
    setAutoCheck(next);
    setAutoCheckError(saveAutoCheck(window.localStorage, next));
  };

  const notes = pending === null ? null : normalizeReleaseNotes(pending.body);
  const busy = phase === 'checking' || phase === 'installing';

  return (
    <div className={styles.root}>
      <p className={styles.current}>当前版本 {currentVersion ?? '读取中…'}</p>

      <label className={styles.toggle}>
        <input type="checkbox" checked={autoCheck} onChange={toggleAutoCheck} disabled={phase === 'installing'} />
        <span>启动时静默检查更新</span>
      </label>
      {autoCheckError !== null ? <p className={styles.error} role="alert">{autoCheckError}</p> : null}

      <div className={styles.body} aria-live="polite">
        {phase === 'idle' ? <p className={styles.hint}>点击下方按钮检查新版本。</p> : null}
        {phase === 'checking' ? <p className={styles.hint}>正在检查更新…</p> : null}
        {phase === 'uptodate' ? <p className={styles.notice}>已是最新版本。</p> : null}
        {pending !== null && phase !== 'installed' ? (
          <div className={styles.release}>
            <p className={styles.version}>新版本 {pending.version}</p>
            {pending.date !== null ? <p className={styles.meta}>发布时间 {pending.date}</p> : null}
            {notes !== null ? <pre className={styles.notes}>{notes}</pre> : null}
          </div>
        ) : null}
        {phase === 'installing' && progress !== null ? (
          <p className={styles.hint}>{formatProgress(progress.downloaded, progress.total)}</p>
        ) : null}
        {phase === 'installed' ? (
          <p className={styles.notice}>更新已安装，退出并重新打开 Ember 后生效。</p>
        ) : null}
        {error !== null ? <p className={styles.error} role="alert">{error}</p> : null}
      </div>

      <footer className={styles.footer}>
        <span className={styles.spacer} />
        <button type="button" onClick={() => { void check(); }} disabled={busy}>检查更新</button>
        {pending !== null && phase !== 'installed' ? (
          <button type="button" className={styles.primaryButton} onClick={() => { void install(); }} disabled={busy}>
            {phase === 'installing' ? '安装中…' : '下载并安装'}
          </button>
        ) : null}
      </footer>
    </div>
  );
}
