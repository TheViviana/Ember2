/**
 * P5-C4：关窗协调器的 app 层单例与 React 订阅桥。
 *
 * 纯协调器在 `src/app/window-close-flow.ts`；本文件只做三件事：
 * 1. 把 core / 窗口 / 提示端口接到真实实现；
 * 2. 把协调器视图镜像进 zustand（Map 封装在 store 内，不导出可变容器）；
 * 3. 导出 UI 可直接调用的动作（不暴露 token 与协调器内部状态）。
 */
import { create } from 'zustand';
import { closeWindow } from '../../windows/use-window-manager.ts';
import {
  createCloseFlow,
  type CloseFlowView,
  type CloseTarget,
} from '../window-close-flow.ts';
import { useEmberStore } from './ember-store';
import { pushNotice } from './notice-store';

export interface CloseFlowStoreState {
  readonly views: ReadonlyMap<string, CloseFlowView>;
}

export const useCloseFlowStore = create<CloseFlowStoreState>()(() => ({
  views: new Map<string, CloseFlowView>(),
}));

const flow = createCloseFlow({
  getDoc: (path) => {
    const doc = useEmberStore.getState().docs.get(path);
    if (!doc) return null;
    return {
      dirty: doc.dirty,
      saving: doc.saving,
      externalKind: doc.external?.kind ?? null,
      errorMessage: doc.error?.message ?? null,
    };
  },
  hasDoc: (path) => useEmberStore.getState().docs.has(path),
  saveDoc: (path) => useEmberStore.getState().saveDoc(path),
  closeDoc: (path) => {
    useEmberStore.getState().closeDoc(path);
  },
  closeWindow: (windowId) => {
    closeWindow(windowId);
  },
  notice: (message, tone) => {
    pushNotice(message, tone);
  },
  now: () => Date.now(),
  setTimer: (ms, callback) => {
    const id = setTimeout(callback, ms);
    return () => {
      clearTimeout(id);
    };
  },
});

flow.subscribe((windowId, view) => {
  useCloseFlowStore.setState((state) => {
    const next = new Map(state.views);
    if (view === null) next.delete(windowId);
    else next.set(windowId, view);
    return { views: next };
  });
});

export function registerCloseTarget(windowId: string, target: CloseTarget): () => void {
  return flow.register(windowId, target);
}

export function requestWindowClose(windowId: string): void {
  flow.requestClose(windowId, 'close');
}

export function requestAcceptDeletion(windowId: string): void {
  flow.requestClose(windowId, 'accept-deletion');
}

export function confirmDiscardAndClose(windowId: string): void {
  flow.confirmDiscard(windowId);
}

export function forceCloseWindow(windowId: string): void {
  flow.forceClose(windowId);
}

export function cancelWindowClose(windowId: string): void {
  flow.cancel(windowId);
}

export function retryWindowClose(windowId: string): void {
  flow.retry(windowId);
}

export function resolveWindowCloseConflict(windowId: string): void {
  flow.resolveConflict(windowId);
}
