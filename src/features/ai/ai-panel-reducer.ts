/**
 * T1-AI-A：AI 面板状态机（纯 reducer，零 React / 零 IPC）。
 *
 * 覆盖：端点表单（provider/baseUrl/key/allowInsecureHttp）+ 模型列表三态 + 选中模型 + 保存状态 + 测试连接状态。
 * 所有 actions 均是纯对象；reducer 返回新 state（不可变 Object.freeze 约定）。
 */

import {
  DEFAULT_OLLAMA_BASE_URL,
  type AiProvider,
  type AiProviderPreset,
} from './ai-endpoint.ts';

// ─── State ────────────────────────────────────────────────────────────────

export type AiPanelStatus =
  | 'idle'                 // 初始 / 端点未配置
  | 'configured'           // ai_key_status 返回 configured=true
  | 'testing'              // ai_test_connection in-flight
  | 'test_ok'              // 测试连接成功
  | 'test_fail'            // 测试连接失败（存 error）
  | 'loading_models'       // ai_list_models in-flight
  | 'models_ok'            // 模型列表拉取成功
  | 'models_empty'         // 拉取成功但 models: []
  | 'models_fail'          // 模型列表失败（存 error）
  | 'saving'               // ai_key_save in-flight
  | 'save_ok'              // 保存成功（存 storage）
  | 'save_fail'            // 保存失败
  | 'deleting';            // ai_key_delete in-flight

export interface AiPanelError {
  readonly code: string | undefined;
  readonly message: string;
}

export const AI_PANEL_HEIGHT_KEY = 'ember.ai.panel.height.v1';
export const MIN_AI_PANEL_HEIGHT = 320;

export function maxAiPanelHeight(viewportHeight: number): number {
  return Math.max(MIN_AI_PANEL_HEIGHT, Math.min(720, viewportHeight - 152));
}

export function clampAiPanelHeight(height: number, viewportHeight: number): number {
  return Math.round(Math.max(MIN_AI_PANEL_HEIGHT, Math.min(maxAiPanelHeight(viewportHeight), height)));
}

export function defaultAiPanelHeight(viewportHeight: number): number {
  return Math.round(Math.max(MIN_AI_PANEL_HEIGHT, Math.min(560, viewportHeight * 0.46)));
}

export function readAiPanelHeight(viewportHeight: number, storage?: Storage | null): number | null {
  const target = storage ?? (typeof window === 'undefined' ? null : window.localStorage);
  if (target === null) return null;
  try {
    const raw = target.getItem(AI_PANEL_HEIGHT_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? clampAiPanelHeight(value, viewportHeight) : null;
  } catch {
    return null;
  }
}

export function writeAiPanelHeight(height: number, viewportHeight: number, storage?: Storage | null): void {
  const target = storage ?? (typeof window === 'undefined' ? null : window.localStorage);
  if (target === null || !Number.isFinite(height)) return;
  try {
    target.setItem(AI_PANEL_HEIGHT_KEY, String(clampAiPanelHeight(height, viewportHeight)));
  } catch {
    /* 本地存储不可用时仅本次会话生效 */
  }
}

export interface AiPanelState {
  readonly status: AiPanelStatus;

  // 端点表单（可编辑）
  readonly preset: AiProviderPreset;
  readonly provider: AiProvider;
  readonly baseUrl: string;
  readonly key: string;
  readonly allowInsecureHttp: boolean;

  // 配置状态（ai_key_status 返回）
  readonly configured: boolean;
  readonly keychainAvailable: boolean;

  // 保存状态（ai_key_save 返回）
  readonly saveStorage: 'file' | 'memory' | null;
  readonly saveWarningCode: string | null;

  // 模型列表
  readonly models: readonly string[];
  readonly selectedModel: string | null;

  // 错误（最近一次失败）
  readonly error: AiPanelError | null;
}

export const AI_PANEL_INITIAL: AiPanelState = Object.freeze({
  status: 'idle',
  preset: 'ollama',
  provider: 'ollama',
  baseUrl: DEFAULT_OLLAMA_BASE_URL,
  key: '',
  allowInsecureHttp: true,
  configured: false,
  keychainAvailable: true,
  saveStorage: null,
  saveWarningCode: null,
  models: Object.freeze([]),
  selectedModel: null,
  error: null,
});

const IDLE_MODELS: readonly string[] = Object.freeze([]);

// ─── Actions ───────────────────────────────────────────────────────────────

export type AiPanelAction =
  | { readonly type: 'SET_PROVIDER'; readonly preset: AiProviderPreset; readonly provider: AiProvider; readonly defaultBaseUrl: string; readonly inferAllowInsecure: boolean }
  | { readonly type: 'SET_BASE_URL'; readonly baseUrl: string; readonly inferAllowInsecure: boolean }
  | { readonly type: 'SET_KEY'; readonly key: string }
  | { readonly type: 'SET_ALLOW_INSECURE_HTTP'; readonly value: boolean }
  | { readonly type: 'SAVE_START' }
  | { readonly type: 'SAVE_OK'; readonly storage: 'file' | 'memory'; readonly warningCode: string | null; readonly configured: boolean; readonly keychainAvailable: boolean }
  | { readonly type: 'SAVE_FAIL'; readonly error: AiPanelError }
  | { readonly type: 'DELETE_START' }
  | { readonly type: 'DELETE_OK' }
  | { readonly type: 'DELETE_FAIL'; readonly error: AiPanelError }
  | { readonly type: 'TEST_START' }
  | { readonly type: 'TEST_OK' }
  | { readonly type: 'TEST_FAIL'; readonly error: AiPanelError }
  | { readonly type: 'MODELS_START' }
  | { readonly type: 'MODELS_OK'; readonly models: readonly string[] }
  | { readonly type: 'MODELS_FAIL'; readonly error: AiPanelError }
  | { readonly type: 'SELECT_MODEL'; readonly model: string | null }
  | {
    readonly type: 'HYDRATE';
    readonly preset: AiProviderPreset;
    readonly provider: AiProvider;
    readonly baseUrl: string;
    readonly allowInsecureHttp: boolean;
    readonly model: string | null;
  }
  | { readonly type: 'KEY_STATUS'; readonly configured: boolean; readonly keychainAvailable: boolean }
  | { readonly type: 'RESET_ERROR' };

// ─── Reducer ───────────────────────────────────────────────────────────────

export function aiPanelReducer(
  state: AiPanelState,
  action: AiPanelAction,
): AiPanelState {
  switch (action.type) {
    case 'SET_PROVIDER':
      // 端点变了：configured / 保存结果 / 模型列表都属于旧端点，必须重置。
      return Object.freeze({
        ...state,
        preset: action.preset,
        provider: action.provider,
        baseUrl: action.defaultBaseUrl,
        allowInsecureHttp: action.inferAllowInsecure,
        status: 'idle',
        configured: false,
        saveStorage: null,
        saveWarningCode: null,
        models: IDLE_MODELS,
        selectedModel: null,
        error: null,
      });

    case 'SET_BASE_URL':
      return Object.freeze({
        ...state,
        baseUrl: action.baseUrl,
        allowInsecureHttp: action.inferAllowInsecure,
        status: 'idle',
        configured: false,
        saveStorage: null,
        saveWarningCode: null,
        models: IDLE_MODELS,
        selectedModel: null,
        error: null,
      });

    case 'SET_KEY':
      return Object.freeze({ ...state, key: action.key, error: null });

    case 'SET_ALLOW_INSECURE_HTTP':
      return Object.freeze({ ...state, allowInsecureHttp: action.value });

    case 'SAVE_START':
      return Object.freeze({ ...state, status: 'saving', error: null });

    case 'SAVE_OK':
      return Object.freeze({
        ...state,
        status: 'save_ok',
        saveStorage: action.storage,
        saveWarningCode: action.warningCode,
        configured: action.configured,
        keychainAvailable: action.keychainAvailable,
        error: null,
      });

    case 'SAVE_FAIL':
      return Object.freeze({ ...state, status: 'save_fail', error: action.error });

    case 'DELETE_START':
      return Object.freeze({ ...state, status: 'deleting', error: null });

    case 'DELETE_OK':
      return Object.freeze({
        ...state,
        status: 'configured',
        configured: false,
        saveStorage: null,
        saveWarningCode: null,
        error: null,
      });

    case 'DELETE_FAIL':
      return Object.freeze({ ...state, status: 'save_fail', error: action.error });

    case 'TEST_START':
      return Object.freeze({ ...state, status: 'testing', error: null });

    case 'TEST_OK':
      return Object.freeze({ ...state, status: 'test_ok', error: null });

    case 'TEST_FAIL':
      return Object.freeze({ ...state, status: 'test_fail', error: action.error });

    case 'MODELS_START':
      return Object.freeze({ ...state, status: 'loading_models', error: null });

    case 'MODELS_OK': {
      const nextStatus = action.models.length === 0 ? 'models_empty' : 'models_ok';
      return Object.freeze({
        ...state,
        status: nextStatus,
        models: action.models.length === 0
          ? Object.freeze([])
          : Object.freeze([...action.models]),
        // 保留仍在列表里的选择；否则自动选中首个模型，避免「有模型却提示不可用」。
        selectedModel: state.selectedModel !== null && action.models.includes(state.selectedModel)
          ? state.selectedModel
          : (action.models[0] ?? null),
        error: null,
      });
    }

    case 'MODELS_FAIL':
      return Object.freeze({ ...state, status: 'models_fail', error: action.error });

    case 'SELECT_MODEL':
      return Object.freeze({ ...state, selectedModel: action.model });

    case 'HYDRATE':
      // 面板重开时从内存 store 回填；preset 必须保留，避免 openai-compatible
      // 因 provider 相同而退回首个预设（CR-18 D4 回归）。
      return Object.freeze({
        ...state,
        preset: action.preset,
        provider: action.provider,
        baseUrl: action.baseUrl,
        allowInsecureHttp: action.allowInsecureHttp,
        selectedModel: action.model,
        status: 'idle',
        configured: false,
        saveStorage: null,
        saveWarningCode: null,
        models: IDLE_MODELS,
        error: null,
      });

    case 'KEY_STATUS':
      return Object.freeze({
        ...state,
        status: action.configured ? 'configured' : 'idle',
        configured: action.configured,
        keychainAvailable: action.keychainAvailable,
      });

    case 'RESET_ERROR':
      return Object.freeze({ ...state, error: null });

    default: {
      // Exhaustive check
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}
