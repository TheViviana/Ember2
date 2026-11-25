export interface SubmenuAnchorRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface SubmenuSize {
  readonly width: number;
  readonly height: number;
}

export interface SubmenuViewport {
  readonly width: number;
  readonly height: number;
}

export interface SubmenuPosition {
  readonly left: number;
  readonly top: number;
}

/** S5：子面板宽随内容自适应，这两个值与 DocSubmenu.module.css 的 min/max-width 保持一致。 */
export const DOC_SUBMENU_MIN_WIDTH = 220;
export const DOC_SUBMENU_MAX_WIDTH = 400;
export const DOC_SUBMENU_GAP = 4;
/** §8.1：父项与子面板之间的隐形 hover 桥宽度（覆盖 4px 间隙并压住父项 4px）。 */
export const DOC_SUBMENU_BRIDGE = 8;
export const DOC_SUBMENU_VIEWPORT_MARGIN = 8;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/**
 * 固定定位子面板：右/下缘不足时翻转，空间仍不足则夹在视口内。
 * 每一级都只跟随「当前触发项」：顶部与触发项顶边对齐；底部不足时翻到
 * 触发项底边上沿。父菜单顶边不参与计算，避免深层菜单离鼠标过远。
 */
export function positionDocSubmenu(
  anchor: SubmenuAnchorRect,
  size: SubmenuSize,
  viewport: SubmenuViewport,
): SubmenuPosition {
  const margin = DOC_SUBMENU_VIEWPORT_MARGIN;
  let left = anchor.right + DOC_SUBMENU_GAP;
  if (left + size.width > viewport.width - margin) {
    left = anchor.left - DOC_SUBMENU_GAP - size.width;
  }
  left = clamp(left, margin, Math.max(margin, viewport.width - margin - size.width));

  let top = anchor.top;
  if (top + size.height > viewport.height - margin) {
    top = anchor.bottom - size.height;
  }
  top = clamp(top, margin, Math.max(margin, viewport.height - margin - size.height));
  return { left, top };
}

/**
 * 把视口目标坐标换算为子面板 inline `left` / `top`。
 *
 * CR-20261122-64：`.panel` 是 `position: fixed`，但父菜单的 `backdrop-filter`
 * 会让它（以及祖先的 transform/contain）成为包含块，此时直接写视口坐标会
 * 让子菜单整体偏移、远离触发项。调用方先把 `left/top` 归零，测出面板的实际
 * 左上角 `containingBlockOrigin`，再用本函数得到相对包含块的偏移，最终视觉
 * 落点严格等于 `target`。`scale` 补偿祖先缩放（1 表示不缩放）。
 */
export function submenuStyleOffset(
  target: SubmenuPosition,
  containingBlockOrigin: SubmenuPosition,
  scale = 1,
): SubmenuPosition {
  const factor = scale > 0 ? scale : 1;
  return {
    left: (target.left - containingBlockOrigin.left) / factor,
    top: (target.top - containingBlockOrigin.top) / factor,
  };
}

/** depth 层打开 path，并替换该层及更深层的旧展开项。 */
export function openDocSubmenuPath(
  expanded: readonly string[],
  depth: number,
  path: string,
): readonly string[] {
  return [...expanded.slice(0, depth), path];
}

export function toggleDocSubmenuPath(
  expanded: readonly string[],
  depth: number,
  path: string,
): readonly string[] {
  return expanded[depth] === path
    ? expanded.slice(0, depth)
    : openDocSubmenuPath(expanded, depth, path);
}

export function closeDocSubmenuFrom(
  expanded: readonly string[],
  depth: number,
): readonly string[] {
  return expanded.slice(0, depth);
}

/**
 * CR-20261121-54：同一菜单内多个 DocSubmenu 实例的互斥登记簿。
 *
 * 各 DocSubmenu 的 open 是实例内部状态，悬停另一触发项时没有任何机制收起
 * 兄弟实例——右键菜单同时挂两个二级面板（外加残留的三级面板）。登记簿只
 * 跟踪「当前打开者」：claim 新 id 前先调用旧 id 的收起回调；release 仅在
 * id 匹配时清位（晚到的旧实例释放不得误清新实例）。收起回调必须自身调用
 * release 归还登记位。
 */
export interface SubmenuRegistry {
  /** 打开实例 id 前先收起当前打开者，再登记 (id, close)。同 id 重复 claim 仅更新回调。 */
  claim(id: string, close: () => void): void;
  /** 仅当 id 是当前登记者时清位；否则为无操作。 */
  release(id: string): void;
  /** 收起当前打开者（无打开者时无操作）——顶层普通菜单项悬停时调用。 */
  closeActive(): void;
  readonly activeId: string | null;
}

export function createSubmenuRegistry(): SubmenuRegistry {
  let currentId: string | null = null;
  let currentClose: (() => void) | null = null;
  return {
    get activeId(): string | null {
      return currentId;
    },
    claim(id, close) {
      if (currentId === id) {
        currentClose = close;
        return;
      }
      if (currentClose !== null) currentClose();
      currentId = id;
      currentClose = close;
    },
    release(id) {
      if (currentId !== id) return;
      currentId = null;
      currentClose = null;
    },
    closeActive() {
      if (currentClose === null) return;
      currentClose();
    },
  };
}

/** 全局唯一登记簿：主菜单/连线菜单内的全部 DocSubmenu 共享（两类菜单互斥，从不同时存在）。 */
export const docSubmenuRegistry = createSubmenuRegistry();
