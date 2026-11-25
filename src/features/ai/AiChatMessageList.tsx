/**
 * T1-B：聊天消息列表 + 自动滚动。
 * 用户离开底部超过 48px 后不再强制拉回；流式结束/发送时若仍在底部则跟随。
 */
import { useEffect, useRef } from 'react';
import type { AiChatTurn } from './ai-chat-reducer.ts';
import styles from './ai-panel.module.css';

export interface AiChatMessageListProps {
  readonly messages: readonly AiChatTurn[];
  readonly streaming: boolean;
}

const NEAR_BOTTOM_PX = 48;

export function AiChatMessageList({ messages, streaming }: AiChatMessageListProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null && nearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className={styles.chatEmpty} role="log" aria-live="polite">
        <p className={styles.chatEmptyTitle}>开始一段对话</p>
        <p className={styles.chatEmptyHint}>Enter 发送，Shift+Enter 换行。</p>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className={styles.chatMessages}
      role="log"
      aria-live="polite"
      aria-busy={streaming}
      onScroll={() => {
        const el = scrollRef.current;
        if (el === null) return;
        nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
      }}
    >
      {messages.map((message) => {
        const isUser = message.role === 'user';
        const showCaret = !isUser && streaming && !message.completed;
        return (
          <div
            key={message.id}
            className={`${styles.chatRow} ${isUser ? styles.chatRowUser : styles.chatRowAssistant}`}
          >
            <div
              className={`${styles.chatBubble} ${
                isUser ? styles.chatBubbleUser : styles.chatBubbleAssistant
              } ${showCaret ? styles.chatBubbleStreaming : ''}`}
            >
              {message.content.length > 0 ? message.content : showCaret ? '…' : ''}
            </div>
          </div>
        );
      })}
    </div>
  );
}
