/**
 * CR-R5-1：AI 流式管线单源（纯编排，零 React / 零 IPC）。
 *
 * 统一 createChatRequestId → buildChatRequest → system 前置 → 流式回调与失败归类；
 * 传输与取消由调用方注入，故 node 下可用 fake 覆盖全部失败路径。
 */
import type { AiChatRequest } from '../../types/ipc.ts';
import type { AiChatTurn } from './ai-chat-reducer.ts';
import {
  buildChatRequest,
  createChatRequestId,
  type ChatRequestConfig,
  type ChatRequestFailure,
} from './ai-chat-request.ts';
import { chatErrorFromUnknown } from './ai-chat-errors.ts';
import { mapAiErrorCode } from './ai-error-map.ts';

export interface ChatSessionArgs {
  readonly requestId?: string;
  readonly config: ChatRequestConfig;
  readonly messages: readonly AiChatTurn[];
  readonly system?: string;
}

export type ChatSessionFailure =
  | { readonly kind: 'build'; readonly reason: ChatRequestFailure }
  | {
      readonly kind: 'stream';
      readonly code: string | undefined;
      /** 原始错误文案（各宿主自行拼卡片文案时使用）。 */
      readonly message: string;
      /** mapAiErrorCode 的中文文案（节点 / 聊天卡片直接展示）。 */
      readonly text: string;
    };

export interface ChatSessionHandlers {
  /** 累积后的全文，非单段增量。 */
  readonly onDelta: (text: string) => void;
  readonly onDone: () => void;
  readonly onError: (failure: ChatSessionFailure) => void;
}

export interface ChatSessionStreamHandlers {
  readonly onDelta: (text: string) => void;
  readonly onDone: () => void;
  readonly onError: (code: string | undefined, message: string) => void;
}

export interface ChatSessionDeps {
  readonly stream: (request: AiChatRequest, handlers: ChatSessionStreamHandlers) => Promise<void>;
  readonly cancel: (requestId: string) => unknown;
}

export interface ChatSession {
  /** 取消在途请求；已结束或重复调用时空转。 */
  readonly cancel: () => void;
}

export function startChatSession(
  args: ChatSessionArgs,
  handlers: ChatSessionHandlers,
  deps: ChatSessionDeps,
): ChatSession {
  const requestId = args.requestId ?? createChatRequestId();
  const built = buildChatRequest({
    requestId,
    config: args.config,
    messages: args.messages,
  });
  if (!built.ok) {
    handlers.onError({ kind: 'build', reason: built.reason });
    return Object.freeze({ cancel: (): void => undefined });
  }
  const request: AiChatRequest = args.system === undefined
    ? built.request
    : Object.freeze({
        ...built.request,
        messages: [{ role: 'system' as const, content: args.system }, ...built.request.messages],
      });
  let settled = false;
  let full = '';
  const fail = (code: string | undefined, message: string): void => {
    if (settled) return;
    settled = true;
    handlers.onError({
      kind: 'stream',
      code,
      message,
      text: mapAiErrorCode(code, message).text,
    });
  };
  void deps
    .stream(request, {
      onDelta: (text) => {
        if (settled) return;
        full += text;
        handlers.onDelta(full);
      },
      onDone: () => {
        if (settled) return;
        settled = true;
        handlers.onDone();
      },
      onError: fail,
    })
    .catch((error: unknown) => {
      const normalized = chatErrorFromUnknown(error);
      fail(normalized.code, normalized.message);
    });
  return Object.freeze({
    cancel: (): void => {
      if (settled) return;
      settled = true;
      void Promise.resolve(deps.cancel(requestId)).catch(() => undefined);
    },
  });
}
