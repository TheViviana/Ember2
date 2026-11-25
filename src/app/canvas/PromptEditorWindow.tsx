/**
 * 提示词编辑浮窗（2026-11-23 用户需求）。
 *
 * 双击提示词节点不再在节点上盖一个与节点同尺寸的 textarea，而是打开这个
 * 可拖动缩放的独立浮窗；右下角「关闭」保存当前内容（空内容也允许，等于清空），
 * ⌘/Ctrl+Enter 或 Esc 同样关闭保存。
 */
import { useEffect, useRef } from 'react';
import styles from './PromptEditorWindow.module.css';

export interface PromptEditorWindowProps {
  readonly initialText: string;
  readonly onClose: (text: string) => boolean;
}

export function PromptEditorWindow({ initialText, onClose }: PromptEditorWindowProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const closedRef = useRef(false);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    textarea.focus();
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
  }, []);

  const close = (): void => {
    if (closedRef.current) return;
    // 保存失败时父层返回 false，窗口保留，允许修改后重试。
    if (onClose(textareaRef.current?.value ?? '')) closedRef.current = true;
  };

  return (
    <div className={styles.window} role="dialog" aria-label="编辑提示词">
      <header className={styles.header}>
        <span className={styles.title}>提示词</span>
        <span className={styles.hint}>关闭后立即保存；空白也可以关闭</span>
      </header>
      <div className={styles.body}>
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          defaultValue={initialText}
          placeholder="输入提示词…"
          spellCheck={false}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (
              event.key === 'Escape' ||
              (event.key === 'Enter' && (event.metaKey || event.ctrlKey))
            ) {
              event.preventDefault();
              close();
            }
          }}
        />
      </div>
      <footer className={styles.footer}>
        <button type="button" className={styles.close} onClick={close}>
          关闭
        </button>
      </footer>
    </div>
  );
}
