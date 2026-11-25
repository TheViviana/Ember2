/**
 * 固定标签栏：chips 展示 frontmatter tags，支持斜杠层级命名与增删。
 *
 * 只收集用户意图，写回文档由外层（EditorWindow）完成。
 */
import { useState } from 'react';
import { normalizeTagPath, tagLeaf } from '../../core/tag-path.ts';
import styles from './TagBar.module.css';

export interface TagBarProps {
  readonly tags: readonly string[];
  readonly onChange?: (tags: readonly string[]) => void;
  readonly disabled?: boolean;
}

export function TagBar({ tags, onChange, disabled = false }: TagBarProps) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const commit = (): void => {
    const tag = normalizeTagPath(draft);
    if (tag === null) {
      if (draft.trim() !== '') setError('标签不能为空，且不超过 120 个字符');
      return;
    }
    if (!tags.includes(tag)) onChange?.([...tags, tag]);
    setDraft('');
    setError(null);
  };

  return (
    <div className={styles.bar} role="group" aria-label="文档标签">
      <span className={styles.label}>标签</span>
      <div className={styles.chips}>
        {tags.length === 0 ? <span className={styles.empty}>暂无标签</span> : null}
        {tags.map((tag) => (
          <span key={tag} className={styles.chip} title={tag}>
            <span className={styles.chipRoot}>{tag.includes('/') ? `${tag.slice(0, tag.lastIndexOf('/') + 1)}` : ''}</span>
            <span className={styles.chipLeaf}>{tagLeaf(tag)}</span>
            {disabled || onChange === undefined ? null : (
              <button
                type="button"
                className={styles.remove}
                aria-label={`移除标签 ${tag}`}
                onClick={() => onChange(tags.filter((item) => item !== tag))}
              >
                ×
              </button>
            )}
          </span>
        ))}
      </div>
      {disabled || onChange === undefined ? null : (
        <div className={styles.inputWrap}>
          <input
            className={styles.input}
            value={draft}
            placeholder="添加标签，如 项目/前端"
            aria-label="添加标签"
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commit();
              } else if (event.key === 'Escape') {
                setDraft('');
                setError(null);
              }
            }}
          />
          <button type="button" className={styles.add} onClick={commit}>添加</button>
        </div>
      )}
      {error !== null ? <span className={styles.error} role="alert">{error}</span> : null}
    </div>
  );
}
