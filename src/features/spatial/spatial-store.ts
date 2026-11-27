/**
 * 空间工作区状态：覆盖层开关 + 窗口数组。
 *
 * 单向数据流：状态层 → 渲染层 → 用户事件 → 状态层。
 * 面板组件不得私自持有窗口位置/尺寸；MVP 不持久化，每次打开重置默认布局。
 */
import { create } from 'zustand';
import {
  defaultSpatialWindows,
  focusSpatialWindow,
  moveSpatialWindow,
  resizeSpatialWindow,
  type SpatialWindowState,
} from './window-state.ts';

interface SpatialStoreState {
  readonly open: boolean;
  readonly windows: readonly SpatialWindowState[];
  readonly openWorkspace: () => void;
  readonly closeWorkspace: () => void;
  readonly focusWindow: (id: string) => void;
  readonly moveWindow: (id: string, position: readonly [number, number, number]) => void;
  readonly resizeWindow: (id: string, size: readonly [number, number]) => void;
}

export const useSpatialStore = create<SpatialStoreState>((set) => ({
  open: false,
  windows: defaultSpatialWindows(),
  openWorkspace: () => {
    set({ open: true, windows: defaultSpatialWindows() });
  },
  closeWorkspace: () => {
    set({ open: false });
  },
  focusWindow: (id) => {
    set((state) => ({ windows: focusSpatialWindow(state.windows, id) }));
  },
  moveWindow: (id, position) => {
    set((state) => ({ windows: moveSpatialWindow(state.windows, id, position) }));
  },
  resizeWindow: (id, size) => {
    set((state) => ({ windows: resizeSpatialWindow(state.windows, id, size) }));
  },
}));

export function openSpatialWorkspace(): void {
  useSpatialStore.getState().openWorkspace();
}

export function closeSpatialWorkspace(): void {
  useSpatialStore.getState().closeWorkspace();
}