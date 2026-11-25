/**
 * T1-B：AI 聊天内存状态（zustand，非持久化）。
 *
 * config 只存 preset / provider / baseUrl / allowInsecureHttp / model；
 * Key 永不进入 store、localStorage 或 sessionStorage。
 */
import { create } from 'zustand';
import {
  AI_CHAT_INITIAL,
  aiChatReducer,
  type AiChatAction,
  type AiChatState,
} from './ai-chat-reducer.ts';
import {
  DEFAULT_OLLAMA_BASE_URL,
  type AiProvider,
  type AiProviderPreset,
} from './ai-endpoint.ts';

export interface AiChatConfig {
  readonly preset: AiProviderPreset;
  readonly provider: AiProvider;
  readonly baseUrl: string;
  readonly allowInsecureHttp: boolean;
  readonly model: string | null;
}

export const AI_CHAT_CONFIG_INITIAL: AiChatConfig = Object.freeze({
  preset: 'ollama',
  provider: 'ollama',
  baseUrl: DEFAULT_OLLAMA_BASE_URL,
  allowInsecureHttp: true,
  model: null,
});

export interface AiChatStore {
  readonly config: AiChatConfig;
  readonly conversation: AiChatState;
  readonly setConfig: (patch: Partial<AiChatConfig>) => void;
  readonly dispatch: (action: AiChatAction) => void;
}

export const useAiChatStore = create<AiChatStore>()((set) => ({
  config: AI_CHAT_CONFIG_INITIAL,
  conversation: AI_CHAT_INITIAL,
  setConfig: (patch) =>
    set((state) => ({ config: Object.freeze({ ...state.config, ...patch }) })),
  dispatch: (action) =>
    set((state) => ({ conversation: aiChatReducer(state.conversation, action) })),
}));
