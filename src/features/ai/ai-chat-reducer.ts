/**
 * T1-B：AI 聊天流纯状态机（零 React / 零 IPC）。
 *
 * 五态：idle / streaming / done / error / cancelled。
 * 所有事件按 requestId 守卫；取消后的迟到 delta / done 直接丢弃。
 */
import type { AiChatError } from './ai-chat-errors.ts';

export type AiChatStatus = 'idle' | 'streaming' | 'done' | 'error' | 'cancelled';

export type ChatTurnRole = 'user' | 'assistant';

export interface AiChatTurn {
  readonly id: string;
  readonly role: ChatTurnRole;
  readonly content: string;
  /** assistant 占位 / 失败 / 取消时为 false；user 恒 true。 */
  readonly completed: boolean;
}

export interface AiChatState {
  readonly status: AiChatStatus;
  readonly messages: readonly AiChatTurn[];
  readonly activeRequestId: string | null;
  readonly activeAssistantId: string | null;
  readonly error: AiChatError | null;
}

export const AI_CHAT_INITIAL: AiChatState = Object.freeze({
  status: 'idle',
  messages: Object.freeze([]),
  activeRequestId: null,
  activeAssistantId: null,
  error: null,
});

export type AiChatAction =
  | {
    readonly type: 'SEND';
    readonly requestId: string;
    readonly userMessageId: string;
    readonly assistantMessageId: string;
    readonly text: string;
  }
  | { readonly type: 'DELTA'; readonly requestId: string; readonly text: string }
  | { readonly type: 'DONE'; readonly requestId: string }
  | { readonly type: 'ERROR'; readonly requestId: string; readonly error: AiChatError }
  | { readonly type: 'CANCEL'; readonly requestId: string }
  | { readonly type: 'RETRY'; readonly requestId: string; readonly assistantId: string };

function patchTurn(
  state: AiChatState,
  id: string,
  patch: (turn: AiChatTurn) => AiChatTurn,
): readonly AiChatTurn[] {
  return state.messages.map((turn) => (turn.id === id ? patch(turn) : turn));
}

export function aiChatReducer(state: AiChatState, action: AiChatAction): AiChatState {
  switch (action.type) {
    case 'SEND': {
      if (state.status === 'streaming') return state;
      const text = action.text.trim();
      if (text.length === 0) return state;
      return Object.freeze({
        status: 'streaming',
        messages: Object.freeze([
          ...state.messages,
          Object.freeze({
            id: action.userMessageId,
            role: 'user',
            content: text,
            completed: true,
          }),
          Object.freeze({
            id: action.assistantMessageId,
            role: 'assistant',
            content: '',
            completed: false,
          }),
        ]),
        activeRequestId: action.requestId,
        activeAssistantId: action.assistantMessageId,
        error: null,
      });
    }

    case 'DELTA': {
      if (action.requestId !== state.activeRequestId) return state;
      if (state.activeAssistantId === null) return state;
      if (action.text.length === 0) return state;
      return Object.freeze({
        ...state,
        messages: Object.freeze(patchTurn(state, state.activeAssistantId, (turn) => Object.freeze({
          ...turn,
          content: turn.content + action.text,
        }))),
      });
    }

    case 'DONE': {
      if (action.requestId !== state.activeRequestId) return state;
      const assistantId = state.activeAssistantId;
      return Object.freeze({
        ...state,
        status: 'done',
        messages: assistantId === null
          ? state.messages
          : Object.freeze(patchTurn(state, assistantId, (turn) => Object.freeze({
            ...turn,
            completed: true,
          }))),
        activeRequestId: null,
        activeAssistantId: null,
        error: null,
      });
    }

    case 'ERROR': {
      if (action.requestId !== state.activeRequestId) return state;
      const assistantId = state.activeAssistantId;
      const cancelled = action.error.code === 'E_AI_CANCELLED';
      return Object.freeze({
        ...state,
        status: cancelled ? 'cancelled' : 'error',
        messages: assistantId === null
          ? state.messages
          : Object.freeze(patchTurn(state, assistantId, (turn) => Object.freeze({
            ...turn,
            completed: false,
          }))),
        activeRequestId: null,
        activeAssistantId: null,
        error: cancelled ? null : action.error,
      });
    }

    case 'CANCEL': {
      if (action.requestId !== state.activeRequestId) return state;
      const assistantId = state.activeAssistantId;
      return Object.freeze({
        ...state,
        status: 'cancelled',
        messages: assistantId === null
          ? state.messages
          : Object.freeze(patchTurn(state, assistantId, (turn) => Object.freeze({
            ...turn,
            completed: false,
          }))),
        activeRequestId: null,
        activeAssistantId: null,
        error: null,
      });
    }

    case 'RETRY': {
      if (state.status === 'streaming') return state;
      const target = state.messages.find((m) => m.id === action.assistantId);
      if (target === undefined || target.role !== 'assistant') return state;
      return Object.freeze({
        ...state,
        status: 'streaming',
        messages: Object.freeze(patchTurn(state, action.assistantId, (turn) => Object.freeze({
          ...turn,
          content: '',
          completed: false,
        }))),
        activeRequestId: action.requestId,
        activeAssistantId: action.assistantId,
        error: null,
      });
    }

    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}
