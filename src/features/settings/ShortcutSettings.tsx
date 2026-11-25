import { useEffect, useMemo, useState } from 'react';
import { Z_MODAL } from '../../windows/layer-z.ts';
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

export interface ShortcutSettingsProps {
  readonly definitions: readonly CommandDefinition[];
  readonly bindings: CommandBindingMap;
  readonly onSave: (bindings: CommandBindingMap) => string | null;
  readonly onClose: () => void;
}

export function ShortcutSettings({ definitions, bindings, onSave, onClose }: ShortcutSettingsProps) {
  const [draft, setDraft] = useState(() => cloneCommandBindings(bindings));
  const [query, setQuery] = useState('');
  const [recording, setRecording] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [recording]);

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && recording === null) onClose();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onClose, recording]);

  const save = (): void => {
    if (conflicts.length > 0) {
      setError('请先解决所有快捷键冲突');
      return;
    }
    const failure = onSave(draft);
    setError(failure);
    if (failure === null) onClose();
  };

  return (
    <div className={styles.host} style={{ zIndex: Z_MODAL }}>
      <div
        className={styles.backdrop}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <section className={styles.panel} role="dialog" aria-modal="true" aria-label="快捷键设置">
          <header className={styles.header}>
            <h2 className={styles.title}>快捷键</h2>
            <button type="button" className={styles.closeButton} onClick={onClose} aria-label="关闭快捷键设置">×</button>
          </header>
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
                    <button type="button" onClick={() => setRecording(definition.id)}>修改</button>
                    <button type="button" onClick={() => setDraft((value) => ({ ...value, [definition.id]: [] }))}>清除</button>
                    <button type="button" onClick={() => setDraft((value) => ({ ...value, [definition.id]: defaults }))}>默认</button>
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
          <footer className={styles.footer}>
            <button
              type="button"
              onClick={() => {
                setDraft(defaultCommandBindings(definitions));
                setError(null);
              }}
            >
              全部恢复默认
            </button>
            <span className={styles.spacer} />
            <button type="button" onClick={onClose}>取消</button>
            <button type="button" className={styles.primary} onClick={save} disabled={conflicts.length > 0}>保存</button>
          </footer>
        </section>
      </div>
    </div>
  );
}
