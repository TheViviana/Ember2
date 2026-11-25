/**
 * 设置壳「快捷键」页。
 *
 * 去掉宿主 / 遮罩 / 标题 / 关闭按钮；保存成功后留在壳内并显示提示。
 * 录制态 Esc 只取消录制（录制监听在 window 捕获阶段先于壳的 document 冒泡监听）。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  cloneCommandBindings,
  defaultCommandBindings,
  findBindingConflicts,
  formatBindingList,
  keyBindingFromKeyboardEvent,
  type CommandBindingMap,
} from '../commands/bindings.ts';
import type { CommandDefinition } from '../commands/commands.ts';
import styles from './shortcut-settings.module.css';

export interface ShortcutSettingsBodyProps {
  readonly definitions: readonly CommandDefinition[];
  readonly bindings: CommandBindingMap;
  readonly onSave: (bindings: CommandBindingMap) => string | null;
}

export function ShortcutSettingsBody({ definitions, bindings, onSave }: ShortcutSettingsBodyProps) {
  const [draft, setDraft] = useState(() => cloneCommandBindings(bindings));
  const [query, setQuery] = useState('');
  const [recording, setRecording] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const conflicts = useMemo(() => findBindingConflicts(draft), [draft]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return definitions;
    return definitions.filter((definition) =>
      [definition.title, definition.category, ...definition.keywords]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [definitions, query]);

  useEffect(() => {
    if (recording === null) return;
    const handler = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setRecording(null);
        return;
      }
      const binding = keyBindingFromKeyboardEvent(event);
      if (binding === null) return;
      setDraft((current) => ({ ...current, [recording]: [binding] }));
      setRecording(null);
      setError(null);
      setSaved(false);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [recording]);

  const save = (): void => {
    if (conflicts.length > 0) {
      setError('请先解决所有快捷键冲突');
      return;
    }
    const failure = onSave(draft);
    setError(failure);
    setSaved(failure === null);
  };

  return (
    <div className={styles.body}>
      <input
        className={styles.search}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="搜索命令"
        aria-label="搜索快捷键命令"
      />
      <div className={styles.table} role="list">
        {visible.map((definition) => {
          const current = draft[definition.id] ?? [];
          const defaults = defaultCommandBindings([definition])[definition.id] ?? [];
          const conflicted = conflicts.some((conflict) => conflict.commandIds.includes(definition.id));
          return (
            <div className={conflicted ? styles.rowConflict : styles.row} key={definition.id} role="listitem">
              <div className={styles.commandInfo}>
                <strong>{definition.title}</strong>
                <span>{definition.category}</span>
              </div>
              <span className={styles.binding}>
                {recording === definition.id ? '请按新快捷键…' : formatBindingList(current)}
              </span>
              <div className={styles.rowActions}>
                <button
                  type="button"
                  onClick={() => {
                    setRecording(definition.id);
                    setSaved(false);
                  }}
                >
                  修改
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDraft((value) => ({ ...value, [definition.id]: [] }));
                    setSaved(false);
                  }}
                >
                  清除
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDraft((value) => ({ ...value, [definition.id]: defaults }));
                    setSaved(false);
                  }}
                >
                  默认
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {conflicts.length > 0 ? (
        <div className={styles.error} role="alert">
          {conflicts.map((conflict) => (
            <p key={conflict.key}>{conflict.key} 冲突：{conflict.commandIds.join('、')}</p>
          ))}
        </div>
      ) : null}
      {error !== null ? <p className={styles.error} role="alert">{error}</p> : null}
      {saved && error === null ? <p className={styles.saved}>快捷键已保存</p> : null}
      <footer className={styles.footer}>
        <button
          type="button"
          onClick={() => {
            setDraft(defaultCommandBindings(definitions));
            setError(null);
            setSaved(false);
          }}
        >
          全部恢复默认
        </button>
        <span className={styles.spacer} />
        <button type="button" className={styles.primary} onClick={save} disabled={conflicts.length > 0}>保存</button>
      </footer>
    </div>
  );
}
