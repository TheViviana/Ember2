/**
 * CR-20261119-22：备份面板（模态对话框）。
 *
 * 纯 features 组件：零 @tauri-apps、零 src/data、零 src/app、零 zustand（gate:layers + CR §2.3）。
 * 所有 I/O 由 AppShell 通过 BackupPanelEffects 注入；IPC reject 形状为 Error + code（= rawCode，
 * 由 AppShell rethrow 保留），本组件只按形状读取，不 import data 层类型。
 *
 * 流程（CR §3 D2）：选父目录 → validateDestination(父目录) → inspectBackup(<父目录>/<名>)
 *   ├─ 已有备份 → done 展示检查结果
 *   └─ E_NOT_FOUND → exportBackup(子路径) → done 展示报告 / error（E_INVALID_ARG=目标已存在，绝不覆盖）
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import type {
  BackupDestinationDto,
  BackupInspectDto,
  BackupReportDto,
} from '../../types/ipc.ts';
import { Z_MODAL } from '../../windows/layer-z.ts';
import { mapBackupErrorCode } from './backup-errors.ts';
import { formatBytes, formatTime } from './backup-format.ts';
import {
  classifyExportResult,
  classifyInspectResult,
  generateDefaultBackupName,
  normalizeFailure,
  validateBackupName,
} from './backup-flow.ts';
import {
  backupPanelReducer,
  createBackupPanelState,
  type BackupPanelState,
} from './backup-reducer.ts';
import styles from './backup.module.css';

// ─── Effects（AppShell 注入的 IPC 桥）──────────────────────────────

export interface BackupPanelEffects {
  /** 系统文件夹选择器；用户取消返回 null（非错误）。 */
  pickDirectory(): Promise<string | null>;
  /** 校验已存在的父目录（存在 / 可写 / 不在库内）。 */
  validateDestination(parentDir: string): Promise<BackupDestinationDto>;
  /** 导出到 `<父目录>/<backupName>` 子路径；该子目录必须尚不存在。 */
  exportBackup(destination: string): Promise<BackupReportDto>;
  /** 检查 `<父目录>/<backupName>` 子路径；须已存在且含 manifest.json，否则 E_NOT_FOUND。 */
  inspectBackup(destination: string): Promise<BackupInspectDto>;
}

// ─── Props ─────────────────────────────────────────────────────────

export interface BackupPanelProps {
  readonly onClose: () => void;
  readonly effects: BackupPanelEffects;
}

// ─── Helpers ────────────────────────────────────────────────────────

function isBusyStatus(status: BackupPanelState['status']): boolean {
  return status === 'validating' || status === 'inspecting' || status === 'exporting';
}

// ─── Component ──────────────────────────────────────────────────────

export function BackupPanel({ onClose, effects }: BackupPanelProps) {
  const [state, dispatch] = useReducer(
    backupPanelReducer,
    undefined,
    () => createBackupPanelState(new Date()),
  );

  // 备份名草稿：展示原始输入（含非法值），reducer 只收合法值（D3 规则 2）。
  const [nameDraft, setNameDraft] = useState<string>(state.backupName);
  useEffect(() => {
    setNameDraft(state.backupName);
  }, [state.backupName]);

  const pickingRef = useRef(false);
  const pickButtonRef = useRef<HTMLButtonElement | null>(null);

  const busy = isBusyStatus(state.status);
  const nameValid = validateBackupName(nameDraft);

  // 打开时焦点进入「选择目录」。
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      pickButtonRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  // Esc 仅非 in-flight 关闭（D5）；capture 与 AiPanel 同款。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (isBusyStatus(state.status)) return;
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose, state.status]);

  // ── effects 驱动（在途阶段 → IPC；卸载后 reject 以 console.error 落地，不 setState，R3）──
  useEffect(() => {
    if (state.status !== 'validating' || state.selectedDir === null) return;
    let live = true;
    void effects.validateDestination(state.selectedDir)
      .then(() => {
        if (live) dispatch({ type: 'VALIDATE_OK' });
      })
      .catch((e: unknown) => {
        if (!live) {
          console.error('[BackupPanel] validateDestination 失败（面板已卸载）', e);
          return;
        }
        const failure = normalizeFailure(e);
        dispatch({ type: 'VALIDATE_ERR', code: failure.code, message: failure.message });
      });
    return () => {
      live = false;
    };
  }, [effects, state.status, state.selectedDir]);

  useEffect(() => {
    if (state.status !== 'inspecting' || state.destination === null) return;
    let live = true;
    void effects.inspectBackup(state.destination)
      .then((inspect) => {
        if (live) dispatch({ type: 'INSPECT_OK', inspect });
      })
      .catch((e: unknown) => {
        if (!live) {
          console.error('[BackupPanel] inspectBackup 失败（面板已卸载）', e);
          return;
        }
        const failure = normalizeFailure(e);
        const out = classifyInspectResult({ ok: false, failure });
        if (out.kind === 'should-export') dispatch({ type: 'INSPECT_NOT_FOUND' });
        if (out.kind === 'error') {
          dispatch({ type: 'INSPECT_ERR', code: out.code, message: out.message });
        }
      });
    return () => {
      live = false;
    };
  }, [effects, state.status, state.destination]);

  useEffect(() => {
    if (state.status !== 'exporting' || state.destination === null) return;
    let live = true;
    void effects.exportBackup(state.destination)
      .then((report) => {
        if (live) dispatch({ type: 'EXPORT_OK', report });
      })
      .catch((e: unknown) => {
        if (!live) {
          console.error('[BackupPanel] exportBackup 失败（面板已卸载）', e);
          return;
        }
        const failure = normalizeFailure(e);
        const out = classifyExportResult({ ok: false, failure });
        if (out.kind === 'error') {
          dispatch({ type: 'EXPORT_ERR', code: out.code, message: out.message });
        }
      });
    return () => {
      live = false;
    };
  }, [effects, state.status, state.destination]);

  // ── 事件回调 ────────────────────────────────────────────────────────

  const handlePick = useCallback(async () => {
    if (pickingRef.current) return;
    pickingRef.current = true;
    try {
      const dir = await effects.pickDirectory();
      if (dir !== null) {
        dispatch({ type: 'PICK', dir, name: generateDefaultBackupName(new Date()) });
      } else {
        dispatch({ type: 'PICK', dir: null, name: '' }); // 取消不报错（B4）
      }
    } catch (e) {
      // 系统选择器异常：零吞错，落 error 态（PICK_ERR，偏差 D1 见 §10）。
      const failure = normalizeFailure(e);
      dispatch({ type: 'PICK_ERR', code: failure.code, message: failure.message });
    } finally {
      pickingRef.current = false;
    }
  }, [effects]);

  const handleNameChange = useCallback((value: string): void => {
    setNameDraft(value);
    dispatch({ type: 'NAME_CHANGE', name: value }); // 非法值由 reducer 忽略
  }, []);

  const handleGo = useCallback((): void => {
    dispatch({ type: 'GO' });
  }, []);

  const handleClose = useCallback((): void => {
    dispatch({ type: 'CLOSE' });
    onClose();
  }, [onClose]);

  // ── 展示派生 ────────────────────────────────────────────────────────

  const errorMsg = useMemo(() => {
    if (state.error === null) return null;
    return mapBackupErrorCode(state.error.code, state.error.message, state.error.phase);
  }, [state.error]);
  const rawDetail = state.error !== null
    && errorMsg !== null
    && state.error.message.length > 0
    && errorMsg.text !== state.error.message
    ? state.error.message
    : null;

  const goDisabled = busy || state.selectedDir === null || !nameValid;
  const showDestination = state.selectedDir !== null && nameValid && state.destination !== null;

  return (
    <div className={styles.host} style={{ zIndex: Z_MODAL }} data-backup-host="true">
      {/* 遮罩点击在空闲时关闭；在途操作期间不关闭（防误关丢进度） */}
      <div
        className={styles.backdrop}
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !busy) handleClose();
        }}
      >
        <div
          className={styles.panel}
          role="dialog"
          aria-modal="true"
          aria-label="备份"
          aria-busy={busy}
        >
          <header className={styles.header}>
            <h2 className={styles.title}>备份</h2>
            <button
              type="button"
              className={styles.closeBtn}
              onClick={handleClose}
              disabled={busy}
              aria-label="关闭备份面板"
            >
              ×
            </button>
          </header>

          {/* ── 目录选择 ── */}
          <section className={styles.section}>
            <div className={styles.dirRow}>
              <button
                type="button"
                className={styles.ghostBtn}
                onClick={() => { void handlePick(); }}
                disabled={busy}
                ref={pickButtonRef}
              >
                选择目录
              </button>
              <span className={styles.dirValue}>
                {state.selectedDir ?? '未选择（选择要写入备份的父目录）'}
              </span>
            </div>
          </section>

          {/* ── 备份名 ── */}
          <section className={styles.section}>
            <label className={styles.sectionLabel} htmlFor="backup-name">备份名</label>
            <input
              id="backup-name"
              type="text"
              className={styles.input}
              value={nameDraft}
              onChange={(e) => handleNameChange(e.target.value)}
              disabled={busy}
              spellCheck={false}
              autoComplete="off"
            />
            {!nameValid ? (
              <p className={styles.hintError}>
                备份名仅允许字母、数字与 . _ -，不以点开头/结尾；保留名 CON / PRN / AUX / NUL / COM1-9 / LPT1-9 不可用
              </p>
            ) : null}
            {showDestination ? (
              <p className={styles.hint}>目标：<code>{state.destination}</code></p>
            ) : null}
          </section>

          {/* ── 状态 / 结果 / 错误 ── */}
          <section className={styles.section} aria-live="polite">
            {state.status === 'validating' ? (
              <p className={styles.infoBox}>正在校验父目录…</p>
            ) : null}
            {state.status === 'inspecting' ? (
              <p className={styles.infoBox}>正在检查该位置是否已有备份…</p>
            ) : null}
            {state.status === 'exporting' ? (
              <p className={styles.infoBox}>正在导出备份…</p>
            ) : null}
            {state.result?.mode === 'export' ? (
              <div className={styles.resultBox}>
                <p className={styles.resultTitle}>备份完成</p>
                <p>目标：{state.result.report.path}</p>
                <p>文件数：{state.result.report.files}</p>
                <p>大小：{formatBytes(state.result.report.bytes)}</p>
                <p>时间：{formatTime(state.result.report.createdAt)}</p>
              </div>
            ) : null}
            {state.result?.mode === 'inspect' ? (
              <div className={styles.resultBox}>
                <p className={styles.resultTitle}>已找到现有备份</p>
                <p>目标：{state.result.inspect.path}</p>
                <p>版本：{state.result.inspect.version}</p>
                <p>源库：{state.result.inspect.sourceRoot}</p>
                <p>文件数：{state.result.inspect.files}</p>
                <p>大小：{formatBytes(state.result.inspect.bytes)}</p>
                <p>时间：{formatTime(state.result.inspect.createdAt)}</p>
              </div>
            ) : null}
            {errorMsg !== null ? (
              <p className={errorMsg.tone === 'error' ? styles.errorBox : styles.warningBox}>
                {errorMsg.text}
              </p>
            ) : null}
            {rawDetail !== null ? <p className={styles.errorDetail}>{rawDetail}</p> : null}
          </section>

          {/* ── 操作 ── */}
          <footer className={styles.actions}>
            <span className={styles.actionsSpacer} />
            <button
              type="button"
              className={styles.ghostBtn}
              onClick={handleClose}
              disabled={busy}
            >
              关闭
            </button>
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={handleGo}
              disabled={goDisabled}
            >
              检查 / 导出
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}
