/**
 * 画布左侧 AI 对话圆形入口（CR-20261120-35）。
 * 点击展开对话面板，再次点击关闭；不因点击空白自动关闭。
 */
import { Icon } from '../../ui/icon.tsx';
import styles from './ai-chat-button.module.css';

export interface AiChatButtonProps {
  readonly open: boolean;
  readonly onToggle: () => void;
}

export function AiChatButton({ open, onToggle }: AiChatButtonProps) {
  return (
    <button
      type="button"
      className={`${styles.button} ${open ? styles.active : ''}`}
      aria-label={open ? '收起 AI 对话' : '展开 AI 对话'}
      aria-expanded={open}
      aria-controls="ai-panel"
      onClick={onToggle}
    >
      {open ? (
        /* 打开态=关闭（×）：面板自身的关闭按钮已移除（CR-20261121-57），本钮承担开合 */
        <Icon size={16} className={styles.icon}>
          <path d="M6 6l12 12M18 6L6 18" />
        </Icon>
      ) : (
        <Icon size={16} className={styles.icon}>
          <path d="M10.5 3.5A2.3 2.3 0 0 0 8.2 5.6 2.3 2.3 0 0 0 6.3 8.7a2.3 2.3 0 0 0 .5 4.2A2.3 2.3 0 0 0 9 17h1.5v-13.5Z" />
          <path d="M13.5 3.5A2.3 2.3 0 0 1 15.8 5.6 2.3 2.3 0 0 1 17.7 8.7a2.3 2.3 0 0 1-.5 4.2A2.3 2.3 0 0 1 15 17h-1.5v-13.5Z" />
          <path d="M10.5 17v1.5a1.5 1.5 0 0 0 3 0V17" />
        </Icon>
      )}
    </button>
  );
}
