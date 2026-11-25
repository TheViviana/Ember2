/**
 * C0-C：画布工作区的会话内 UI 状态（模式、当前画布、清单缓存）。
 *
 * 只活在本次会话：不写 localStorage、不写 Core、不跨启动持久化。
 * 清单刷新与新建仍由组件薄委托给 ember-store 的 Core 动作。
 */
import { create } from 'zustand';
import type { CanvasEntryDto } from '../../types/ipc';

export type WorkspaceMode = 'canvas' | 'docs';

export interface CanvasSessionState {
  readonly mode: WorkspaceMode;
  readonly activeCanvasId: string | null;
  readonly canvases: readonly CanvasEntryDto[];
  readonly listError: string | null;
  readonly creating: boolean;
  readonly setMode: (mode: WorkspaceMode) => void;
  readonly setActiveCanvasId: (id: string | null) => void;
  readonly setCanvases: (canvases: readonly CanvasEntryDto[]) => void;
  readonly setListError: (message: string | null) => void;
  readonly setCreating: (creating: boolean) => void;
}

export const useCanvasSessionStore = create<CanvasSessionState>()((set) => ({
  mode: 'canvas',
  activeCanvasId: null,
  canvases: [],
  listError: null,
  creating: false,
  setMode: (mode) => set({ mode }),
  setActiveCanvasId: (activeCanvasId) => set({ activeCanvasId }),
  setCanvases: (canvases) => set({ canvases }),
  setListError: (listError) => set({ listError }),
  setCreating: (creating) => set({ creating }),
}));
