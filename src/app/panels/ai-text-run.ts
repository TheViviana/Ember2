/**
 * CR-R4-4：选中文本 AI 动作执行（依赖注入，零 React / 零 IPC）。
 *
 * 模型配置、传输、取消与卡片文案全部经 deps 注入；本模块只做
 * 「动作 → 请求 → 流式回调」编排，故 node 下可用 fake 覆盖全部失败路径。
 */
import type { AiChatRequest } from '../../types/ipc.ts';
import type { ChatStreamHandlers } from '../../data/ipc-client.ts';
import type { AiTextActionId } from '../../features/ai/ai-text-actions.ts';
import type { AiTextRunHandlers } from '../../editor/AiSelectionMenu.tsx';
import { buildAiTextPrompt, findAiTextAction } from '../../features/ai/ai-text-actions.ts';
import type {
  ChatRequestConfig,
  ChatRequestFailure,
} from '../../features/ai/ai-chat-request.ts';
import { startChatSession, type ChatSession } from '../../features/ai/chat-session.ts';

/** 交给 notice 端口的失败描述（文案留在宿主侧，保证卡片文案不变）。 */
export type AiTextFailure =
  | { readonly kind: 'unknown-action' }
  | { readonly kind: 'config'; readonly reason: ChatRequestFailure }
  | { readonly kind: 'stream'; readonly code: string | undefined; readonly message: string };

export type AiTextNotice = (failure: AiTextFailure) => string;

export interface AiTextRunDeps {
  /** 每次执行时读取最新配置；禁止本模块直接 import 任何 zustand store。 */
  readonly config: () => ChatRequestConfig;
  readonly stream: (request: AiChatRequest, handlers: ChatStreamHandlers) => Promise<void>;
  readonly cancel: (requestId: string) => Promise<unknown>;
  readonly notice: AiTextNotice;
}

export interface AiTextRun {
  /** 返回本次请求的取消函数（EditorView 契约）。 */
  readonly run: (
    actionId: AiTextActionId,
    text: string,
    handlers: AiTextRunHandlers,
  ) => () => void;
  /** 取消当前在途请求；无在途请求时安全空转。 */
  readonly cancel: () => void;
}

export function createAiTextRun(deps: AiTextRunDeps): AiTextRun {
  const { config, stream, cancel: cancelRequest, notice } = deps;
  let active: { session: ChatSession | null } | null = null;

  const run: AiTextRun['run'] = (actionId, text, handlers) => {
    const action = findAiTextAction(actionId);
    if (action === null) {
      handlers.onError(notice({ kind: 'unknown-action' }));
      return () => undefined;
    }
    const prompt = buildAiTextPrompt(action, text);
    const handle: { session: ChatSession | null } = { session: null };
    let full = '';
    let settled = false;
    const session = startChatSession(
      {
        config: config(),
        messages: [{ id: 'ai-text-input', role: 'user', content: prompt.user, completed: true }],
        system: prompt.system,
      },
      {
        onDelta: (current) => {
          full = current;
          handlers.onDelta(current);
        },
        onDone: () => {
          settled = true;
          if (active === handle) active = null;
          handlers.onDone(full);
        },
        onError: (failure) => {
          settled = true;
          if (active === handle) active = null;
          handlers.onError(
            failure.kind === 'build'
              ? notice({ kind: 'config', reason: failure.reason })
              : notice({ kind: 'stream', code: failure.code, message: failure.message }),
          );
        },
      },
      {
        stream: (request, streamHandlers) => stream(request, {
          onDelta: (event) => streamHandlers.onDelta(event.text),
          onDone: () => streamHandlers.onDone(),
          onError: (_error, event) => streamHandlers.onError(event.code, event.message),
        }),
        cancel: cancelRequest,
      },
    );
    handle.session = session;
    if (!settled) active = handle;
    return () => {
      if (active === handle) active = null;
      session.cancel();
    };
  };

  const cancel = (): void => {
    const handle = active;
    if (handle === null) return;
    active = null;
    handle.session?.cancel();
  };

  return Object.freeze({ run, cancel });
}
