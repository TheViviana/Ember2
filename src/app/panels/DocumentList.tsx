/**
 * 目录区：文档树 + 画布清单/新建（C0-C R2=A）。
 *
 * 画布新建严格走 Core（open 登记 → 不存在才 save），UI 不直接调 IPC；
 * 非法条目禁止打开并显示固定原因文案。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, MouseEvent as ReactMouseEvent } from 'react';
import { useEmberStore } from '../stores/ember-store';
import { useTreeStore } from '../stores/tree-store';
import { useCanvasSessionStore } from '../stores/canvas-session-store';
import { buildTree, flattenVisible } from '../tree/build-tree';
import {
  canvasEntryReasonLabel,
  createCanvasSession,
} from '../canvas/canvas-open.ts';
import { useStartupCanvas } from './use-startup-canvas.ts';
import { TreeRow } from './TreeRow';
import { useKnownDirs } from './use-known-dirs.ts';
import {
  loadDocOrder,
  removeChildFromOrder,
  resetDocOrder,
  setChildOrder,
} from './doc-order-store.ts';
import { resolveTreeDrop, type RowHit } from './doc-tree-drop.ts';
import { createDocTreeActions } from './doc-tree-actions.ts';
import { getDocDrag, subscribeDocDrag } from './doc-drag-state.ts';
import { POINTER_DRAG_DROP_EVENT, readPointerDragDropDetail } from '../dnd/pointer-drag.ts';
import { DeleteConfirmDialog } from './media/DeleteConfirmDialog.tsx';
import { DocListEmpty } from './DocListEmpty.tsx';
import { pushNotice } from '../stores/notice-store';
import { getViewport, openWindow } from '../../windows/use-window-manager.ts';
import { EDITOR_WINDOW_CONTENT } from '../../windows/content-types.ts';
import { canvasApi, vaultApi } from '../../data/app-api.ts';
import styles from './DocumentList.module.css';
import { formatUnknownError } from '../../core/errors.ts';
import { isWindowsPlatform } from '../../core/platform.ts';
import { MenuShell } from './MenuShell.tsx';

type TreeMenuTarget =
  | { readonly kind: 'blank' }
  | { readonly kind: 'dir'; readonly dir: string; readonly path: string }
  | { readonly kind: 'file'; readonly dir: string; readonly path: string };

type CanvasMenuTarget = {
  readonly row: { readonly id: string; readonly path: string; readonly valid: boolean } | null;
};

export interface DocumentListProps {
  /** §8.4 空态次操作：打开导入对话框（由 AppShell 传入）。 */
  readonly onOpenImport?: () => void;
}

export function DocumentList({ onOpenImport }: DocumentListProps) {
  const docs = useEmberStore((state) => state.index.docs);
  const root = useEmberStore((state) => state.identity?.root ?? null);
  const openCanvas = useEmberStore((state) => state.openCanvas);
  const saveCanvas = useEmberStore((state) => state.saveCanvas);
  const listCanvases = useEmberStore((state) => state.listCanvases);

  const activePath = useTreeStore((state) => state.activePath);
  const expanded = useTreeStore((state) => state.expanded);
  const openError = useTreeStore((state) => state.openError);
  const { dirs, refreshDirs } = useKnownDirs();

  const canvases = useCanvasSessionStore((state) => state.canvases);
  const activeCanvasId = useCanvasSessionStore((state) => state.activeCanvasId);
  const listError = useCanvasSessionStore((state) => state.listError);
  const creating = useCanvasSessionStore((state) => state.creating);
  const setCanvases = useCanvasSessionStore((state) => state.setCanvases);
  const setListError = useCanvasSessionStore((state) => state.setListError);
  const setCreating = useCanvasSessionStore((state) => state.setCreating);
  const setActiveCanvasId = useCanvasSessionStore((state) => state.setActiveCanvasId);
  const setMode = useCanvasSessionStore((state) => state.setMode);

  const [showNew, setShowNew] = useState(false);
  const [newId, setNewId] = useState('');
  const [createMessage, setCreateMessage] = useState<string | null>(null);

  // CR-20261121-58：画布行原位改名状态（canvas_rename）。
  const [renamingCanvas, setRenamingCanvas] = useState<string | null>(null);

  // CR-20261123-69 S2：浮窗入口从旧看板空壳迁到文档库区头，跟随树中当前选中文档。
  function openActiveDocWindow(): void {
    if (activePath === null) return;
    openWindow(activePath, EDITOR_WINDOW_CONTENT, getViewport());
  }

  // CR-20261121-57：目录树/画布的右键菜单（新建文章/新建文件夹/新建画布/删除画布）。
  const [treeMenu, setTreeMenu] = useState<{
    readonly x: number;
    readonly y: number;
    readonly target: TreeMenuTarget;
  } | null>(null);
  const [canvasMenu, setCanvasMenu] = useState<{
    readonly x: number;
    readonly y: number;
    readonly target: CanvasMenuTarget;
  } | null>(null);

  // CR-63：文档库删除确认（文章 / 文件夹共用受控确认框，不用 window.confirm）。
  const [deleteTarget, setDeleteTarget] = useState<{
    readonly path: string;
    readonly kind: 'file' | 'dir';
    readonly name: string;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);

  // CR-20261122-67 §3：文档树自定义顺序存 localStorage（按 vault root 隔离），
  // 拖拽落点指示：dropLineY 为相对 .tree 容器顶部的插入线 y（null = 无线）。
  const [orderVersion, setOrderVersion] = useState(0);
  const [dropLineY, setDropLineY] = useState<number | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);

  // CR-R4-3：文档树动作走 DI 模块，组件只保留 JSX / 菜单 / 落点判定。
  const actions = useMemo(
    () =>
      createDocTreeActions({
        docs: () => {
          const state = useEmberStore.getState();
          return { map: state.index.docs, root: state.identity?.root ?? '' };
        },
        createDoc: (rel) => useEmberStore.getState().createDoc(rel),
        vaultApi,
        canvasApi,
        reconcile: (paths) => useEmberStore.getState().reconcilePaths(paths),
        refreshDirs,
        notice: pushNotice,
        treeStore: useTreeStore,
      }),
    [refreshDirs],
  );

  // CR-20261121-57：删除画布——vault_remove 移入回收站；活动画布被删则清活动态。
  function deleteCanvas(id: string, path: string): void {
    if (path === '') return;
    void vaultApi.remove(path)
      .then(() => {
        if (activeCanvasId === id) setActiveCanvasId(null);
        setRenamingCanvas((current) => (current === id ? null : current));
        void refreshCanvases();
        pushNotice(`画布「${id}」已移入回收站`, 'info');
      })
      .catch((error: unknown) => pushNotice(`删除画布失败：${formatUnknownError(error, '未知错误')}`, 'error'));
  }

  // CR-20261122-64：右键改名——直接进入行内输入框（文章/文件夹共用）。
  function requestTreeRename(): void {
    const target = treeMenu?.target;
    if (target === undefined || target.kind === 'blank') return;
    setTreeMenu(null);
    const treeState = useTreeStore.getState();
    treeState.expandAncestors(target.path);
    treeState.setEditingPath(target.path);
  }

  // CR-63：删除确认后交给 DI 动作；成功才关闭确认框，失败保留入口重试。
  async function confirmTreeDelete(): Promise<void> {
    if (deleteTarget === null || deleting) return;
    setDeleting(true);
    try {
      if (await actions.confirmTreeDelete(deleteTarget)) setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  }

  // CR-63：右键删除文章/文件夹——只打开受控确认框，确认后才落地。
  function requestTreeDelete(): void {
    const target = treeMenu?.target;
    if (target === undefined || target.kind === 'blank') return;
    setTreeMenu(null);
    setDeleteTarget({
      path: target.path,
      kind: target.kind,
      name: target.path.slice(target.path.lastIndexOf('/') + 1),
    });
  }

  // CR-20261121-57：右键新建画布——untitled-N 首个空闲 id（画布 id 仅 ASCII 白名单）。
  function createUntitledCanvas(): void {
    const taken = new Set(canvases.map((entry) => entry.id));
    for (let n = 1; ; n += 1) {
      const id = n === 1 ? 'untitled' : `untitled-${n}`;
      if (taken.has(id)) continue;
      void (async () => {
        const result = await createCanvasSession(id, { open: openCanvas, save: saveCanvas });
        if (result.kind === 'failed') {
          pushNotice(`新建画布失败：${result.message}`, 'error');
          return;
        }
        await refreshCanvases();
        setActiveCanvasId(id);
        setMode('canvas');
      })();
      return;
    }
  }

  function openTreeBlankMenu(event: ReactMouseEvent<HTMLDivElement>): void {
    // 防御：只在用户直接点到容器本身时才触发（子元素已 stopPropagation / 自行处理）
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    refreshDirs();
    setTreeMenu({ x: event.clientX, y: event.clientY, target: { kind: 'blank' } });
  }

  // CR-20261121-58：画布改名提交——校验与 IPC 在 DI 动作内，成功后同步活动态与清单。
  async function commitCanvasRename(id: string, raw: string): Promise<void> {
    setRenamingCanvas(null);
    const result = await actions.commitCanvasRename(id, raw);
    if (!result.renamed) return;
    if (activeCanvasId === id) setActiveCanvasId(result.newId);
    void refreshCanvases();
  }

  function openCanvasBlankMenu(event: ReactMouseEvent<HTMLDivElement>): void {
    event.preventDefault();
    event.stopPropagation();
    setCanvasMenu({ x: event.clientX, y: event.clientY, target: { row: null } });
  }

  // CR-20261122-67 §3：按 vault root 加载用户自定义顺序；orderVersion 变更时重新读取。
  const order = useMemo(() => {
    // orderVersion 仅作为重新加载的触发器（移动/调序/重置后自增）。
    void orderVersion;
    return loadDocOrder(root ?? '');
  }, [root, orderVersion]);
  const orderFor = useCallback(
    (dir: string): readonly string[] | undefined => order[dir],
    [order],
  );

  // 真实目录与本地即时 overlay 的并集进树；空目录不依赖文章索引。
  const tree = useMemo(() => buildTree(docs, { orderFor, dirs }), [docs, dirs, orderFor]);
  const rows = useMemo(() => flattenVisible(tree, expanded), [tree, expanded]);

  // ---- CR-20261122-67 §3：文档树内部拖拽（调序 / 跨目录移动）落点指示与执行 ----

  /** 收集当前可见行的几何（供 resolveTreeDrop 命中判定）。 */
  function collectRowHits(container: HTMLElement): RowHit[] {
    const out: RowHit[] = [];
    for (const el of container.querySelectorAll<HTMLElement>('[data-tree-row]')) {
      const path = el.dataset.path;
      const kind = el.dataset.kind;
      if (path === undefined || (kind !== 'dir' && kind !== 'file')) continue;
      const rect = el.getBoundingClientRect();
      out.push({
        path,
        name: path.slice(path.lastIndexOf('/') + 1),
        kind,
        top: rect.top,
        bottom: rect.bottom,
      });
    }
    return out;
  }

  function clearDropHighlight(): void {
    const container = treeRef.current;
    if (container === null) return;
    for (const el of container.querySelectorAll<HTMLElement>('[data-tree-row]')) {
      el.style.boxShadow = '';
      el.style.backgroundColor = '';
    }
  }

  function setDropHighlight(path: string): void {
    const container = treeRef.current;
    if (container === null) return;
    for (const el of container.querySelectorAll<HTMLElement>('[data-tree-row]')) {
      if (el.dataset.path === path) {
        el.style.boxShadow = 'inset 2px 0 0 var(--ember-primary)';
        el.style.backgroundColor = 'var(--ember-primary-tint-soft)';
      }
    }
  }

  /** 根据鼠标 y 刷新落点指示（文件夹高亮 / 插入线）。仅在 active 拖拽时由 onPointerMove 调用。 */
  function updateDropIndicator(clientY: number): void {
    const container = treeRef.current;
    if (container === null) return;
    const rect = container.getBoundingClientRect();
    const { target, nearest } = resolveTreeDrop(
      collectRowHits(container),
      clientY,
      getDocDrag().path,
    );
    clearDropHighlight();
    if (target.kind === 'into') {
      setDropHighlight(target.folder);
      setDropLineY(null);
      return;
    }
    let top: number;
    if (nearest === null) {
      top = rect.bottom - rect.top;
    } else if (target.kind === 'place' && target.position === 'before') {
      top = nearest.top - rect.top;
    } else {
      top = nearest.bottom - rect.top;
    }
    setDropLineY(top);
  }

  const handleTreeDrop = useCallback(
    (draggedPath: string, clientY: number): void => {
      const container = treeRef.current;
      if (container === null) return;
      const { target } = resolveTreeDrop(collectRowHits(container), clientY, draggedPath);
      if (target.kind === 'none') return;
      void (async () => {
        const result = await actions.moveDoc(draggedPath, target);
        if (result.kind !== 'done') return;
        // 写目标目录的新顺序（同目录调序也走这里，使顺序持久化到 localStorage）。
        setChildOrder(result.root, result.destDir, [...result.names]);
        if (result.oldDir !== result.destDir) {
          removeChildFromOrder(result.root, result.oldDir, result.name);
        }
        setOrderVersion((v) => v + 1);
      })();
    },
    [actions],
  );

  // 拖拽结束（pointerup / cancel / Esc）→ 清掉落点指示。
  useEffect(
    () =>
      subscribeDocDrag(() => {
        if (!getDocDrag().active) {
          setDropLineY(null);
          clearDropHighlight();
        }
      }),
    [],
  );

  // 监听文档树内部的 pointer-drag 放置事件（TreeRow 总派发，这里按容器范围自校验）。
  useEffect(() => {
    const onDrop = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const detail = readPointerDragDropDetail(event.detail);
      if (detail === null || detail.payload.kind !== 'doc') return;
      const container = treeRef.current;
      if (container === null) return;
      const rect = container.getBoundingClientRect();
      if (
        detail.clientX < rect.left ||
        detail.clientX > rect.right ||
        detail.clientY < rect.top ||
        detail.clientY > rect.bottom
      ) {
        return;
      }
      handleTreeDrop(detail.payload.path, detail.clientY);
    };
    document.addEventListener(POINTER_DRAG_DROP_EVENT, onDrop);
    return () => document.removeEventListener(POINTER_DRAG_DROP_EVENT, onDrop);
  }, [handleTreeDrop]);

  // CR-20261121-57：右键菜单——点击文档任意处关闭。
  useEffect(() => {
    if (treeMenu === null && canvasMenu === null) return;
    const onDocClick = (): void => {
      setTreeMenu(null);
      setCanvasMenu(null);
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [treeMenu, canvasMenu]);

  const canvasesLoadedRef = useRef(false);
  const refreshCanvases = useCallback(async (): Promise<void> => {
    try {
      const list = await listCanvases();
      setCanvases(list);
      canvasesLoadedRef.current = true;
      setListError(null);
    } catch (error: unknown) {
      setListError(formatUnknownError(error, '未知错误'));
    }
  }, [listCanvases, setCanvases, setListError]);

  // 保险库未打开时清单请求会失败且只跑一次，会让启动引导永远等不到清单。
  useEffect(() => { if (root !== null) void refreshCanvases(); }, [refreshCanvases, root]);

  useStartupCanvas({
    canvases,
    canvasesLoadedRef,
    ready: root !== null,
    activeCanvasId,
    openCanvas,
    saveCanvas,
    refreshCanvases,
    setActiveCanvasId,
    setMode,
  });

  const handleCreate = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (creating) return;
    setCreating(true);
    setCreateMessage(null);
    const id = newId.trim();
    const result = await createCanvasSession(id, { open: openCanvas, save: saveCanvas });
    setCreating(false);

    if (result.kind === 'failed') {
      setCreateMessage(`${result.code}：${result.message}`);
      return;
    }

    if (result.kind === 'exists') {
      setCreateMessage(`画布「${id}」已存在，已刷新清单`);
    } else {
      setCreateMessage(null);
      setShowNew(false);
      setNewId('');
    }
    await refreshCanvases();
    setActiveCanvasId(id);
    setMode('canvas');
  };

  return (
    <aside className={styles.panel} aria-label="目录与画布" data-drop-zone="doc-list">
      <div className={styles.body}>
        <section className={styles.section} aria-label="画布">
          {/* CR-20261121-58：「新建」按钮移除——右键空白/区头即新建画布 */}
          <div className={styles.header} onContextMenu={openCanvasBlankMenu}>
            <span className={styles.title}>画布</span>
          </div>
          {listError === null ? null : (
            <p className={styles.error} role="alert">读取画布清单失败：{listError}</p>
          )}
          {createMessage === null ? null : (
            <p className={styles.createMessage} role="status">{createMessage}</p>
          )}
          {showNew ? (
            <form className={styles.newForm} onSubmit={(event) => void handleCreate(event)}>
              <input className={styles.input} value={newId} aria-label="新画布 id" placeholder="画布 id"
                disabled={creating} onChange={(event) => setNewId(event.target.value)} />
              <button type="submit" className={styles.newButton} disabled={creating}>
                {creating ? '创建中' : '创建'}
              </button>
            </form>
          ) : null}
          {/* CR-20261121-58：列表区右键空白=新建画布（与区头一致） */}
          <div onContextMenu={openCanvasBlankMenu}>
            {canvases.length === 0 ? (
              <p className={styles.sectionEmpty}>暂无画布。右键此处或区头新建。</p>
            ) : (
              <ul className={styles.canvasList}>
                {canvases.map((entry) => (
                  <li key={entry.id} className={styles.canvasItem}>
                    {renamingCanvas === entry.id && entry.valid ? (
                      <input className={styles.canvasRenameInput} autoFocus defaultValue={entry.id}
                        aria-label="重命名画布" onFocus={(event) => event.currentTarget.select()}
                        onBlur={(event) => void commitCanvasRename(entry.id, event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.nativeEvent.isComposing) return;
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            void commitCanvasRename(entry.id, event.currentTarget.value);
                          } else if (event.key === 'Escape') {
                            event.preventDefault();
                            setRenamingCanvas(null);
                          }
                        }}
                      />
                    ) : (
                      <button type="button" aria-disabled={entry.valid ? undefined : true}
                        className={`${styles.canvasRow} ${
                          entry.id === activeCanvasId && entry.valid ? styles.canvasRowActive : ''
                        }`}
                        title={entry.valid ? undefined : canvasEntryReasonLabel(entry.reason)}
                        onClick={(event) => {
                          // 第二次 click 只参与双击改名，不重复激活画布。
                          if (event.detail > 1 || !entry.valid) return;
                          setActiveCanvasId(entry.id);
                          setMode('canvas');
                        }}
                        onDoubleClick={() => {
                          if (entry.valid) setRenamingCanvas(entry.id);
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setCanvasMenu({
                            x: event.clientX,
                            y: event.clientY,
                            target: { row: { id: entry.id, path: entry.path ?? '', valid: entry.valid } },
                          });
                        }}
                      >
                        <span className={styles.canvasName}>{entry.id}</span>
                        {entry.valid ? null : (
                          <span className={styles.canvasReason}>{canvasEntryReasonLabel(entry.reason)}</span>
                        )}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className={styles.section} aria-label="文档">
          {/* CR-20261121-58：「＋」按钮移除——右键树行/空白即新建，避免与右键功能重复 */}
          <div className={styles.header}>
            <span className={styles.title}>文档库</span>
            <div className={styles.headerActions}>
              <button
                type="button"
                className={styles.headerAction}
                onClick={openActiveDocWindow}
                disabled={activePath === null}
                title={activePath === null ? '先在文档树中选择文档' : `在浮窗中打开 ${activePath}`}
              >
                浮窗
              </button>
              <span className={`${styles.count} tabular-nums`}>{docs.size}</span>
            </div>
          </div>
          {openError === null ? null : (
            <p className={styles.error} role="alert">打开失败：{openError}</p>
          )}
          <div onContextMenu={openTreeBlankMenu}>
            {rows.length === 0 ? (
              <DocListEmpty
                onCreate={() => void actions.createDocIn('')}
                onImport={onOpenImport}
              />
            ) : (
              <div ref={treeRef} className={styles.tree} role="tree" aria-label="文档树" data-doc-tree
                onPointerMove={(event) => {
                  if (!getDocDrag().active) return;
                  // 指针捕获下 pointerleave 不可靠：用 move 时的矩形包含判断清指示。
                  const rect = treeRef.current?.getBoundingClientRect();
                  if (rect === undefined || event.clientY < rect.top || event.clientY > rect.bottom) {
                    setDropLineY(null);
                    clearDropHighlight();
                    return;
                  }
                  updateDropIndicator(event.clientY);
                }}
                onPointerLeave={() => { setDropLineY(null); clearDropHighlight(); }}
              >
                {rows.map((row) => (
                  <TreeRow key={row.path} path={row.path} name={row.name} depth={row.depth}
                    kind={row.kind} hasChildren={row.hasChildren} onRefreshDirs={refreshDirs}
                    onRowContextMenu={(info, anchor) => {
                      refreshDirs();
                      setTreeMenu({
                        x: anchor.x,
                        y: anchor.y,
                        target: info.kind === 'dir'
                          ? { kind: 'dir', dir: info.dir, path: info.path }
                          : { kind: 'file', dir: info.dir, path: info.path },
                      });
                    }}
                  />
                ))}
                {dropLineY === null ? null : (
                  <div className={styles.dropLine} style={{ top: dropLineY }} aria-hidden="true" />
                )}
              </div>
            )}
          </div>
        </section>
      </div>
      {/* CR-20261121-57：目录树右键菜单 */}
      {treeMenu === null ? null : (
        <MenuShell x={treeMenu.x} y={treeMenu.y} className={styles.contextMenu} onClose={() => setTreeMenu(null)}>
          <li>
            <button type="button" className={styles.menuItem} onClick={() => {
              const target = treeMenu.target;
              setTreeMenu(null);
              void actions.createDocIn(target.kind === 'blank' ? '' : target.dir);
            }}>
              新建文章
            </button>
          </li>
          <li>
            <button type="button" className={styles.menuItem} onClick={() => {
              const target = treeMenu.target;
              setTreeMenu(null);
              void actions.createDirIn(target.kind === 'blank' ? '' : target.dir);
            }}>
              新建文件夹
            </button>
          </li>
          {treeMenu.target.kind === 'blank' ? (
            <li>
              <button type="button" className={styles.menuItem} onClick={() => {
                setTreeMenu(null);
                resetDocOrder(root ?? '');
                setOrderVersion((v) => v + 1);
                pushNotice('已重置为默认排序', 'info');
              }}>
                重置排序
              </button>
            </li>
          ) : null}
          {treeMenu.target.kind === 'blank' ? null : (
            <>
              <li>
                <button type="button" className={styles.menuItem} onClick={requestTreeRename}>
                  改名
                </button>
              </li>
              {treeMenu.target.kind === 'file' ? (
                <li>
                  <button type="button" className={styles.menuItem} onClick={() => {
                    const target = treeMenu.target;
                    setTreeMenu(null);
                    if (target.kind === 'file') void actions.revealDoc(target.path);
                  }}>
                    {isWindowsPlatform() ? '在资源管理器中查看' : '在访达中查看'}
                  </button>
                </li>
              ) : null}
              <li className={styles.contextMenuDivider} />
              <li>
                <button type="button" className={styles.menuItem} data-variant="danger" onClick={requestTreeDelete}>
                  {treeMenu.target.kind === 'dir' ? '删除文件夹' : '删除文章'}
                </button>
              </li>
            </>
          )}
        </MenuShell>
      )}
      {/* CR-20261121-57：画布右键菜单 */}
      {canvasMenu === null ? null : (
        <MenuShell x={canvasMenu.x} y={canvasMenu.y} className={styles.contextMenu} onClose={() => setCanvasMenu(null)}>
          {canvasMenu.target.row === null ? (
            <li>
              <button type="button" className={styles.menuItem} onClick={() => {
                setCanvasMenu(null);
                createUntitledCanvas();
              }}>
                新建画布
              </button>
            </li>
          ) : (
            <>
              {!canvasMenu.target.row.valid ? null : (
                <li>
                  <button type="button" className={styles.menuItem} onClick={() => {
                    const row = canvasMenu.target.row;
                    setCanvasMenu(null);
                    if (row !== null) setRenamingCanvas(row.id);
                  }}>
                    改名
                  </button>
                </li>
              )}
              {canvasMenu.target.row.path === '' ? null : (
                <li>
                  <button type="button" className={styles.menuItem} data-variant="danger" onClick={() => {
                    const row = canvasMenu.target.row;
                    setCanvasMenu(null);
                    if (row !== null) deleteCanvas(row.id, row.path);
                  }}>
                    删除画布
                  </button>
                </li>
              )}
            </>
          )}
        </MenuShell>
      )}
      {/* CR-63：文章/文件夹删除确认（受控，取消不调用 IPC，删除中防重复） */}
      {deleteTarget === null ? null : (
        <DeleteConfirmDialog
          path={deleteTarget.path}
          deleting={deleting}
          title={deleteTarget.kind === 'dir' ? '确认删除文件夹' : '确认删除文章'}
          message={deleteTarget.kind === 'dir'
            ? `确认删除文件夹「${deleteTarget.name}」？目录及全部内容将移入回收站。`
            : `确认删除「${deleteTarget.name}」？文件将移入回收站。`}
          onCancel={() => {
            if (!deleting) setDeleteTarget(null);
          }}
          onConfirm={() => void confirmTreeDelete()}
        />
      )}
    </aside>
  );
}
