/**
 * 设置壳「同步」页：知识库与媒体库。
 *
 * 一个页面两个标签页：
 * - 知识库：列表 / 切换 / 添加 / 移除（逻辑自 StatusBar popover 迁入）；
 * - 媒体库：复用 MediaLibraryBody。
 *
 * 外框、标题与关闭由 SettingsShell 提供。
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { libraryApi } from '../../data/app-api.ts';
import { openDirectory } from '../../data/dialog.ts';
import type {
  LibraryAddRequest,
  LibraryCurrentRequest,
  LibraryDto,
  LibraryRemoveRequest,
} from '../../types/ipc';
import {
  LibraryListBody,
} from '../../features/library/library-popover.tsx';
import {
  LIBRARY_LIST_INITIAL,
  libraryListReducer,
} from '../../features/library/library-list-reducer.ts';
import {
  createSwitchCoordinator,
  type SwitchCoordinator,
  type SwitchStateSnapshot,
} from '../../features/library/switch-coordinator.ts';
import { lockAllEditors, resumeAllEditors } from '../editor-lock-registry.ts';
import { useEmberStore } from '../stores/ember-store.ts';
import { pushNotice } from '../stores/notice-store.ts';
import { validateLibraryPath } from '../../features/library/library-validate.ts';
import { mapLibraryIpcError } from '../../features/library/library-errors.ts';
import { MediaLibraryBody } from './MediaLibraryWindow.tsx';
import styles from './library-settings-panel.module.css';

type LibraryTab = 'vaults' | 'media';

function asIpcError(error: unknown): { code: string; message: string } {
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (typeof record.code === 'string' && typeof record.message === 'string') {
      return { code: record.code, message: record.message };
    }
    if (typeof record.code === 'string' && typeof record.description === 'string') {
      return { code: record.code, message: record.description };
    }
  }
  return { code: 'E_UNKNOWN', message: error instanceof Error ? error.message : String(error) };
}

export function LibrarySettingsBody() {
  const [tab, setTab] = useState<LibraryTab>('vaults');
  const [libraryState, dispatch] = useReducer(libraryListReducer, LIBRARY_LIST_INITIAL);
  const [switchSnap, setSwitchSnap] = useState<SwitchStateSnapshot | null>(null);
  const [switchConfirmId, setSwitchConfirmId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [isPicking, setIsPicking] = useState(false);

  const refreshList = useCallback(async (): Promise<void> => {
    try {
      const items = await libraryApi.list();
      dispatch({ type: 'REFRESH', items });
    } catch (error) {
      dispatch({ type: 'REFRESH_FAIL', message: asIpcError(error).message });
    }
  }, []);

  useEffect(() => {
    dispatch({ type: 'OPEN' });
    void refreshList();
  }, [refreshList]);

  const currentId = useMemo((): string | null => {
    if (libraryState.kind !== 'ok') return null;
    const found = libraryState.items.find((item) => item.current);
    return found ? found.id : null;
  }, [libraryState]);

  const coordinatorRef = useRef<SwitchCoordinator | null>(null);
  if (coordinatorRef.current === null) {
    coordinatorRef.current = createSwitchCoordinator({
      effects: {
        async flushDocs() {
          await useEmberStore.getState().flushDocs();
        },
        async flushCanvases() {
          await useEmberStore.getState().flushCanvases();
        },
        lockEditors() {
          lockAllEditors();
        },
        resumeEditors() {
          resumeAllEditors();
        },
        sealCanvases() {
          useEmberStore.getState().beginCanvasClosing();
        },
        unsealCanvases() {
          useEmberStore.getState().cancelCanvasClosing();
        },
        async libraryCurrent(id: string) {
          const request: LibraryCurrentRequest = { id };
          await libraryApi.current(request);
        },
        async disposeCore() {
          await useEmberStore.getState().disposeCore();
        },
        async rebuildCore() {
          await useEmberStore.getState().rebuildCore();
        },
        async reloadLibraryList() {
          await refreshList();
        },
        onStateChange(snapshot) {
          setSwitchSnap(snapshot);
        },
      },
    });
  }

  const handleSwitch = useCallback(async (targetId: string): Promise<void> => {
    const coordinator = coordinatorRef.current;
    if (coordinator === null) return;
    const oldId = currentId;
    if (oldId === null) {
      pushNotice('无法切换：未识别当前库', 'error');
      return;
    }
    if (targetId === oldId) {
      pushNotice('已经在该库下', 'info');
      return;
    }
    try {
      await coordinator.start(targetId, oldId);
      await refreshList();
      pushNotice('库已切换', 'info');
    } catch (error) {
      const detail = asIpcError(error).message;
      pushNotice('切换失败：' + detail, 'error');
      await refreshList();
    }
  }, [currentId, refreshList]);

  const handleRemove = useCallback(async (id: string): Promise<void> => {
    setIsRemoving(true);
    const request: LibraryRemoveRequest = { id };
    try {
      await libraryApi.remove(request);
      await refreshList();
    } catch (error) {
      const detail = asIpcError(error).message;
      pushNotice('移除库失败：' + detail, 'error');
      throw error;
    } finally {
      setIsRemoving(false);
      setRemovingId(null);
    }
  }, [refreshList]);

  const handlePickDirectory = useCallback(async (): Promise<void> => {
    setIsPicking(true);
    setAddError(null);
    try {
      const picked = await openDirectory();
      if (picked !== null) setPathInput(picked);
    } catch (error) {
      setAddError('选择文件夹失败：' + asIpcError(error).message);
    } finally {
      setIsPicking(false);
    }
  }, []);

  const handleAdd = useCallback(async (): Promise<void> => {
    const path = pathInput.trim();
    const validation = validateLibraryPath(path);
    if (!validation.ok) {
      setAddError(validation.message ?? '路径格式不合法');
      return;
    }
    setIsAdding(true);
    setAddError(null);
    const request: LibraryAddRequest = {
      path,
      name: nameInput.trim() || undefined,
    };
    try {
      await libraryApi.add(request);
      setPathInput('');
      setNameInput('');
      await refreshList();
    } catch (error) {
      setAddError(mapLibraryIpcError(asIpcError(error)));
    } finally {
      setIsAdding(false);
    }
  }, [pathInput, nameInput, refreshList]);

  const items: readonly LibraryDto[] = libraryState.kind === 'ok' ? libraryState.items : [];
  const loading = libraryState.kind === 'loading';
  const listError = libraryState.kind === 'error' ? libraryState.message : null;
  const isSwitching = switchSnap !== null
    && switchSnap.state !== 'idle'
    && switchSnap.state !== 'done'
    && switchSnap.state !== 'failed'
    && switchSnap.state !== 'cancelled';

  return (
    <div className={styles.body}>
          <div className={styles.tabs} role="tablist" aria-label="库管理分类">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'vaults'}
              className={tab === 'vaults' ? `${styles.tab} ${styles.tabActive}` : styles.tab}
              onClick={() => setTab('vaults')}
            >
              知识库
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'media'}
              className={tab === 'media' ? `${styles.tab} ${styles.tabActive}` : styles.tab}
              onClick={() => setTab('media')}
            >
              媒体库
            </button>
          </div>

          {tab === 'vaults' ? (
            <div className={styles.vaults}>
              <LibraryListBody
                loading={loading}
                error={listError}
                items={items}
                currentId={currentId}
                removingId={removingId}
                isRemoving={isRemoving}
                onRefresh={() => { void refreshList(); }}
                onRemoveRequest={setRemovingId}
                onRemoveConfirm={handleRemove}
                onRemoveCancel={() => setRemovingId(null)}
                switchConfirmId={switchConfirmId}
                isSwitching={isSwitching}
                onSwitchRequest={setSwitchConfirmId}
                onSwitchConfirm={(id) => handleSwitch(id).finally(() => setSwitchConfirmId(null))}
                onSwitchCancel={() => setSwitchConfirmId(null)}
              />

              <form
                className={styles.addForm}
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleAdd();
                }}
              >
                <div className={styles.addRow}>
                  <input
                    className={styles.input}
                    type="text"
                    aria-label="库路径（绝对路径）"
                    placeholder="绝对路径，如 /Users/xxx/Documents/MyVault"
                    value={pathInput}
                    onChange={(event) => {
                      setPathInput(event.target.value);
                      if (addError !== null) setAddError(null);
                    }}
                    disabled={isAdding}
                  />
                  <button
                    type="button"
                    className={styles.ghostButton}
                    disabled={isAdding || isPicking}
                    onClick={() => { void handlePickDirectory(); }}
                  >
                    {isPicking ? '打开中…' : '选择文件夹…'}
                  </button>
                </div>
                <input
                  className={styles.input}
                  type="text"
                  aria-label="库名称（可选）"
                  placeholder="名称（可选，留空取目录名）"
                  value={nameInput}
                  onChange={(event) => setNameInput(event.target.value)}
                  disabled={isAdding || isPicking}
                />
                {addError !== null ? <p className={styles.addError} role="alert">{addError}</p> : null}
                <div className={styles.addActions}>
                  <button type="submit" className={styles.primaryButton} disabled={isAdding || loading}>
                    {isAdding ? '添加中…' : '添加库'}
                  </button>
                </div>
              </form>
            </div>
          ) : (
            <div className={styles.media}>
              <MediaLibraryBody />
            </div>
          )}
    </div>
  );
}
