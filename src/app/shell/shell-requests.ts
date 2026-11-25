/**
 * 壳层跨组件请求通道（CR-20261120-40 C）。
 *
 * AppShell 的面板开关（translatePanelOpen 等）是组件本地 state，内容组件
 * （EditorWindow 等）无法直接操作；经此 store 转达「打开翻译设置」请求，
 * AppShell 订阅并消费。引导每会话只发一次，避免用户关闭后反复弹面板。
 */
import { create } from 'zustand';

export interface ShellRequestState {
  readonly translateSettingsRequested: boolean;
  readonly translateSettingsGuidedOnce: boolean;
  readonly requestTranslateSettings: () => void;
  readonly consumeTranslateSettingsRequest: () => void;
}

export const useShellRequestStore = create<ShellRequestState>()((set) => ({
  translateSettingsRequested: false,
  translateSettingsGuidedOnce: false,
  requestTranslateSettings: () =>
    set((state) =>
      state.translateSettingsGuidedOnce
        ? {}
        : { translateSettingsRequested: true, translateSettingsGuidedOnce: true },
    ),
  consumeTranslateSettingsRequest: () => set({ translateSettingsRequested: false }),
}));
