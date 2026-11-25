/**
 * T1-B：聊天错误归一化（纯函数，零 React / 零 IPC）。
 *
 * 首 delta 前失败走 Promise reject；首 delta 后失败走 error 事件。
 * 两条路径最终都折成 AiChatError，交给 mapAiErrorCode 出中文文案。
 */
import type { AiChatErrorEvent } from '../../types/ipc.ts';

export interface AiChatError {
  readonly code: string | undefined;
  readonly message: string;
}

export function chatErrorFromEvent(event: AiChatErrorEvent): AiChatError {
  return Object.freeze({ code: event.code, message: event.message });
}

export function chatErrorFromUnknown(error: unknown): AiChatError {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return Object.freeze({
      code: typeof code === 'string' ? code : undefined,
      message: error.message,
    });
  }

  if (typeof error === 'object' && error !== null) {
    const record = error as { code?: unknown; message?: unknown };
    return Object.freeze({
      code: typeof record.code === 'string' ? record.code : undefined,
      message: typeof record.message === 'string' ? record.message : '未知错误',
    });
  }

  return Object.freeze({
    code: undefined,
    message: typeof error === 'string' ? error : String(error),
  });
}

/** 用户主动取消：UI 展示为 cancelled，不按错误处理。 */
export function isCancelledChatError(error: AiChatError): boolean {
  return error.code === 'E_AI_CANCELLED';
}
