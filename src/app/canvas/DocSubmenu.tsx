import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import type { TreeDirNode, TreeNode } from '../tree/build-tree.ts';
import {
  closeDocSubmenuFrom,
  docSubmenuRegistry,
  openDocSubmenuPath,
  positionDocSubmenu,
  toggleDocSubmenuPath,
} from './doc-submenu-model.ts';
import styles from './DocSubmenu.module.css';

/**
 * CR-20261122-67 §5：子面板经 createPortal 渲染到 document.body，脱离父菜单 DOM——
 * 画布舞台的 pan/zoom transform 不再成为 fixed 的包含块，子菜单严格落在上级菜单项旁。
 *
 * 面板脱离父 <ul> 后带来两点必须补回的契约：
 *  1. 外点判断：根组件的 pointerdown 监听要知道「哪些 DOM 属于本实例」，否则点面板内
 *     会被当成外部点击而关菜单。此上下文登记所有已挂载面板。
 *  2. 离开即闭定时器：父菜单 onPointerLeave 起 180ms 关菜单，原本靠「面板是 ul 的 DOM
 *     子孙」使 pointerleave 不触发；portal 后须由各面板自己 onPointerEnter/Leave 接
 *     cancel/schedule（由 CanvasView 传入）。
 */
interface SubmenuPanelHost {
  readonly register: (el: HTMLElement) => void;
  readonly unregister: (el: HTMLElement) => void;
  readonly contains: (node: Node) => boolean;
  readonly onMenuEnter?: () => void;
  readonly onMenuLeave?: () => void;
}
const SubmenuPanelHostContext = createContext<SubmenuPanelHost | null>(null);

/** 子面板内悬停高亮：与 CanvasView 的 data-menu-hover 口径一致，但不调用 closeActive——
 * closeActive 仅用于顶层普通项收起已开子菜单；子面板内移动不得把自己关掉。 */
function syncPanelHover(event: ReactPointerEvent<HTMLUListElement>): void {
  const list = event.currentTarget;
  const target =
    event.target instanceof Element ? event.target.closest('[role="menuitem"]') : null;
  for (const element of list.querySelectorAll('[data-menu-hover="true"]')) {
    if (element !== target) element.removeAttribute('data-menu-hover');
  }
  if (target !== null && list.contains(target)) {
    target.setAttribute('data-menu-hover', 'true');
  }
}
function clearPanelHover(event: ReactPointerEvent<HTMLUListElement>): void {
  for (const element of event.currentTarget.querySelectorAll('[data-menu-hover="true"]')) {
    element.removeAttribute('data-menu-hover');
  }
}

interface DocSubmenuProps {
  readonly label: string;
  readonly tree: readonly TreeNode[];
  readonly disabled: boolean;
  readonly onPick: (path: string) => void;
  readonly onOpen?: () => void;
  /** 空树提示文案；媒体库等复用时传入对应文案。 */
  readonly emptyLabel?: string;
  /** 父菜单「离开即闭」定时器的取消/排程，portal 后面板脱离父 ul，需自行接续。 */
  readonly onMenuEnter?: () => void;
  readonly onMenuLeave?: () => void;
}

interface PanelProps {
  readonly anchorRef: RefObject<HTMLButtonElement | null>;
  readonly children: ReactNode;
}

function DocSubmenuPanel({ anchorRef, children }: PanelProps) {
  const panelRef = useRef<HTMLUListElement | null>(null);
  const host = useContext(SubmenuPanelHostContext);

  // 挂载后登记本面板 DOM（供外点判断），卸载移除。
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    host?.register(panel);
    return () => host?.unregister(panel);
  }, [host]);

  useLayoutEffect(() => {
    const updatePosition = (): void => {
      const anchorElement = anchorRef.current;
      const panel = panelRef.current;
      if (anchorElement === null || panel === null) return;
      const anchor = anchorElement.getBoundingClientRect();
      // 每一级子菜单只跟随自己的触发项（根层「媒体库」或深层目录项），
      // 不与父菜单顶边对齐，避免指针需跨越整列菜单。
      const target = positionDocSubmenu(
        anchor,
        { width: panel.offsetWidth, height: panel.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      );
      // portal 到 body：position:fixed 的包含块即视口，直接写视口坐标，
      // 无需再测量包含块原点做补偿（CR-20261122-64 原点 hack 随 portal 移除）。
      panel.style.left = `${target.left}px`;
      panel.style.top = `${target.top}px`;
      panel.style.visibility = 'visible';
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    return () => window.removeEventListener('resize', updatePosition);
  }, [anchorRef]);

  return createPortal(
    <ul
      ref={panelRef}
      className={styles.panel}
      role="menu"
      onPointerMove={syncPanelHover}
      onPointerLeave={(event) => {
        clearPanelHover(event);
        host?.onMenuLeave?.();
      }}
      onPointerEnter={() => host?.onMenuEnter?.()}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </ul>,
    document.body,
  );
}

interface ItemsProps {
  readonly nodes: readonly TreeNode[];
  readonly depth: number;
  readonly expanded: readonly string[];
  readonly setExpanded: (expanded: readonly string[]) => void;
  readonly onPick: (path: string) => void;
}

interface DirectoryItemProps extends Omit<ItemsProps, 'nodes'> {
  readonly node: TreeDirNode;
}

function DirectoryItem({
  node,
  depth,
  expanded,
  setExpanded,
  onPick,
}: DirectoryItemProps) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const open = expanded[depth] === node.path;

  return (
    <li>
      <button
        ref={anchorRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        className={styles.item}
        onMouseEnter={() => setExpanded(openDocSubmenuPath(expanded, depth, node.path))}
        onClick={() => setExpanded(toggleDocSubmenuPath(expanded, depth, node.path))}
      >
        <span className={styles.label}>{node.name}</span>
        <span className={styles.arrow} aria-hidden="true">
          <svg width="10" height="10" viewBox="0 0 8 8" fill="none" aria-hidden="true">
            <path d="M2.5 1.5L5.5 4L2.5 6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      {open ? (
        <DocSubmenuPanel anchorRef={anchorRef}>
          <DocSubmenuItems
            nodes={node.children}
            depth={depth + 1}
            expanded={expanded}
            setExpanded={setExpanded}
            onPick={onPick}
          />
        </DocSubmenuPanel>
      ) : null}
    </li>
  );
}

function DocSubmenuItems({ nodes, depth, expanded, setExpanded, onPick }: ItemsProps) {
  return (
    <>
      {nodes.map((node) => node.kind === 'dir' ? (
        <DirectoryItem
          key={node.path}
          node={node}
          depth={depth}
          expanded={expanded}
          setExpanded={setExpanded}
          onPick={onPick}
        />
      ) : (
        <li key={node.path}>
          <button
            type="button"
            role="menuitem"
            className={styles.item}
            onMouseEnter={() => setExpanded(closeDocSubmenuFrom(expanded, depth))}
            onClick={() => onPick(node.path)}
          >
            <span className={styles.label}>{node.name}</span>
          </button>
        </li>
      ))}
    </>
  );
}

/** macOS 式文档层级子菜单；子面板 portal 到 body，外点判断覆盖根触发器与全部层级面板。 */
export function DocSubmenu({
  label,
  tree,
  disabled,
  onPick,
  onOpen,
  emptyLabel = '知识库暂无文档',
  onMenuEnter,
  onMenuLeave,
}: DocSubmenuProps) {
  const rootRef = useRef<HTMLLIElement | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<readonly string[]>([]);

  // CR-20261121-54：实例在互斥登记簿中以稳定 id 登记；closeRef 始终指向最新
  // close 闭包，登记簿保存的稳定包装可安全跨渲染调用（兄弟实例打开时收起本实例）。
  const instanceId = useId();
  const closeRef = useRef<() => void>(() => undefined);

  // portal 后面板不在 rootRef 子树内，用一个 Set 登记所有面板 DOM 供外点判断。
  const panelsRef = useRef<Set<HTMLElement>>(new Set());
  const host = useMemo<SubmenuPanelHost>(() => ({
    register: (el) => { panelsRef.current.add(el); },
    unregister: (el) => { panelsRef.current.delete(el); },
    contains: (node) => {
      for (const el of panelsRef.current) {
        if (el.contains(node)) return true;
      }
      return false;
    },
    onMenuEnter,
    onMenuLeave,
  }), [onMenuEnter, onMenuLeave]);

  const close = (): void => {
    setOpen(false);
    setExpanded([]);
    docSubmenuRegistry.release(instanceId);
  };
  closeRef.current = close;
  const show = (): void => {
    if (disabled || open) return;
    docSubmenuRegistry.claim(instanceId, () => closeRef.current());
    setOpen(true);
    onOpen?.();
  };
  // 菜单整体卸载（右键关闭/画布切换）时归还登记位，避免遗留指向已卸载实例的回调。
  useEffect(() => () => docSubmenuRegistry.release(instanceId), [instanceId]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return;
      // 根触发器（含按钮）或任一已挂载子面板内：不关。
      if (rootRef.current?.contains(event.target) === true) return;
      if (host.contains(event.target)) return;
      closeRef.current();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (expanded.length > 0) {
        setExpanded(closeDocSubmenuFrom(expanded, expanded.length - 1));
      } else {
        closeRef.current();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, expanded, host]);

  return (
    <SubmenuPanelHostContext.Provider value={host}>
      <li ref={rootRef} className={styles.root} onClick={(event) => event.stopPropagation()}>
        <button
          ref={anchorRef}
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={open}
          className={styles.item}
          disabled={disabled}
          onMouseEnter={show}
          onClick={() => {
            if (open) close();
            else show();
          }}
        >
          <span className={styles.label}>{label}</span>
          <span className={styles.arrow} aria-hidden="true">
            <svg width="10" height="10" viewBox="0 0 8 8" fill="none" aria-hidden="true">
              <path d="M2.5 1.5L5.5 4L2.5 6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </button>
        {open ? (
          <DocSubmenuPanel anchorRef={anchorRef}>
            {tree.length === 0 ? (
              <li><span className={styles.empty}>{emptyLabel}</span></li>
            ) : (
              <DocSubmenuItems
                nodes={tree}
                depth={0}
                expanded={expanded}
                setExpanded={setExpanded}
                onPick={onPick}
              />
            )}
          </DocSubmenuPanel>
        ) : null}
      </li>
    </SubmenuPanelHostContext.Provider>
  );
}
