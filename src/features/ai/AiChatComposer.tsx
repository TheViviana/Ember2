/**
 * T1-B：聊天输入框。
 * Enter 发送、Shift+Enter 换行；IME 组合期间按 Enter 不发送。
 */
import { useRef } from 'react';
import styles from './ai-panel.module.css';

export interface AiChatComposerProps {
  readonly value: string;
  readonly streaming: boolean;
  readonly disabledReason: string | null;
  readonly onChange: (value: string) => void;
  readonly onSend: () => void;
  readonly onStop: () => void;
}

export function AiChatComposer({
  value,
  streaming,
  disabledReason,
  onChange,
  onSend,
  onStop,
}: AiChatComposerProps) {
  const composingRef = useRef(false);
  const canSend = !streaming && disabledReason === null && value.trim().length > 0;

  return (
    <div className={styles.chatComposer}>
      <textarea
        className={styles.chatInput}
        value={value}
        placeholder={streaming ? '正在生成，可点「停止」中断…' : '输入消息…'}
        onChange={(event) => onChange(event.target.value)}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey) return;
          if (composingRef.current || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (canSend) onSend();
        }}
        rows={3}
      />
      <div className={styles.chatComposerActions}>
        {disabledReason !== null && !streaming ? (
          <p className={styles.chatHint}>{disabledReason}</p>
        ) : (
          <span className={styles.actionsSpacer} />
        )}
        {streaming ? (
          <button type="button" className={styles.dangerBtn} onClick={onStop}>
            停止
          </button>
        ) : (
          <button
            type="button"
            className={styles.primaryBtn}
            onClick={onSend}
            disabled={!canSend}
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
}
