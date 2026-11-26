/**
 * T1-B：聊天视图。
 *
 * 纯 features 组件：不 import src/data 或 @tauri-apps；
 * 聊天 IPC 由 AppShell 通过 AiPanelEffects 注入。
 */
import { useEffect, useState } from 'react';
import type {
  AiChatDeltaEvent,
  AiChatDoneEvent,
  AiChatErrorEvent,
  AiChatRequest,
} from '../../types/ipc.ts';
import { mapAiErrorCode } from './ai-error-map.ts';
import { validateBaseUrl } from './ai-endpoint.ts';
import {
  buildChatRequest,
  createChatRequestId,
  type ChatRequestFailure,
} from './ai-chat-request.ts';
import {
  chatErrorFromEvent,
  chatErrorFromUnknown,
  type AiChatError,
} from './ai-chat-errors.ts';
import type { AiChatTurn } from './ai-chat-reducer.ts';
import { useAiChatStore } from './ai-chat-store.ts';
import { AiChatMessageList } from './AiChatMessageList.tsx';
import { AiChatComposer } from './AiChatComposer.tsx';
import styles from './ai-panel.module.css';

export interface AiChatStreamHandlers {
  onDelta(event: AiChatDeltaEvent): void;
  onDone(event: AiChatDoneEvent): void;
  onError(event: AiChatErrorEvent): void;
}

/** AppShell 实现、features 消费的聊天 IPC 子集（不暴露 data 层类型）。 */
export interface AiChatEffects {
  chatStream(request: AiChatRequest, handlers: AiChatStreamHandlers): Promise<void>;
  cancelChat(requestId: string): Promise<{ readonly cancelled: boolean }>;
  /** 完成态回答落成 Markdown 文章并添加到当前画布；由 AppShell 注入。 */
  insertToCanvas?(this: void, text: string): Promise<void>;
}

export interface AiChatViewProps {
  readonly effects: AiChatEffects;
  /** ai_key_status.configured；Ollama 不使用。 */
  readonly configured: boolean;
}

const REQUEST_FAILURE_TEXT: Record<ChatRequestFailure, string> = {
  invalid_request_id: '请求编号无效，请重试',
  invalid_base_url: '请先在「设置」中填写有效的 Base URL',
  missing_model: '请先在「设置」中选择模型',
  empty_messages: '请输入消息后再发送',
};

export function AiChatView({ effects, configured }: AiChatViewProps) {
  const config = useAiChatStore((state) => state.config);
  const conversation = useAiChatStore((state) => state.conversation);
  const dispatch = useAiChatStore((state) => state.dispatch);
  const [input, setInput] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<AiChatError | null>(null);

  const streaming = conversation.status === 'streaming';

  // 关闭面板（组件卸载）时取消在途流；取消失败只记录，不阻塞关闭。
  useEffect(() => () => {
    const store = useAiChatStore.getState();
    const requestId = store.conversation.activeRequestId;
    if (requestId === null) return;
    store.dispatch({ type: 'CANCEL', requestId });
    void effects.cancelChat(requestId).catch((error: unknown) => {
      console.error('关闭 AI 面板时取消聊天流失败', error);
    });
  }, [effects]);

  const sendDisabledReason = (() => {
    if (validateBaseUrl(config.baseUrl) !== null) return '请先在「设置」中填写有效的 Base URL';
    if (config.model === null || config.model.trim().length === 0) return '请先在「设置」中选择模型';
    if (config.provider === 'openai-compatible' && !configured) return '请先在「设置」中保存 API Key';
    return null;
  })();

  const handleSend = async (): Promise<void> => {
    if (streaming) return;
    const text = input.trim();
    if (text.length === 0) return;

    const requestId = createChatRequestId();
    const userMessageId = `user-${requestId}`;
    const assistantMessageId = `assistant-${requestId}`;
    const pendingUser: AiChatTurn = {
      id: userMessageId,
      role: 'user',
      content: text,
      completed: true,
    };
    const built = buildChatRequest({
      requestId,
      config,
      messages: [...conversation.messages, pendingUser],
    });
    if (!built.ok) {
      setValidationError(REQUEST_FAILURE_TEXT[built.reason]);
      return;
    }

    setValidationError(null);
    setCancelError(null);
    dispatch({ type: 'SEND', requestId, userMessageId, assistantMessageId, text });
    setInput('');

    try {
      await effects.chatStream(built.request, {
        onDelta: (event) => dispatch({
          type: 'DELTA',
          requestId: event.requestId,
          text: event.text,
        }),
        onDone: (event) => dispatch({ type: 'DONE', requestId: event.requestId }),
        onError: (event) => dispatch({
          type: 'ERROR',
          requestId: event.requestId,
          error: chatErrorFromEvent(event),
        }),
      });
    } catch (error) {
      dispatch({ type: 'ERROR', requestId, error: chatErrorFromUnknown(error) });
    }
  };

  const handleStop = async (): Promise<void> => {
    const requestId = conversation.activeRequestId;
    if (requestId === null) return;
    dispatch({ type: 'CANCEL', requestId });
    setCancelError(null);
    try {
      await effects.cancelChat(requestId);
    } catch (error) {
      setCancelError(chatErrorFromUnknown(error));
    }
  };

  const handleRetry = async (): Promise<void> => {
    if (streaming) return;
    const msgs = conversation.messages;
    const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant');
    if (lastAssistant === undefined) return;
    // 重试：复用到最后一条 user 为止的历史，排除失败的 assistant 占位，重新生成同一条回复。
    const history = msgs.slice(0, msgs.findIndex((m) => m.id === lastAssistant.id));
    const requestId = createChatRequestId();
    const built = buildChatRequest({ requestId, config, messages: history });
    if (!built.ok) {
      setValidationError(REQUEST_FAILURE_TEXT[built.reason]);
      return;
    }
    setValidationError(null);
    setCancelError(null);
    dispatch({ type: 'RETRY', requestId, assistantId: lastAssistant.id });
    try {
      await effects.chatStream(built.request, {
        onDelta: (event) => dispatch({
          type: 'DELTA',
          requestId: event.requestId,
          text: event.text,
        }),
        onDone: (event) => dispatch({ type: 'DONE', requestId: event.requestId }),
        onError: (event) => dispatch({
          type: 'ERROR',
          requestId: event.requestId,
          error: chatErrorFromEvent(event),
        }),
      });
    } catch (error) {
      dispatch({ type: 'ERROR', requestId, error: chatErrorFromUnknown(error) });
    }
  };

  const errorMsg = conversation.error === null
    ? null
    : mapAiErrorCode(conversation.error.code, conversation.error.message);
  const cancelMsg = cancelError === null
    ? null
    : mapAiErrorCode(cancelError.code, cancelError.message);

  return (
    <div className={styles.chat}>
      <AiChatMessageList
        messages={conversation.messages}
        streaming={streaming}
        onPickSuggestion={setInput}
        onRetry={() => { void handleRetry(); }}
        onInsertToCanvas={effects.insertToCanvas}
      />

      {errorMsg !== null ? (
        <p className={errorMsg.tone === 'error' ? styles.errorBox : styles.warningBox}>
          {errorMsg.text}
        </p>
      ) : null}
      {cancelMsg !== null ? (
        <p className={cancelMsg.tone === 'error' ? styles.errorBox : styles.warningBox}>
          停止请求失败：{cancelMsg.text}
        </p>
      ) : null}
      {validationError !== null ? (
        <p className={styles.errorBox}>{validationError}</p>
      ) : null}
      {conversation.status === 'cancelled' && errorMsg === null ? (
        <p className={styles.infoBox}>已停止生成</p>
      ) : null}

      <AiChatComposer
        value={input}
        streaming={streaming}
        disabledReason={sendDisabledReason}
        onChange={setInput}
        onSend={() => { void handleSend(); }}
        onStop={() => { void handleStop(); }}
      />
    </div>
  );
}
