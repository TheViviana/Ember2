/**
 * C0-C R9=D：左右边缘面板的会话内状态机（纯逻辑，可在 node 下测试）。
 *
 * - 默认收起（只留边缘把手，不占主区）；指针进入热区/面板立即展开，离开后延迟收起（防抖，避免闪烁）；
 * - pinned 为会话内保持展开能力，供后续拖拽复用；
 * - 不写 localStorage / Core，状态只活在本次会话。
 */
export type EdgePanelSide = 'left' | 'right';

export interface EdgePanelVisibility {
  readonly left: boolean;
  readonly right: boolean;
}

export interface EdgePanelState {
  readonly open: EdgePanelVisibility;
  readonly pinned: EdgePanelVisibility;
  readonly hover: EdgePanelVisibility;
}

export interface EdgePanelScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface EdgePanelController {
  getState(): EdgePanelState;
  subscribe(listener: () => void): () => void;
  setHover(side: EdgePanelSide, hovered: boolean): void;
  toggle(side: EdgePanelSide): void;
  setPinned(side: EdgePanelSide, pinned: boolean): void;
  /** 切到看板：隐藏已钉住的左浮窗（记住钉住意图，回画布时恢复）。 */
  suspendLeftForBoard(): void;
  /** 回到画布：恢复 suspendLeftForBoard 之前的钉住展开。 */
  resumeLeftFromBoard(): void;
  dispose(): void;
}

export const EDGE_PANEL_COLLAPSE_MS = 220;
/** §8.4：指针停在边缘热区 120ms 后才展开，避免鼠标路过时闪开。 */
export const EDGE_PANEL_HOVER_OPEN_MS = 120;

/**
 * 从画布切到看板时收起「文档与画布」左浮窗（用户 2026-11-23）。
 *
 * 左浮窗是画布的工作台；看板没有画布上下文时继续钉住只会遮挡主区。
 * 只在 pinned 时动作：临时展开（hover/点击）不在这里强行关闭，避免打断用户。
 */
export function collapsePinnedLeftPanel(panels: EdgePanelController): void {
  panels.suspendLeftForBoard();
}

function both(value: boolean): EdgePanelVisibility {
  return { left: value, right: value };
}

export function createEdgePanelController(
  scheduler: EdgePanelScheduler = {
    schedule: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    cancel: (handle) => {
      globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
    },
  },
): EdgePanelController {
  let state: EdgePanelState = {
    open: both(false),
    pinned: both(false),
    hover: both(false),
  };
  /** 看板期间被自动隐藏的左浮窗原本是否钉住；回画布时据此恢复。 */
  let leftSuspended = false;
  const timers: { left: { readonly handle: unknown } | null; right: { readonly handle: unknown } | null } = {
    left: null,
    right: null,
  };
  /** 悬停展开延迟（§8.4）：与收起计时器分开，避免互相取消。 */
  const openTimers: { left: { readonly handle: unknown } | null; right: { readonly handle: unknown } | null } = {
    left: null,
    right: null,
  };
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const cancelCollapse = (side: EdgePanelSide): void => {
    const timer = timers[side];
    if (timer !== null) {
      scheduler.cancel(timer.handle);
      timers[side] = null;
    }
  };

  const cancelOpen = (side: EdgePanelSide): void => {
    const timer = openTimers[side];
    if (timer !== null) {
      scheduler.cancel(timer.handle);
      openTimers[side] = null;
    }
  };

  const setOpen = (side: EdgePanelSide, open: boolean): void => {
    if (state.open[side] === open) return;
    state = { ...state, open: { ...state.open, [side]: open } };
    notify();
  };

  const scheduleCollapse = (side: EdgePanelSide): void => {
    cancelCollapse(side);
    if (state.pinned[side]) return;
    timers[side] = {
      handle: scheduler.schedule(() => {
        timers[side] = null;
        if (state.hover[side] || state.pinned[side]) return;
        setOpen(side, false);
      }, EDGE_PANEL_COLLAPSE_MS),
    };
  };

  return {
    getState(): EdgePanelState {
      return state;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setHover(side, hovered): void {
      if (state.hover[side] === hovered) return;
      state = { ...state, hover: { ...state.hover, [side]: hovered } };
      if (hovered) {
        cancelCollapse(side);
        if (state.open[side]) {
          notify();
          return;
        }
        if (state.pinned[side]) {
          state = { ...state, open: { ...state.open, [side]: true } };
          notify();
          return;
        }
        // §8.4：先等 120ms，指针仍停在热区才展开。
        cancelOpen(side);
        openTimers[side] = {
          handle: scheduler.schedule(() => {
            openTimers[side] = null;
            if (!state.hover[side] || state.open[side]) return;
            setOpen(side, true);
          }, EDGE_PANEL_HOVER_OPEN_MS),
        };
        notify();
        return;
      }
      cancelOpen(side);
      if (state.pinned[side]) {
        notify();
        return;
      }
      notify();
      scheduleCollapse(side);
    },
    toggle(side): void {
      cancelCollapse(side);
      cancelOpen(side);
      setOpen(side, !state.open[side]);
    },
    setPinned(side, pinned): void {
      state = { ...state, pinned: { ...state.pinned, [side]: pinned } };
      if (pinned) {
        cancelCollapse(side);
        cancelOpen(side);
        if (!state.open[side]) state = { ...state, open: { ...state.open, [side]: true } };
        notify();
        return;
      }
      notify();
      if (!state.hover[side]) scheduleCollapse(side);
    },
    suspendLeftForBoard(): void {
      if (!state.pinned.left) return;
      leftSuspended = true;
      cancelCollapse('left');
      cancelOpen('left');
      state = {
        ...state,
        pinned: { ...state.pinned, left: false },
        open: { ...state.open, left: false },
      };
      notify();
    },
    resumeLeftFromBoard(): void {
      if (!leftSuspended) return;
      leftSuspended = false;
      cancelCollapse('left');
      state = {
        ...state,
        pinned: { ...state.pinned, left: true },
        open: { ...state.open, left: true },
      };
      notify();
    },
    dispose(): void {
      leftSuspended = false;
      cancelCollapse('left');
      cancelCollapse('right');
      cancelOpen('left');
      cancelOpen('right');
      listeners.clear();
    },
  };
}
