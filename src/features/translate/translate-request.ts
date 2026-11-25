/**
 * 翻译请求构造：复用现有 AI 流式通道，不新增 Rust 命令。
 *
 * 支持 AI 翻译与 OpenAI 兼容端点（含 Ollama）；Key 由既有 ai_key_save 管理。
 */
import { validateBaseUrl, type AiProvider } from '../ai/ai-endpoint.ts';
import { createChatRequestId } from '../ai/ai-chat-request.ts';
import type { AiChatRequest } from '../../types/ipc.ts';

export const TRANSLATE_LANGUAGES = Object.freeze([
  '中文',
  '英文',
  '日文',
  '韩文',
  '法文',
  '德文',
  '西班牙文',
]);

export const DEFAULT_TRANSLATE_LANGUAGE = '中文';

export interface TranslateRequestConfig {
  readonly provider: AiProvider;
  readonly baseUrl: string;
  readonly allowInsecureHttp: boolean;
  readonly model: string | null;
}

export type TranslateRequestResult =
  | { readonly ok: true; readonly request: AiChatRequest }
  | { readonly ok: false; readonly reason: string };

export function buildTranslateRequest(args: {
  readonly config: TranslateRequestConfig;
  readonly text: string;
  readonly targetLang: string;
  readonly requestId?: string;
}): TranslateRequestResult {
  const text = args.text.trim();
  if (text === '') return { ok: false, reason: '没有可翻译的内容' };
  if (validateBaseUrl(args.config.baseUrl) !== null) {
    return { ok: false, reason: 'AI 端点地址无效，请先在设置中配置' };
  }
  const model = args.config.model?.trim() ?? '';
  if (model === '') return { ok: false, reason: '未选择模型，请先在 AI 设置中选择模型' };

  const targetLang = args.targetLang.trim() === '' ? DEFAULT_TRANSLATE_LANGUAGE : args.targetLang.trim();
  return {
    ok: true,
    request: Object.freeze({
      requestId: args.requestId ?? createChatRequestId(),
      provider: args.config.provider,
      baseUrl: args.config.baseUrl,
      allowInsecureHttp: args.config.allowInsecureHttp,
      model,
      messages: [
        {
          role: 'user' as const,
          content: `将下面的内容翻译为${targetLang}，只输出译文，不要解释、不要添加标题：\n\n${text}`,
        },
      ],
    }),
  };
}
