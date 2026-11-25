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
  dispose(): void;
}

export const EDGE_PANEL_COLLAPSE_MS = 220;

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
  const timers: { left: { readonly handle: unknown } | null; right: { readonly handle: unknown } | null } = {
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
        if (!state.open[side]) state = { ...state, open: { ...state.open, [side]: true } };
        notify();
        return;
      }
      if (state.pinned[side]) {
        notify();
        return;
      }
      notify();
      scheduleCollapse(side);
    },
    toggle(side): void {
      cancelCollapse(side);
      setOpen(side, !state.open[side]);
    },
    setPinned(side, pinned): void {
      state = { ...state, pinned: { ...state.pinned, [side]: pinned } };
      if (pinned) {
        cancelCollapse(side);
        if (!state.open[side]) state = { ...state, open: { ...state.open, [side]: true } };
        notify();
        return;
      }
      notify();
      if (!state.hover[side]) scheduleCollapse(side);
    },
    dispose(): void {
      cancelCollapse('left');
      cancelCollapse('right');
      listeners.clear();
    },
  };
}
