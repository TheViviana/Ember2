/**
 * T1-B：聊天请求构造（纯函数，零 React / 零 IPC）。
 *
 * messages 为全量对话：历史 user + 已完成 assistant + 本轮 user；
 * 排除未完成的 assistant 占位与失败/取消的残留文本；请求体不含 Key。
 */
import type { AiChatRequest, ChatMessage } from '../../types/ipc.ts';
import type { AiChatTurn } from './ai-chat-reducer.ts';
import { validateBaseUrl, type AiProvider } from './ai-endpoint.ts';

export interface ChatRequestConfig {
  readonly provider: AiProvider;
  readonly baseUrl: string;
  readonly allowInsecureHttp: boolean;
  readonly model: string | null;
}

export type ChatRequestFailure =
  | 'invalid_request_id'
  | 'invalid_base_url'
  | 'missing_model'
  | 'empty_messages';

export type BuildChatRequestResult =
  | { readonly ok: true; readonly request: AiChatRequest }
  | { readonly ok: false; readonly reason: ChatRequestFailure };

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** 生产用 requestId；满足契约的非空、≤128 字节、`[A-Za-z0-9_-]`。 */
export function createChatRequestId(): string {
  return crypto.randomUUID();
}

function toMessages(turns: readonly AiChatTurn[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const turn of turns) {
    if (turn.role === 'user') {
      if (turn.content.trim().length > 0) {
        messages.push({ role: 'user', content: turn.content });
      }
      continue;
    }
    if (turn.completed && turn.content.trim().length > 0) {
      messages.push({ role: 'assistant', content: turn.content });
    }
  }
  return messages;
}

export function buildChatRequest(args: {
  readonly requestId: string;
  readonly config: ChatRequestConfig;
  readonly messages: readonly AiChatTurn[];
}): BuildChatRequestResult {
  if (!REQUEST_ID_PATTERN.test(args.requestId)) {
    return { ok: false, reason: 'invalid_request_id' };
  }
  if (validateBaseUrl(args.config.baseUrl) !== null) {
    return { ok: false, reason: 'invalid_base_url' };
  }
  const model = args.config.model?.trim() ?? '';
  if (model.length === 0) {
    return { ok: false, reason: 'missing_model' };
  }
  const messages = toMessages(args.messages);
  if (messages.length === 0) {
    return { ok: false, reason: 'empty_messages' };
  }
  return {
    ok: true,
    request: Object.freeze({
      requestId: args.requestId,
      provider: args.config.provider,
      baseUrl: args.config.baseUrl,
      allowInsecureHttp: args.config.allowInsecureHttp,
      model,
      messages,
    }),
  };
}
