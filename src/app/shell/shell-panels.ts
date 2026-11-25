/**
 * R4-1：壳层面板开关状态机（纯 reducer，可在 node 下测试）。
 *
 * 15 个开关：settings/library/translate/ai{open,tab}/backup/update/appearance/
 * shortcuts/recoveryDemo/inbox/replace/health/history/tools/docNewInput。
 * 只管理开关与 AI tab，不持有任何业务 payload。
 */
export type ShellPanelId =
  | 'settings'
  | 'library'
  | 'translate'
  | 'ai'
  | 'backup'
  | 'update'
  | 'appearance'
  | 'shortcuts'
  | 'recoveryDemo'
  | 'inbox'
  | 'replace'
  | 'health'
  | 'history'
  | 'tools'
  | 'docNewInput';

export type AiPanelTab = 'settings' | 'chat';

export interface ShellPanelsState {
  readonly open: Readonly<Record<ShellPanelId, boolean>>;
  readonly aiTab: AiPanelTab;
}

export type ShellPanelsAction =
  | { readonly type: 'open'; readonly panel: ShellPanelId }
  | { readonly type: 'close'; readonly panel: ShellPanelId }
  | { readonly type: 'toggle'; readonly panel: ShellPanelId }
  | { readonly type: 'setAiTab'; readonly tab: AiPanelTab };

export const INITIAL_SHELL_PANELS: ShellPanelsState = Object.freeze({
  open: Object.freeze({
    settings: false,
    library: false,
    translate: false,
    ai: false,
    backup: false,
    update: false,
    appearance: false,
    shortcuts: false,
    recoveryDemo: false,
    inbox: false,
    replace: false,
    health: false,
    history: false,
    tools: false,
    docNewInput: false,
  }),
  aiTab: 'settings',
});

export function selectPanelOpen(state: ShellPanelsState, panel: ShellPanelId): boolean {
  return state.open[panel];
}

export function selectAiTab(state: ShellPanelsState): AiPanelTab {
  return state.aiTab;
}

function setPanel(state: ShellPanelsState, panel: ShellPanelId, open: boolean): ShellPanelsState {
  if (state.open[panel] === open) return state;
  return Object.freeze({ open: Object.freeze({ ...state.open, [panel]: open }), aiTab: state.aiTab });
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
    case 'setAiTab':
      if (state.aiTab === action.tab) return state;
      return Object.freeze({ open: state.open, aiTab: action.tab });
    default:
      return state;
  }
}
