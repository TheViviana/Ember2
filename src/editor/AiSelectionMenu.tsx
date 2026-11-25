/**
 * CR-20261121-49：编辑器选中文本后的 AI 动作浮层与结果卡片。
 *
 * 纯展示组件：选区探测、AI 调用与文本替换都在 EditorView / 宿主完成；
 * 这里只负责按锚点定位、渲染动作列表与结果（替换 / 丢弃）。
 */
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { AiTextAction, AiTextActionId } from './ai-text-types.ts';
import styles from './AiSelectionMenu.module.css';

export type AiCardStatus = 'streaming' | 'done' | 'error';

export interface AiSelectionCardState {
  readonly action: AiTextAction;
  readonly status: AiCardStatus;
  readonly text: string;
  readonly error: string | null;
  readonly left: number;
  readonly top: number;
}

/** 宿主注入的流式执行器：返回取消函数。 */
export interface AiTextRunHandlers {
  onDelta(full: string): void;
  onDone(full: string): void;
  onError(message: string): void;
}

export type AiTextRunner = (
  action: AiTextActionId,
  text: string,
  handlers: AiTextRunHandlers,
) => () => void;

const MENU_WIDTH = 300;
const CARD_WIDTH = 380;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

export interface AiSelectionMenuProps {
  readonly left: number;
  readonly top: number;
  readonly card: AiSelectionCardState | null;
  readonly actions: readonly AiTextAction[];
  readonly onPick: (action: AiTextAction) => void;
  readonly onDiscard: () => void;
  readonly onReplace: () => void;
}

export function AiSelectionMenu({ left, top, card, actions, onPick, onDiscard, onReplace }: AiSelectionMenuProps) {
  const width = card === null ? MENU_WIDTH : CARD_WIDTH;
  const style = {
    left: clamp(left, 8, Math.max(8, window.innerWidth - width - 12)),
    top: clamp(top, 8, Math.max(8, window.innerHeight - (card === null ? 64 : 260))),
  };

  // 按压浮层不转移焦点，避免 CodeMirror / 预览选区被清空。
  const keepSelection = (event: ReactMouseEvent): void => event.preventDefault();

  if (card === null) {
    return (
      <div
        className={styles.menu}
        style={style}
        role="toolbar"
        aria-label="AI 文本操作"
        onMouseDown={keepSelection}
      >
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className={styles.menuItem}
            onClick={() => onPick(action)}
          >
            {action.label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <section
      className={styles.card}
      style={style}
      role="dialog"
      aria-label={`AI ${card.action.label}`}
      onMouseDown={keepSelection}
    >
      <header className={styles.cardHeader}>
        <span className={styles.cardTitle}>{card.action.label}</span>
        <span className={styles.cardState}>
          {card.status === 'streaming' ? '生成中…' : card.status === 'error' ? '失败' : ''}
        </span>
      </header>
      <div className={styles.cardBody}>
        {card.text === '' && card.status === 'streaming' ? '正在生成…' : card.text}
        {card.status === 'streaming' && card.text !== '' ? <span className={styles.caret} /> : null}
      </div>
      {card.status === 'error' && card.error !== null ? (
        <p className={styles.cardError}>{card.error}</p>
      ) : null}
      <footer className={styles.cardActions}>
        <button type="button" className={styles.ghostBtn} onClick={onDiscard}>
          丢弃
        </button>
        <button
          type="button"
          className={styles.primaryBtn}
          disabled={card.status !== 'done'}
          onClick={onReplace}
        >
          替换
        </button>
      </footer>
    </section>
  );
}
