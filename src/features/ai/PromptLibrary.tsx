/**
 * 常用系统提示词库：保存、套用、改名、删除；列表限高滚动，套用后提供撤销。
 */
import { useEffect, useRef, useState } from 'react';
import styles from './PromptLibrary.module.css';
import type { SavedPrompt } from './prompt-library.ts';

export interface PromptLibraryProps {
  readonly items: readonly SavedPrompt[];
  readonly currentContent: string;
  readonly disabled?: boolean;
  /** 返回错误文案；null 表示成功。 */
  readonly onAdd: (name: string, content: string) => string | null;
  readonly onApply: (content: string) => void;
  readonly onRemove: (id: string) => void;
  /** 返回错误文案；null 表示成功。 */
  readonly onRename: (id: string, name: string) => string | null;
}

interface AppliedToast {
  readonly name: string;
  readonly previous: string;
}

export function PromptLibrary({
  items,
  currentContent,
  disabled = false,
  onAdd,
  onApply,
  onRemove,
  onRename,
}: PromptLibraryProps) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [toast, setToast] = useState<AppliedToast | null>(null);
  const toastTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
  }, []);

  const showToast = (next: AppliedToast): void => {
    setToast(next);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  };

  const handleSave = (): void => {
    const message = onAdd(name, currentContent);
    if (message !== null) {
      setError(message);
      return;
    }
    setAdding(false);
    setName('');
    setError(null);
  };

  const handleRename = (id: string): void => {
    const message = onRename(id, renameValue);
    if (message !== null) {
      setError(message);
      return;
    }
    setRenamingId(null);
    setRenameValue('');
    setError(null);
  };

  const apply = (prompt: SavedPrompt): void => {
    const previous = currentContent;
    onApply(prompt.content);
    showToast({ name: prompt.name, previous });
  };

  return (
    <div className={styles.library}>
      <div className={styles.header}>
        <span className={styles.title}>常用提示词</span>
        <button
          type="button"
          className={styles.ghostBtn}
          disabled={disabled || currentContent.trim() === ''}
          onClick={() => { setAdding(true); setError(null); }}
        >
          ＋ 保存
        </button>
      </div>

      {adding ? (
        <div className={styles.addForm}>
          <input
            className={styles.input}
            value={name}
            maxLength={24}
            autoFocus
            placeholder="给这条提示词起个名字"
            aria-label="提示词名称"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                handleSave();
              } else if (event.key === 'Escape') {
                setAdding(false);
                setError(null);
              }
            }}
          />
          <button type="button" className={styles.primaryBtn} onClick={handleSave}>
            保存
          </button>
          <button
            type="button"
            className={styles.ghostBtn}
            onClick={() => { setAdding(false); setError(null); }}
          >
            取消
          </button>
        </div>
      ) : null}

      {error !== null ? <p className={styles.error}>{error}</p> : null}

      {toast !== null ? (
        <div className={styles.toast} role="status">
          <span className={styles.toastText}>已套用「{toast.name}」</span>
          <button
            type="button"
            className={styles.toastAction}
            onClick={() => {
              onApply(toast.previous);
              setToast(null);
            }}
          >
            撤销
          </button>
        </div>
      ) : null}

      {items.length === 0 ? (
        <p className={styles.empty}>保存常用提示词，一键复用。</p>
      ) : (
        <ul className={styles.list}>
          {items.map((item) => (
            <li key={item.id} className={styles.item}>
              {renamingId === item.id ? (
                <div className={styles.renameForm}>
                  <input
                    className={styles.input}
                    value={renameValue}
                    maxLength={24}
                    autoFocus
                    aria-label="重命名提示词"
                    onChange={(event) => setRenameValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        handleRename(item.id);
                      } else if (event.key === 'Escape') {
                        setRenamingId(null);
                        setError(null);
                      }
                    }}
                  />
                  <button type="button" className={styles.primaryBtn} onClick={() => handleRename(item.id)}>
                    确定
                  </button>
                  <button
                    type="button"
                    className={styles.ghostBtn}
                    onClick={() => { setRenamingId(null); setError(null); }}
                  >
                    取消
                  </button>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className={styles.applyBtn}
                    disabled={disabled}
                    title={item.content}
                    onClick={() => apply(item)}
                  >
                    <span className={styles.name}>{item.name}</span>
                    <span className={styles.summary}>{item.content}</span>
                  </button>
                  <div className={styles.itemActions}>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      aria-label={`重命名 ${item.name}`}
                      disabled={disabled}
                      onClick={() => {
                        setRenamingId(item.id);
                        setRenameValue(item.name);
                        setError(null);
                      }}
                    >
                      改名
                    </button>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      aria-label={`删除 ${item.name}`}
                      disabled={disabled}
                      onClick={() => onRemove(item.id)}
                    >
                      删除
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}