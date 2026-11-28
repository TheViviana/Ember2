/**
 * T1-B：AI 聊天状态（zustand）。
 *
 * config（preset / provider / baseUrl / allowInsecureHttp / model）持久化到 localStorage，
 * 重启后 AI 设置与画布 AI 节点沿用上次选择；Key 永不进入 store、localStorage 或 sessionStorage。
 */
import { create } from 'zustand';
import {
  AI_CHAT_INITIAL,
  aiChatReducer,
  type AiChatAction,
  type AiChatState,
} from './ai-chat-reducer.ts';
import {
  AI_PROVIDER_PRESETS,
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

/** 设置页「AI / AI 设置」的持久化键（只含端点与模型，绝不含 Key）。 */
export const AI_CHAT_CONFIG_STORAGE_KEY = 'ember.ai.config.v1';

function defaultStorage(): Storage | null {
  return typeof window === 'undefined' ? null : window.localStorage;
}

function asProvider(value: unknown): AiProvider | null {
  return value === 'ollama' || value === 'openai-compatible' || value === 'openai-compatible-local'
    ? value
    : null;
}

function asPreset(value: unknown): AiProviderPreset | null {
  if (value === 'custom') return 'custom';
  return AI_PROVIDER_PRESETS.some((preset) => preset.id === value)
    ? (value as AiProviderPreset)
    : null;
}

/** 读取持久化配置；任何字段损坏都回退到默认值，保证启动不被脏数据卡住。 */
export function loadAiChatConfig(storage?: Storage | null): AiChatConfig {
  const target = storage ?? defaultStorage();
  if (target === null) return AI_CHAT_CONFIG_INITIAL;
  try {
    const raw = target.getItem(AI_CHAT_CONFIG_STORAGE_KEY);
    if (raw === null) return AI_CHAT_CONFIG_INITIAL;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return AI_CHAT_CONFIG_INITIAL;
    const record = parsed as Record<string, unknown>;
    const preset = asPreset(record.preset);
    if (preset === null) return AI_CHAT_CONFIG_INITIAL;
    const provider =
      asProvider(record.provider) ??
      AI_PROVIDER_PRESETS.find((item) => item.id === preset)?.provider ??
      'openai-compatible';
    const baseUrl =
      typeof record.baseUrl === 'string' && record.baseUrl.trim() !== ''
        ? record.baseUrl
        : (AI_PROVIDER_PRESETS.find((item) => item.id === preset)?.defaultBaseUrl ??
          AI_CHAT_CONFIG_INITIAL.baseUrl);
    return Object.freeze({
      preset,
      provider,
      baseUrl,
      allowInsecureHttp:
        typeof record.allowInsecureHttp === 'boolean'
          ? record.allowInsecureHttp
          : AI_CHAT_CONFIG_INITIAL.allowInsecureHttp,
      model: typeof record.model === 'string' && record.model !== '' ? record.model : null,
    });
  } catch {
    return AI_CHAT_CONFIG_INITIAL;
  }
}

export function saveAiChatConfig(config: AiChatConfig, storage?: Storage | null): void {
  const target = storage ?? defaultStorage();
  if (target === null) return;
  try {
    target.setItem(
      AI_CHAT_CONFIG_STORAGE_KEY,
      JSON.stringify({
        preset: config.preset,
        provider: config.provider,
        baseUrl: config.baseUrl,
        allowInsecureHttp: config.allowInsecureHttp,
        model: config.model,
      }),
    );
  } catch {
    // 本地存储不可用时仅本次生效，不阻断 AI 使用。
  }
}

export interface AiChatStore {
  readonly config: AiChatConfig;
  readonly conversation: AiChatState;
  readonly setConfig: (patch: Partial<AiChatConfig>) => void;
  readonly dispatch: (action: AiChatAction) => void;
}

export const useAiChatStore = create<AiChatStore>()((set) => ({
  config: loadAiChatConfig(),
  conversation: AI_CHAT_INITIAL,
  setConfig: (patch) =>
    set((state) => {
      const config = Object.freeze({ ...state.config, ...patch });
      saveAiChatConfig(config);
      return { config };
    }),
  dispatch: (action) =>
    set((state) => ({ conversation: aiChatReducer(state.conversation, action) })),
}));
