/**
 * T1-B：聊天请求构造（纯函数，零 React / 零 IPC）。
 *
 * messages 为全量对话：历史 user + 已完成 assistant + 本轮 user；
 * 排除未完成的 assistant 占位与失败/取消的残留文本；请求体不含 Key。
 */
import type { AiChatRequest, ChatMessage } from '../../types/ipc.ts';
import type { AiChatTurn } from './ai-chat-reducer.ts';
import { isLocalProvider, validateBaseUrl, type AiProvider } from './ai-endpoint.ts';

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

/**
 * 本地运行时（Ollama / 本地 OpenAI 兼容）的上下文预算（字符）。
 *
 * 本地模型没有云端那样的上下文计费，但显存/内存有限：把整段历史反复送给
 * oMLX 这类服务会触发 prefill_memory_exceeded。超出预算时从最早轮次开始丢弃，
 * 最后一条用户消息始终保留；公网 provider 不受此限制（保持原有行为）。
 */
export const LOCAL_CONTEXT_CHAR_BUDGET = 16_000;

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

/**
 * 按字符预算保留最近的消息：从最早一条开始丢弃，直到总量进入预算。
 * 不丢弃最后一条；裁剪后若以 assistant 开头，再跳过它，保证对话从 user 开始。
 */
function fitMessagesToBudget(messages: readonly ChatMessage[], budget: number): ChatMessage[] {
  let total = 0;
  for (const message of messages) total += message.content.length;
  if (total <= budget) return [...messages];
  let start = 0;
  while (start < messages.length - 1 && total > budget) {
    const dropped = messages[start];
    if (dropped === undefined) break;
    total -= dropped.content.length;
    start += 1;
  }
  while (start < messages.length - 1 && messages[start]?.role === 'assistant') {
    start += 1;
  }
  return messages.slice(start);
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
  const fitted = isLocalProvider(args.config.provider)
    ? fitMessagesToBudget(messages, LOCAL_CONTEXT_CHAR_BUDGET)
    : messages;
  return {
    ok: true,
    request: Object.freeze({
      requestId: args.requestId,
      provider: args.config.provider,
      baseUrl: args.config.baseUrl,
      allowInsecureHttp: args.config.allowInsecureHttp,
      model,
      messages: fitted,
    }),
  };
}
