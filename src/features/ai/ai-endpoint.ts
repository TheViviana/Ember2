/**
 * T1-AI-A：AI 端点校验 / allowInsecureHttp 推断 / Provider 预设。
 *
 * 纯函数：零 React / 零 IPC / 零 @tauri-apps。
 */

/**
 * 允许的 Provider 类型——与 src/types/ipc.ts AiProvider 严格对齐。
 *
 * - `ollama`：本地 Ollama 原生协议；
 * - `openai-compatible`：公网 OpenAI 兼容端点，必须有 Key；
 * - `openai-compatible-local`：本地/局域网 OpenAI 兼容端点（oMLX、LM Studio、
 *   vLLM 等），只放行回环与私网，Key 可选。
 */
export type AiProvider = 'ollama' | 'openai-compatible' | 'openai-compatible-local';

/** UI 预设值；`custom` 表示 BASE URL 不匹配任何已知生产商，由用户手填。 */
export type AiProviderPreset =
  | 'ollama'
  | 'openai-compatible-local'
  | 'openai-official'
  | 'deepseek'
  | 'moonshot'
  | 'zhipu'
  | 'openrouter'
  | 'groq'
  | 'qwen'
  | 'custom';

export interface AiEndpointPreset {
  /** 预设唯一 id；OpenAI 与「兼容」共享 provider，不能再用 provider 判 active。 */
  readonly id: AiProviderPreset;
  readonly label: string;
  readonly provider: AiProvider;
  readonly defaultBaseUrl: string;
  readonly showKeyField: boolean;
  readonly hideSaveDelete: boolean;
}

/** Ollama 默认端点（唯一常量源，UI 各处初始值均引用此处）。 */
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';

/** 本地 OpenAI 兼容端点默认基址（oMLX 默认监听 8000）。路径必须含 `/v1`。 */
export const DEFAULT_LOCAL_OPENAI_BASE_URL = 'http://127.0.0.1:8000/v1';

/**
 * 常见生产商预设表。Provider 值必须与 AiProvider 严格对齐。
 * - Ollama：hideSaveDelete=true（不需要持久化 Key）；allowInsecureHttp 默认 true（回环 http）。
 * - 其余生产商：showKeyField=true + hideSaveDelete=false + allowInsecureHttp 默认 false。
 * `custom` 不在此表中——它是 derivePresetId 在 BASE URL 不匹配时的回退。
 */
export const AI_PROVIDER_PRESETS: readonly AiEndpointPreset[] = Object.freeze([
  Object.freeze({ id: 'ollama', label: 'Ollama（本地）', provider: 'ollama', defaultBaseUrl: DEFAULT_OLLAMA_BASE_URL, showKeyField: false, hideSaveDelete: true }),
  Object.freeze({ id: 'openai-compatible-local', label: '本地模型（OpenAI 兼容）', provider: 'openai-compatible-local', defaultBaseUrl: DEFAULT_LOCAL_OPENAI_BASE_URL, showKeyField: true, hideSaveDelete: false }),
  Object.freeze({ id: 'openai-official', label: 'OpenAI', provider: 'openai-compatible', defaultBaseUrl: 'https://api.openai.com/v1', showKeyField: true, hideSaveDelete: false }),
  Object.freeze({ id: 'deepseek', label: 'DeepSeek', provider: 'openai-compatible', defaultBaseUrl: 'https://api.deepseek.com', showKeyField: true, hideSaveDelete: false }),
  Object.freeze({ id: 'moonshot', label: 'Kimi（月之暗面）', provider: 'openai-compatible', defaultBaseUrl: 'https://api.moonshot.cn/v1', showKeyField: true, hideSaveDelete: false }),
  Object.freeze({ id: 'zhipu', label: '智谱 GLM', provider: 'openai-compatible', defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4', showKeyField: true, hideSaveDelete: false }),
  Object.freeze({ id: 'openrouter', label: 'OpenRouter', provider: 'openai-compatible', defaultBaseUrl: 'https://openrouter.ai/api/v1', showKeyField: true, hideSaveDelete: false }),
  Object.freeze({ id: 'groq', label: 'Groq', provider: 'openai-compatible', defaultBaseUrl: 'https://api.groq.com/openai/v1', showKeyField: true, hideSaveDelete: false }),
  Object.freeze({ id: 'qwen', label: '通义千问', provider: 'openai-compatible', defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', showKeyField: true, hideSaveDelete: false }),
]);

/**
 * 由当前 BASE URL 与 provider 反推 UI 预设 id。
 * 匹配到已知生产商（同 provider 且 defaultBaseUrl 全等）→ 返回其 id；否则 `custom`。
 * 用于生产商下拉的回显：用户手填或改动 URL 后自动显示「自定义」。
 */
export function derivePresetId(baseUrl: string, provider: AiProvider): AiProviderPreset {
  const found = AI_PROVIDER_PRESETS.find(
    (preset) => preset.provider === provider && preset.defaultBaseUrl === baseUrl,
  );
  return found?.id ?? 'custom';
}

/**
 * 该 provider 是否**必须**提供 API Key（与 Rust `Provider::requires_key` 对齐）。
 * 只有公网 openai-compatible 强制要求；本地端点一律不强制。
 */
export function requiresApiKey(provider: AiProvider): boolean {
  return provider === 'openai-compatible';
}

/**
 * 该 provider 是否接受可选 Key（与 Rust `Provider::key_optional` 对齐）：
 * 本地 OpenAI 兼容端点有 Key 就带、没有也能用。
 */
export function isKeyOptional(provider: AiProvider): boolean {
  return provider === 'openai-compatible-local';
}

/** 是否本地运行时（Ollama / 本地 OpenAI 兼容）：共享 Local 网段策略与上下文预算。 */
export function isLocalProvider(provider: AiProvider): boolean {
  return provider === 'ollama' || provider === 'openai-compatible-local';
}

/**
 * 模型列表 / 测试连接是否可发起：
 * - Ollama / 本地 OpenAI 兼容：不强制 Key，未配置也可查；
 * - 公网 openai-compatible：必须先保存 Key（configured=true）。
 */
export function canQueryModels(provider: AiProvider, configured: boolean): boolean {
  return !requiresApiKey(provider) || configured;
}

/**
 * 回环地址列表（allowInsecureHttp 自动放行）。
 * 不含 IPv6 zone ID / ::ffff: 等极窄情况——本项目 Ollama 默认 localhost 已覆盖。
 */
const LOOPBACK_HOSTS = Object.freeze(['localhost', '127.0.0.1', '::1']);

/**
 * 给定 baseUrl 推断 allowInsecureHttp 默认值。
 *
 * 规则：
 *   - 无效 URL → false（默认拒绝，避免用户误填）
 *   - https → false（不需要）
 *   - http + 回环地址（localhost / 127.0.0.1 / ::1 / [::1]）→ true（自动放行）
 *   - http + 非回环 → false（**必须显式勾选**；Rust 侧会因 insecure 拒绝）
 */
export function inferAllowInsecureHttp(baseUrl: string): boolean {
  if (baseUrl.length === 0) return false;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:') return false;
    // URL.hostname 对 IPv6 带方括号：http://[::1]:11434 → hostname='[::1]'
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return LOOPBACK_HOSTS.includes(host);
  } catch {
    return false;
  }
}

/** baseUrl 格式校验（纯 JS URL 构造器）。失败返回错误消息字符串，通过返回 null。 */
export function validateBaseUrl(baseUrl: string): string | null {
  if (baseUrl.trim().length === 0) return '请填写 Base URL';
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return 'Base URL 必须以 http:// 或 https:// 开头';
    }
    return null;
  } catch {
    return 'Base URL 格式无效';
  }
}

/** 构造 AiEndpointRequest（传 app-api 的请求体）。 */
export interface AiEndpointRequest {
  readonly provider: AiProvider;
  readonly baseUrl: string;
  readonly allowInsecureHttp: boolean;
}

/** ai_key_save 扩展 Key 字段。 */
export interface AiKeySaveRequest extends AiEndpointRequest {
  readonly key: string;
}
