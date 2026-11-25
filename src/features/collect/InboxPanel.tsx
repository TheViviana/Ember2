import { useEffect, useState } from 'react';
import type { DragEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Z_MODAL } from '../../windows/layer-z.ts';
import {
  createLinkItem,
  createTextItem,
  type InboxItem,
  type InboxItemFactory,
} from './model.ts';
import styles from './inbox.module.css';

export interface InboxDragHandlers {
  onStart(item: InboxItem, event: ReactPointerEvent<HTMLDivElement>): void;
  onMove(item: InboxItem, event: ReactPointerEvent<HTMLDivElement>): void;
  onEnd(item: InboxItem, event: ReactPointerEvent<HTMLDivElement>): void;
  onCancel(item: InboxItem, event: ReactPointerEvent<HTMLDivElement>): void;
}

export interface InboxPanelProps {
  readonly items: readonly InboxItem[];
  readonly persistenceError: string | null;
  readonly loadWarning: string | null;
  readonly onChange: (items: readonly InboxItem[]) => void;
  readonly onClose: () => void;
  readonly dragHandlers: InboxDragHandlers;
  readonly factory?: InboxItemFactory;
  readonly confirmClear?: () => boolean;
}

function defaultId(): string {
  return globalThis.crypto.randomUUID();
}

function itemTitle(item: InboxItem): string {
  if (item.kind === 'file') return item.name;
  if (item.kind === 'link') return item.label;
  return item.text;
}

function itemDetail(item: InboxItem): string {
  if (item.kind === 'file') return item.path;
  if (item.kind === 'link') return item.url;
  return '文本';
}

export function InboxPanel({
  items,
  persistenceError,
  loadWarning,
  onChange,
  onClose,
  dragHandlers,
  factory = { id: defaultId, now: () => Date.now() },
  confirmClear = () => window.confirm('确定清空收集箱？此操作不会删除源文件。'),
}: InboxPanelProps) {
  const [kind, setKind] = useState<'text' | 'link'>('text');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onClose]);

  const append = (item: InboxItem | null): void => {
    if (item === null) {
      setError(kind === 'text' ? '请输入非空文本' : '请输入有效的 http(s) 链接');
      return;
    }
    onChange([item, ...items]);
    setText('');
    setUrl('');
    setLabel('');
    setError(null);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    const value = event.dataTransfer.getData('text/plain');
    if (value === '') return;
    event.preventDefault();
    const asLink = createLinkItem(value, value, factory);
    append(asLink ?? createTextItem(value, factory));
  };

  return (
    <div className={styles.host} style={{ zIndex: Z_MODAL }}>
      <div
        className={styles.backdrop}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <section className={styles.panel} role="dialog" aria-modal="false" aria-label="收集箱">
          <header className={styles.header}>
            <h2 className={styles.title}>收集箱</h2>
            <button type="button" className={styles.closeButton} onClick={onClose} aria-label="关闭收集箱">×</button>
          </header>
          <div className={styles.toolbar}>
            <button type="button" onClick={() => setKind('text')} aria-pressed={kind === 'text'}>文本</button>
            <button type="button" onClick={() => setKind('link')} aria-pressed={kind === 'link'}>链接</button>
            <button
              type="button"
              disabled={items.length === 0}
              onClick={() => { if (confirmClear()) onChange([]); }}
            >
              清空
            </button>
          </div>
          <div className={styles.composer}>
            {kind === 'text' ? (
              <textarea
                aria-label="收集文本"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="记录一段文本"
              />
            ) : (
              <>
                <input aria-label="链接地址" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" />
                <input aria-label="链接标题" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="显示标题（可选）" />
              </>
            )}
            <button
              type="button"
              onClick={() => append(kind === 'text' ? createTextItem(text, factory) : createLinkItem(url, label, factory))}
            >
              添加
            </button>
          </div>
          {error !== null ? <p className={styles.error} role="alert">{error}</p> : null}
          {persistenceError !== null ? <p className={styles.error} role="alert">{persistenceError}</p> : null}
          {loadWarning !== null ? <p className={styles.warning} role="status">{loadWarning}</p> : null}
          <p className={styles.hint}>拖动条目到画布或编辑器；拖出不会删除条目，也不会复制文件。</p>
          <div
            className={styles.items}
            role="list"
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDrop}
          >
            {items.length === 0 ? <p className={styles.empty}>暂无收集项</p> : null}
            {items.map((item) => (
              <div
                className={styles.item}
                role="listitem"
                key={item.id}
                onPointerDown={(event) => dragHandlers.onStart(item, event)}
                onPointerMove={(event) => dragHandlers.onMove(item, event)}
                onPointerUp={(event) => dragHandlers.onEnd(item, event)}
                onPointerCancel={(event) => dragHandlers.onCancel(item, event)}
              >
                <div className={styles.itemMain}>
                  <p className={styles.itemTitle} title={itemTitle(item)}>{itemTitle(item)}</p>
                  <p className={styles.itemMeta} title={itemDetail(item)}>{itemDetail(item)}</p>
                </div>
                <div className={styles.itemActions}>
                  <button
                    type="button"
                    aria-label={`删除 ${itemTitle(item)}`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => onChange(items.filter((candidate) => candidate.id !== item.id))}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
