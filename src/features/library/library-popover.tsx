/**
 * CR-20261119-14：库管理 popover 组件（纯 UI，接 props，不调 IPC）。
 *
 * 依赖：react 18+、features 层内部纯函数。
 * 禁引：src/app、@tauri-apps、packages。
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { LibraryDto } from '../../../src/types/ipc.ts';
import { validateLibraryPath } from './library-validate.ts';
import { mapLibraryIpcError } from './library-errors.ts';
import type { SwitchStateSnapshot } from './switch-coordinator.ts';
import styles from './library-popover.module.css';

export interface PopoverTriggerRect {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface LibraryPopoverProps {
  /** 库列表状态（来自 StatusBar 宿主的 useReducer） */
  readonly libraryList: readonly LibraryDto[];
  readonly loading: boolean;
  readonly error: string | null;
  /** 当前库 id（来自 library_list 返回的 current:true，而非 identity.vaultId） */
  readonly currentId: string | null;
  /** 打开时调用一次（用于触发 library_list） */
  readonly onOpen: () => void;
  /** 用户点「添加」按钮——StatusBar 宿主需调 library_add 后 library_list */
  readonly onAddLibrary: (path: string, name?: string) => Promise<void>;
  /** 用户点「移除」按钮——StatusBar 宿主需调 library_remove 后 library_list */
  readonly onRemoveLibrary: (id: string) => Promise<void>;
  /** 用户要求关闭（Esc / 遮罩点击 / 成功添加后） */
  readonly onClose: () => void;
  /** 打开后刷新（错误重试） */
  readonly onRefresh: () => void;
  /** 定位用：StatusBar root span 的 boundingRect */
  readonly triggerRect: PopoverTriggerRect;
  /** 用户点「选择文件夹…」。宿主 StatusBar 负责调 dialog open。 */
  readonly onPickDirectory: () => Promise<string | null>;
  /** CR-20261119-16：用户确认切换到目标库。宿主 StatusBar 负责调 switchCoordinator.start。 */
  readonly onSwitchLibrary: (targetId: string) => Promise<void>;
  /** CR-20261119-16：switchCoordinator 当前状态（来自宿主 useState）。null 表示未开始。 */
  readonly switchState: SwitchStateSnapshot | null;
}

/** popover 在 triggerRect 上方显示（footer 上方）；fallback 到下方 */
function computePopoverTop(triggerRect: PopoverTriggerRect): number {
  const panelHeightEstimate = 360;
  const spaceAbove = triggerRect.top;
  return spaceAbove >= panelHeightEstimate + 20
    ? triggerRect.top - panelHeightEstimate - 8
    : triggerRect.bottom + 4;
}

function computePopoverLeft(triggerRect: PopoverTriggerRect, panelWidthEstimate = 360): number {
  let left = triggerRect.left;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  if (left + panelWidthEstimate > vw - 12) {
    left = vw - panelWidthEstimate - 12;
  }
  if (left < 12) left = 12;
  return left;
}

export function LibraryPopover(props: LibraryPopoverProps): ReactNode {
  const {
    libraryList,
    loading,
    error,
    currentId,
    onOpen,
    onAddLibrary,
    onRemoveLibrary,
    onClose,
    onRefresh,
    triggerRect,
    onPickDirectory,
    onSwitchLibrary,
    switchState,
  } = props;

  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const onPickDirectoryRef = useRef(onPickDirectory);
  onPickDirectoryRef.current = onPickDirectory;

  const [pathInput, setPathInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [addErrorInline, setAddErrorInline] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [isPickingDir, setIsPickingDir] = useState(false);
  const [switchConfirmId, setSwitchConfirmId] = useState<string | null>(null);
  const isSwitching = switchState !== null
    && switchState.state !== 'idle'
    && switchState.state !== 'done'
    && switchState.state !== 'failed'
    && switchState.state !== 'cancelled';

  const panelRef = useRef<HTMLDivElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);

  // ── 打开时触发 library_list 拉取 + 聚焦路径 input ──
  useEffect(() => {
    onOpenRef.current();
    // 下一帧聚焦（panel DOM 已挂载）
    const raf = requestAnimationFrame(() => pathInputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
    // 只在挂载时跑一次——onOpen 由宿主 StatusBar 提供的稳定回调
  }, []);

  // ── Esc 关闭 + 焦点归还 ──
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // ── 点击面板外关闭 ──
  const onScrimMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>): void => {
    // 遮罩是 panel 父级；点 scrim 关闭，点 panel 内部不关闭
    if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
      onClose();
    }
  }, [onClose]);

  // ── 添加库 ──
  const onAddClick = useCallback(async (): Promise<void> => {
    const path = pathInput.trim();
    const v = validateLibraryPath(path);
    if (!v.ok) {
      setAddErrorInline(v.message ?? '路径格式不合法');
      pathInputRef.current?.focus();
      return;
    }

    setIsAdding(true);
    setAddErrorInline(null);
    try {
      const name = nameInput.trim() || undefined;
      await onAddLibrary(path, name);
      setPathInput('');
      setNameInput('');
    } catch (e) {
      const payload = asIpcError(e);
      setAddErrorInline(mapLibraryIpcError(payload));
      pathInputRef.current?.focus();
    } finally {
      setIsAdding(false);
    }
  }, [pathInput, nameInput, onAddLibrary]);

  // ── 移除库（需 Popconfirm） ──
  const onRemoveRequest = useCallback((id: string): void => {
    setRemovingId(id);
  }, []);

  const onRemoveConfirm = useCallback(async (id: string): Promise<void> => {
    setIsRemoving(true);
    try {
      await onRemoveLibrary(id);
    } catch (_e) {
      // StatusBar 宿主会 pushNotice error；popover 里关闭确认态即可
    } finally {
      setIsRemoving(false);
      setRemovingId(null);
    }
  }, [onRemoveLibrary]);

  const onRemoveCancel = useCallback((): void => {
    setRemovingId(null);
  }, []);

  // ── 选择文件夹（只回填 pathInput，不自动调用 library_add） ──
  const onPickDirClick = useCallback(async (): Promise<void> => {
    setIsPickingDir(true);
    setAddErrorInline(null);
    try {
      const picked = await onPickDirectoryRef.current();
      if (picked !== null) {
        setPathInput(picked);
        pathInputRef.current?.focus();
      }
      // null = 用户取消，静默返回
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setAddErrorInline('选择文件夹失败：' + msg);
    } finally {
      setIsPickingDir(false);
    }
  }, []);

  // ── 定位 ──
  const top = computePopoverTop(triggerRect);
  const left = computePopoverLeft(triggerRect);

  // ── 渲染 ──
  return (
    <div className={styles.scrim} onMouseDown={onScrimMouseDown}>
      <div
        ref={panelRef}
        role="dialog"
        aria-label="库管理"
        className={styles.panel}
        style={{ top, left }}
      >
        <header className={styles.header}>
          库管理
          {error && <div className={styles.headerError}>加载失败：{error}</div>}
        </header>

        <LibraryListBody
          loading={loading}
          error={error}
          items={libraryList}
          currentId={currentId}
          removingId={removingId}
          isRemoving={isRemoving}
          onRefresh={onRefresh}
          onRemoveRequest={onRemoveRequest}
          onRemoveConfirm={onRemoveConfirm}
          onRemoveCancel={onRemoveCancel}
          switchConfirmId={switchConfirmId}
          isSwitching={isSwitching}
          onSwitchRequest={setSwitchConfirmId}
          onSwitchConfirm={(id) => onSwitchLibrary(id).finally(() => setSwitchConfirmId(null))}
          onSwitchCancel={() => setSwitchConfirmId(null)}
        />

        <form
          className={styles.addForm}
          onSubmit={(e) => { e.preventDefault(); void onAddClick(); }}
        >
          <div className={styles.addFormRow}>
            <input
              ref={pathInputRef}
              className={styles.addFormInput + (addErrorInline ? ' ' + styles.addFormInputInvalid : '')}
              type="text"
              aria-label="库路径（绝对路径）"
              aria-invalid={addErrorInline ? 'true' : 'false'}
              placeholder="绝对路径，如 /Users/xxx/Documents/MyVault"
              value={pathInput}
              onChange={(e) => {
                setPathInput(e.target.value);
                if (addErrorInline) setAddErrorInline(null);
              }}
              disabled={isAdding}
            />
            <button
              type="button"
              className={styles.pickButton}
              disabled={isAdding || loading || isPickingDir}
              onClick={() => { void onPickDirClick(); }}
              title="从系统文件夹选择器挑选路径"
            >
              {isPickingDir ? '打开中…' : '选择文件夹…'}
            </button>
          </div>
          <input
            className={styles.addFormInput}
            type="text"
            aria-label="库名称（可选）"
            placeholder="名称（可选，留空取目录名）"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            disabled={isAdding || isPickingDir}
          />
          {addErrorInline && <div className={styles.addFormError} role="alert">{addErrorInline}</div>}
          <div className={styles.addFormActions}>
            <button className={styles.addFormButton} type="submit" disabled={isAdding || loading}>
              {isAdding ? '添加中…' : '添加库'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── ListBody 子组件 ──

export interface LibraryListBodyProps {
  readonly loading: boolean;
  readonly error: string | null;
  readonly items: readonly LibraryDto[];
  readonly currentId: string | null;
  readonly removingId: string | null;
  readonly isRemoving: boolean;
  readonly onRefresh: () => void;
  readonly onRemoveRequest: (id: string) => void;
  readonly onRemoveConfirm: (id: string) => Promise<void>;
  readonly onRemoveCancel: () => void;
  /** CR-20261119-16：切换 CONFIRM 框状态（由 LibraryPopover 管理）。 */
  readonly switchConfirmId: string | null;
  readonly isSwitching: boolean;
  readonly onSwitchRequest: (id: string) => void;
  readonly onSwitchConfirm: (id: string) => Promise<void>;
  readonly onSwitchCancel: () => void;
}

export function LibraryListBody(props: LibraryListBodyProps): ReactNode {
  const {
    loading, error, items, currentId,
    removingId, isRemoving,
    onRefresh, onRemoveRequest, onRemoveConfirm, onRemoveCancel,
    switchConfirmId, isSwitching, onSwitchRequest, onSwitchConfirm, onSwitchCancel,
  } = props;

  if (loading && items.length === 0) {
    return <div className={styles.listMessage}>加载库列表…</div>;
  }

  if (error && items.length === 0) {
    return (
      <div className={styles.listMessage}>
        无法加载库列表
        <button className={styles.listErrorRetry} onClick={onRefresh}>重试</button>
      </div>
    );
  }

  if (items.length === 0) {
    return <div className={styles.listMessage}>暂无已注册的库</div>;
  }

  return (
    <ul className={styles.list} aria-label="已注册库">
      {items.map((item) => {
        const isCurrent = item.id === currentId || item.current;
        const isUnavailable = !item.available;
        const showPopconfirm = removingId === item.id;

        return (
          <li
            key={item.id}
            className={styles.listItem}
            role="listitem"
            aria-current={isCurrent ? 'true' : undefined}
            aria-disabled={isUnavailable ? 'true' : undefined}
          >
            <span
              className={
                styles.listItemIcon +
                ' ' +
                (isCurrent ? styles.listItemIconCurrent : '') +
                ' ' +
                (isUnavailable ? styles.listItemIconUnavailable : '')
              }
              aria-hidden="true"
            >
              {isCurrent ? '✓' : isUnavailable ? '⚠' : ''}
            </span>

            <span className={styles.listItemName}>{item.name || item.path}</span>

            {/* 切换按钮 — CR-20261119-16：可点 + CONFIRM 框 */}
            {switchConfirmId === item.id ? (
              <div className={styles.popconfirm} role="alertdialog" aria-label="确认切换">
                <span className={styles.popconfirmMessage}>
                  切换将关闭当前所有编辑器与画布，已打开文档会自动落盘。确定切换到「
                  {item.name || item.path}」？
                </span>
                <button
                  type="button"
                  className={styles.popconfirmConfirm}
                  disabled={isSwitching}
                  onClick={() => void onSwitchConfirm(item.id)}
                >
                  {isSwitching ? '切换中…' : '确定切换'}
                </button>
                <button type="button" disabled={isSwitching} onClick={onSwitchCancel}>取消</button>
              </div>
            ) : (
              <button
                type="button"
                className={styles.itemAction}
                disabled={isCurrent || isUnavailable || isSwitching}
                title={isCurrent ? '已在该库下' : isUnavailable ? '该库目录不可用' : undefined}
                onClick={() => onSwitchRequest(item.id)}
              >
                {isSwitching ? '…' : '切换'}
              </button>
            )}

            {/* 移除按钮 */}
            {showPopconfirm ? (
              <div className={styles.popconfirm} role="alertdialog" aria-label="确认移除">
                确定移除？
                <button
                  type="button"
                  className={styles.popconfirmConfirm}
                  disabled={isRemoving}
                  onClick={() => void onRemoveConfirm(item.id)}
                >
                  {isRemoving ? '…' : '移除'}
                </button>
                <button type="button" onClick={onRemoveCancel}>取消</button>
              </div>
            ) : (
              <button
                type="button"
                className={styles.itemAction + ' ' + styles.itemActionRemove}
                disabled={isCurrent}
                title={isCurrent ? '不能移除当前库' : undefined}
                onClick={() => onRemoveRequest(item.id)}
              >
                移除
              </button>
            )}

            <span className={styles.listItemPath} title={item.path}>{item.path}</span>
          </li>
        );
      })}
    </ul>
  );
}

// ─── IPC error 兼容（from src/core/errors.ts FrontendError） ──

interface IpcErrorPayload {
  readonly code: string;
  readonly message: string;
}

function asIpcError(e: unknown): IpcErrorPayload {
  if (e && typeof e === 'object') {
    const obj = e as Record<string, unknown>;
    if (typeof obj.code === 'string' && typeof obj.message === 'string') {
      return { code: obj.code, message: obj.message };
    }
    if (typeof obj.code === 'string' && typeof obj.description === 'string') {
      return { code: obj.code, message: obj.description };
    }
  }
  return { code: 'E_UNKNOWN', message: e instanceof Error ? e.message : String(e) };
}
