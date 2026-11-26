/**
 * 编辑器窗口模式请求通道（CR-20261121-45 §10：阅读并入编辑器单窗口）。
 *
 * 画布右键「打开阅读浮窗」与节点「展开」统一改为打开/聚焦编辑器窗口并切到阅读模式：
 * openWindow 幂等（已开则激活/还原），模式切换经本 store 按路径记账，由 EditorWindow
 * 消费后经 props 下发 EditorView（editor 层不引 app/zustand，与 shell-requests 同模式）。
 * immersive（沉浸阅读：主区画布降至 40% 不透明度）为全局单开关，随浮窗并入迁此。
 */
import { create } from 'zustand';
import type { EditorMode } from '../../editor/mode.ts';

export interface EditorModeRequestState {
  /** 待消费的模式请求，按窗口 id（=文档路径）记账；消费后移除。 */
  readonly byPath: Readonly<Record<string, EditorMode>>;
  /** 沉浸阅读全局开关：AppShell 据此给主区加 40% 不透明度。 */
  readonly immersive: boolean;
  readonly requestMode: (path: string, mode: EditorMode) => void;
  readonly consumeMode: (path: string) => void;
  readonly toggleImmersive: () => void;
  /** 沉浸只在编辑器窗口存续期间有效：最后一个编辑器窗口关闭时由 AppShell 调用复位。 */
  readonly clearImmersive: () => void;
}

export const useEditorModeRequestStore = create<EditorModeRequestState>()((set) => ({
  byPath: {},
  immersive: false,
  requestMode: (path, mode) =>
    set((state) => ({ byPath: { ...state.byPath, [path]: mode } })),
  consumeMode: (path) =>
    set((state) => {
      if (!(path in state.byPath)) return {};
      const next = { ...state.byPath };
      delete next[path];
      return { byPath: next };
    }),
  toggleImmersive: () => set((state) => ({ immersive: !state.immersive })),
  clearImmersive: () => set((state) => (state.immersive ? { immersive: false } : {})),
}));
