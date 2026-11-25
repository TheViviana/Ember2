/**
 * R4-1：壳层面板开关状态机（纯 reducer，可在 node 下测试）。
 *
 * 设置入口已全部收进设置壳，壳外只剩三个开关：
 * settings（设置壳）/ ai（AI 对话浮窗）/ docNewInput（命令触发的文档新建输入）。
 */
export type ShellPanelId = 'settings' | 'ai' | 'docNewInput';

export interface ShellPanelsState {
  readonly open: Readonly<Record<ShellPanelId, boolean>>;
}

export type ShellPanelsAction =
  | { readonly type: 'open'; readonly panel: ShellPanelId }
  | { readonly type: 'close'; readonly panel: ShellPanelId }
  | { readonly type: 'toggle'; readonly panel: ShellPanelId };

export const INITIAL_SHELL_PANELS: ShellPanelsState = Object.freeze({
  open: Object.freeze({
    settings: false,
    ai: false,
    docNewInput: false,
  }),
});

export function selectPanelOpen(state: ShellPanelsState, panel: ShellPanelId): boolean {
  return state.open[panel];
}

function setPanel(state: ShellPanelsState, panel: ShellPanelId, open: boolean): ShellPanelsState {
  if (state.open[panel] === open) return state;
  return Object.freeze({ open: Object.freeze({ ...state.open, [panel]: open }) });
}

export function shellPanelsReducer(
  state: ShellPanelsState,
  action: ShellPanelsAction,
): ShellPanelsState {
  switch (action.type) {
    case 'open':
      return setPanel(state, action.panel, true);
    case 'close':
      return setPanel(state, action.panel, false);
    case 'toggle':
      return setPanel(state, action.panel, !state.open[action.panel]);
    default:
      return state;
  }
}
