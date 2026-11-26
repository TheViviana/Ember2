/**
 * 目录树单行。props 只有原始值，memo 比较成本恒定；
 * 展开态与选中态由行内自行订阅，避免整棵树跟着一次点击重渲染。
 *
 * S4：文档行拖到画布改指针会话（HTML5 `draggable` 在 WKWebView 不发起拖拽）。
 */
import { memo, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react';
import { useEmberStore } from '../stores/ember-store';
import { useTreeStore } from '../stores/tree-store';
import { pushNotice } from '../stores/notice-store';
import { vaultApi } from '../../data/app-api.ts';
import {
  beginPointerDragSession,
  dispatchPointerDragDrop,
  droppedPointerDrag,
  movePointerDragSession,
  type PointerDragSession,
} from '../dnd/pointer-drag.ts';
import { resolveNewDocDir } from './doc-new.ts';
import { renamedDocPaths } from './doc-index-sync.ts';
import { setDocDrag } from './doc-drag-state.ts';
import styles from './TreeRow.module.css';
import { formatUnknownError } from '../../core/errors.ts';
import { Icon } from '../../ui/icon.tsx';

export interface TreeRowProps {
  readonly path: string;
  readonly name: string;
  readonly depth: number;
  readonly kind: 'dir' | 'file';
  readonly hasChildren: boolean;
  readonly onRefreshDirs: () => void;
  /**
   * CR-20261121-57：行右键 → 父组件弹出右键菜单（新建文章/新建文件夹在目标目录内执行）。
   * 取代原 onRequestNewDoc 弹面板流程（新建改为默认名 + 原位重命名）。
   */
  readonly onRowContextMenu?: (
    info: { readonly kind: 'dir' | 'file'; readonly path: string; readonly dir: string },
    anchor: DOMRect,
  ) => void;
}

const INDENT_CLASSES: readonly (string | undefined)[] = [
  styles.indent0,
  styles.indent1,
  styles.indent2,
  styles.indent3,
  styles.indent4,
  styles.indent5,
  styles.indent6,
  styles.indent7,
  styles.indent8,
  styles.indent9,
];

export const TreeRow = memo(function TreeRow({
  path,
  name,
  depth,
  kind,
  hasChildren,
  onRefreshDirs,
  onRowContextMenu,
}: TreeRowProps) {
  const isDir = kind === 'dir';
  const expanded = useTreeStore((state) => (isDir ? state.expanded.has(path) : false));
  const active = useTreeStore((state) => !isDir && state.activePath === path);
  const toggleDir = useTreeStore((state) => state.toggleDir);
  const expandAncestors = useTreeStore((state) => state.expandAncestors);
  const setActivePath = useTreeStore((state) => state.setActivePath);
  const setOpenError = useTreeStore((state) => state.setOpenError);
  const openDoc = useEmberStore((state) => state.openDoc);
  // CR-20261121-57：原位重命名（新建文章后自动进入）。
  const editingPath = useTreeStore((state) => state.editingPath);
  const setEditingPath = useTreeStore((state) => state.setEditingPath);

  const rowRef = useRef<HTMLButtonElement | null>(null);
  const sessionRef = useRef<PointerDragSession | null>(null);
  const suppressClickRef = useRef(false);
  const [ghost, setGhost] = useState<{ readonly x: number; readonly y: number } | null>(null);

  const indentClass = INDENT_CLASSES[Math.min(depth, INDENT_CLASSES.length - 1)] ?? '';

  /** Esc 取消拖拽会话；只在出现 ghost 时挂监听，卸载即移除。 */
  useEffect(() => {
    if (ghost === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      const session = sessionRef.current;
      sessionRef.current = null;
      suppressClickRef.current = true;
      setGhost(null);
      setDocDrag({ active: false, path: '' });
      const row = rowRef.current;
      if (row !== null && session !== null && row.hasPointerCapture(session.pointerId)) {
        row.releasePointerCapture(session.pointerId);
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [ghost]);

  function handleClick(event: ReactMouseEvent<HTMLButtonElement>): void {
    // 第二次 click 只参与双击改名，不重复打开文档或切换目录展开态。
    if (event.detail > 1) return;
    // 刚完成拖拽/取消：抑制这一次 click，避免误打开文档。
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (isDir) {
      if (hasChildren) toggleDir(path);
      return;
    }
    expandAncestors(path);
    setActivePath(path);
    setOpenError(null);
    void openDoc(path).catch((error: unknown) => {
      setActivePath(null);
      setOpenError(error instanceof Error ? error.message : '打开文档失败');
    });
  }

  // 双击文章/文件夹都进入原位改名；浮窗仍由文档库区头按钮打开。
  function handleDoubleClick(): void {
    expandAncestors(path);
    setEditingPath(path);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLButtonElement>): void {
    // CR-20261122-67 §3：目录也允许拖拽（排序 / 移入其它目录）；仅响应主键。
    if (event.button !== 0) return;
    sessionRef.current = beginPointerDragSession({ kind: 'doc', path }, event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLButtonElement>): void {
    const session = sessionRef.current;
    if (session === null) return;
    const next = movePointerDragSession(session, event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    if (next === null) return;
    sessionRef.current = next;
    if (next.phase !== 'dragging') return;
    // 进入拖拽后，本次手势的 click 不再打开文档。
    suppressClickRef.current = true;
    setGhost({ x: next.current.x, y: next.current.y });
    // 通知 DocumentList 显示落点指示（高亮文件夹 / 插入线）。
    setDocDrag({ active: true, path });
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLButtonElement>): void {
    const session = sessionRef.current;
    if (session === null) return;
    const payload = droppedPointerDrag(session, event.pointerId);
    sessionRef.current = null;
    setGhost(null);
    setDocDrag({ active: false, path: '' });
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (payload === null) return;
    // 总派发：画布落点由 CanvasView 自校验 `[data-canvas-drop-host]`，文档树内部落点由
    // DocumentList 自校验容器范围；互不干扰。
    dispatchPointerDragDrop({ payload, clientX: event.clientX, clientY: event.clientY });
  }

  function handlePointerCancel(): void {
    sessionRef.current = null;
    setGhost(null);
    setDocDrag({ active: false, path: '' });
  }

  /** CR-20261121-57：行右键 → 通知父组件弹出右键菜单（新建动作在目标目录内执行）。 */
  function handleContextMenu(event: ReactMouseEvent<HTMLButtonElement>): void {
    if (event.button !== 2) return;
    if (onRowContextMenu === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    const dir = resolveNewDocDir(kind, path);
    onRowContextMenu(
      { kind, path, dir },
      new DOMRect(event.clientX, event.clientY, 1, 1),
    );
  }

  /** CR-20261121-57：原位重命名提交——空值/未改动保留默认名；Enter/blur 提交、Esc 取消。
   *  CR-20261122-64：文件夹同样支持改名，名称不允许跨层级。 */
  function commitRename(raw: string): void {
    setEditingPath(null);
    const trimmed = raw.trim();
    const currentName = isDir ? name : name.replace(/\.md$/i, '');
    if (trimmed === '' || trimmed === currentName) return;
    if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.startsWith('.')) {
      pushNotice('名称不能包含斜杠或以 . 开头', 'warning');
      return;
    }
    const nextName = isDir ? trimmed : `${trimmed}.md`;
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const to = dir === '' ? nextName : `${dir}/${nextName}`;
    void vaultApi.rename(path, to)
      .then(async () => {
        useTreeStore.getState().renamePath(path, to);
        // CR-20261122-66：改名两端事件都会被自写日志压掉，需主动对账索引；
        // 目录改名要带上全部后代，否则树里仍是旧路径。
        const emberState = useEmberStore.getState();
        const { stale, fresh } = renamedDocPaths(emberState.index.docs.keys(), path, to);
        try {
          await emberState.reconcilePaths([...stale, ...fresh]);
        } catch (error: unknown) {
          pushNotice(`目录索引刷新失败：${formatUnknownError(error, '未知错误')}`, 'warning');
        }
        onRefreshDirs();
        pushNotice(isDir ? `文件夹已改名：${trimmed}` : `已命名：${nextName}`, 'info');
      })
      .catch((error: unknown) => pushNotice(`重命名失败：${formatUnknownError(error, '未知错误')}`, 'error'));
  }

  // CR-20261121-57：原位重命名行——以输入框替代名称（不弹任何面板/框）。
  // CR-20261122-64：文章与文件夹共用同一输入框，文件自动保留 .md 后缀。
  if (editingPath === path) {
    const defaultName = isDir ? name : name.replace(/\.md$/i, '');
    return (
      <div
        className={`${styles.row} ${indentClass}`}
        data-editing="true"
        data-tree-row
        data-path={path}
        data-kind={kind}
      >
        <span className={styles.marker} aria-hidden="true" />
        <span className={styles.icon} aria-hidden="true" />
        <input
          className={styles.editInput}
          autoFocus
          defaultValue={defaultName}
          aria-label={isDir ? '命名文件夹' : '命名文章'}
          onFocus={(event) => event.currentTarget.select()}
          onBlur={(event) => void commitRename(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              void commitRename(event.currentTarget.value);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setEditingPath(null);
            }
          }}
        />
      </div>
    );
  }

  return (
    <button
      ref={rowRef}
      type="button"
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={isDir ? expanded : undefined}
      aria-selected={isDir ? undefined : active}
      aria-disabled={isDir && !hasChildren ? true : undefined}
      className={`${styles.row} ${indentClass}${active ? ` ${styles.rowActive}` : ''}`}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      title={path}
      data-tree-row
      data-path={path}
      data-kind={kind}
    >
      <span
        className={styles.marker}
        aria-hidden="true"
        data-expanded={isDir && hasChildren && expanded ? 'true' : undefined}
      >
        {isDir && hasChildren ? (
          <Icon size={12} viewBox="0 0 8 8" className={styles.markerIcon}>
            <path d="M2.5 1.5 5.5 4 2.5 6.5" />
          </Icon>
        ) : null}
      </span>
      {/* CR-20261121-56：目录行文件夹图标 / 文件行占位同宽，保证名称列严格对齐 */}
      <span className={styles.icon} aria-hidden="true">
        {isDir ? (
          <Icon size={12} viewBox="0 0 16 16">
            <path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2l1.6 2H13a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5V3.5Z" />
          </Icon>
        ) : null}
      </span>
      <span className={`${styles.name}${isDir ? ` ${styles.nameDir}` : ''}`}>{name}</span>
      {ghost === null ? null : (
        <span className={styles.ghost} style={{ left: ghost.x, top: ghost.y }} aria-hidden="true">
          {name}
        </span>
      )}
    </button>
  );
});
