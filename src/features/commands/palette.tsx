/**
 * CR-20261119-13：⌘K 命令面板（palette）。
 *
 * 本组件只引 bus + context + react，**不引 src/app**（gate:layers）。
 * 搜索算法见 §5.3；键盘/IME 交互见 §5.4；a11y 见 §7。
 * §8.5：结果按「文档 / 命令」分组，空输入显示最近文档与常用命令。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import styles from './palette.module.css';
import type {
  Command,
  CommandExecuteResult,
  CommandRegistry,
  CommandExecutorWithClose,
  CommandId,
} from './bus.js';
import type { CommandContextSnapshot } from './context.js';
import type { CommandBindingMap } from './bindings.ts';

/** 面板可搜索的文档条目；由 app 层提供，本层不读取索引。 */
export interface PaletteDocument {
  readonly path: string;
  readonly name: string;
  readonly modifiedMs: number;
  readonly tags: readonly string[];
}

interface PaletteTag {
  readonly name: string;
  readonly count: number;
}

type Visible = {
  readonly cmd: Command;
  readonly enabled: boolean;
  readonly disabledReason?: string;
};

/** 按 §5.3 规则打分：数值越大越靠前 */
function scoreCommand(query: string, cmd: Command): number {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return 0;
  const title = cmd.title.toLowerCase();

  // 精确前缀 → 最高
  if (title.startsWith(q)) return 400 + (cmd.category.length * 10);

  // title 包含
  if (title.includes(q)) return 300 - (title.indexOf(q) * 0.5);

  // keyword 包含
  for (const kw of cmd.keywords) {
    if (kw.toLowerCase().includes(q)) return 200;
  }

  // 中文分词（query 单字符序列，title 全部包含）
  if ([...q].every((c) => title.includes(c))) return 100;

  return 0;
}

/** 文档按名称前缀 > 名称包含 > 路径包含排序。 */
function scoreDocument(query: string, doc: PaletteDocument): number {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return 0;
  if (q.startsWith('#')) {
    const needle = q.replace(/^#+/, '');
    if (needle.length === 0) return 0;
    return doc.tags.some((tag) => {
      const name = tag.toLowerCase();
      return name === needle || name.startsWith(`${needle}/`);
    }) ? 400 : 0;
  }
  const name = doc.name.toLowerCase();
  if (name.startsWith(q)) return 400;
  if (name.includes(q)) return 300 - name.indexOf(q) * 0.5;
  if (doc.path.toLowerCase().includes(q)) return 200;
  if (doc.tags.some((tag) => tag.toLowerCase().includes(q))) return 150;
  return 0;
}

function scoreTag(query: string, tag: PaletteTag): number {
  const q = query.trim().toLowerCase().replace(/^#+/, '');
  if (q.length === 0) return 0;
  const name = tag.name.toLowerCase();
  if (name.startsWith(q)) return 400;
  if (name.includes(q)) return 300 - name.indexOf(q) * 0.5;
  return 0;
}

const MAX_RESULTS = 50;
/** §8.5：每组默认最多 5 条，多出的收进「查看全部」。 */
const GROUP_LIMIT = 5;

interface UseCommandPaletteReturn {
  readonly isOpen: boolean;
  readonly open: () => void;
  readonly close: () => void;
  readonly toggle: () => void;
}

/**
 * palette 可见性 hook + close 回调注册。
 * 外部通过 handle.open/close/toggle 控制；内部维护搜索框焦点。
 */
export function useCommandPalette(
  executor: CommandExecutorWithClose,
): UseCommandPaletteReturn {
  const [isOpen, setIsOpen] = useState(false);

  // 注册 palette.close 到 executor，让执行器在 execute 前同步关闭
  useEffect(() => {
    executor.setPaletteClose(() => setIsOpen(false));
    return () => {
      executor.setPaletteClose(() => {});
    };
  }, [executor]);

  return {
    isOpen,
    open: useCallback(() => setIsOpen(true), []),
    close: useCallback(() => setIsOpen(false), []),
    toggle: useCallback(() => setIsOpen((v) => !v), []),
  };
}

// ─── 组件 ────────────────────────────────────────────────────────

export interface CommandPaletteComponentProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onExecute: (id: CommandId) => Promise<CommandExecuteResult>;
  readonly registry: CommandRegistry;
  readonly snapshot: CommandContextSnapshot;
  readonly bindings: CommandBindingMap;
  /** §8.5：文档结果（按最近修改排序由 app 层提供）。 */
  readonly documents?: readonly PaletteDocument[];
  /** 打开文档（点击或 Enter）。未提供时不渲染文档组。 */
  readonly onOpenDocument?: (path: string) => void;
}

interface RowCommand {
  readonly kind: 'command';
  readonly key: string;
  readonly cmd: Command;
  readonly enabled: boolean;
  readonly disabledReason?: string;
}

interface RowDocument {
  readonly kind: 'document';
  readonly key: string;
  readonly doc: PaletteDocument;
}

interface RowTag {
  readonly kind: 'tag';
  readonly key: string;
  readonly tag: PaletteTag;
}

type PaletteRow = RowCommand | RowDocument | RowTag;

interface PaletteGroup {
  readonly id: 'documents' | 'commands' | 'tags';
  readonly label: string;
  readonly rows: readonly PaletteRow[];
  readonly total: number;
}

/**
 * 渲染 palette overlay。
 * 不包含键盘监听（⌘K capture 由 AppShell 注册，传入 toggle/open/close）；
 * 只处理 palette 内部的 ↑↓ Enter Esc / IME / 遮罩点击 / 焦点陷阱。
 */
export function CommandPaletteComponent(props: CommandPaletteComponentProps): ReactElement | null {
  const { isOpen, onClose, onExecute, registry, snapshot, bindings, documents, onOpenDocument } = props;
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [docsExpanded, setDocsExpanded] = useState(false);
  const [commandsExpanded, setCommandsExpanded] = useState(false);
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const preOpenActiveRef = useRef<Element | null>(null);

  // 每次打开重置
  useEffect(() => {
    if (isOpen) {
      preOpenActiveRef.current = document.activeElement;
      setQuery('');
      setActiveIndex(0);
      setDocsExpanded(false);
      setCommandsExpanded(false);
      setTagsExpanded(false);
      // 自动聚焦搜索框
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [isOpen]);

  // 关闭后焦点归还
  useEffect(() => {
    if (!isOpen && preOpenActiveRef.current instanceof HTMLElement) {
      const prev = preOpenActiveRef.current;
      // 下一帧归还，避免 React 批处理冲突
      requestAnimationFrame(() => prev.focus({ preventScroll: true }));
    }
  }, [isOpen]);

  const docPool = useMemo<readonly PaletteDocument[]>(() => documents ?? [], [documents]);
  const tagPool = useMemo<readonly PaletteTag[]>(() => {
    const counts = new Map<string, number>();
    for (const doc of docPool) {
      for (const tag of doc.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts].map(([name, count]) => ({ name, count }));
  }, [docPool]);

  // 搜索排序 + 分组
  const groups = useMemo<readonly PaletteGroup[]>(() => {
    const q = query.trim();
    const allCommands: Visible[] = registry
      .list(snapshot)
      .map((c) => ({ cmd: c, enabled: c.enabled, disabledReason: c.disabledReason }))
      .filter((v) => q.length === 0 || scoreCommand(query, v.cmd) > 0)
      .sort((a, b) => scoreCommand(query, b.cmd) - scoreCommand(query, a.cmd))
      .slice(0, MAX_RESULTS);

    const matchedDocs =
      q.length === 0
        ? docPool
        : docPool
            .map((doc) => ({ doc, score: scoreDocument(query, doc) }))
            .filter((entry) => entry.score > 0)
            .sort((a, b) => b.score - a.score)
            .map((entry) => entry.doc);

    const matchedTags = q.length === 0 ? [] : tagPool
      .map((tag) => ({ tag, score: scoreTag(query, tag) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.tag.count - a.tag.count)
      .slice(0, MAX_RESULTS)
      .map((entry) => entry.tag);

    const out: PaletteGroup[] = [];
    if (onOpenDocument !== undefined && matchedDocs.length > 0) {
      const shown = docsExpanded ? matchedDocs : matchedDocs.slice(0, GROUP_LIMIT);
      out.push({
        id: 'documents',
        label: q.length === 0 ? '最近文档' : '文档',
        total: matchedDocs.length,
        rows: shown.map((doc) => ({ kind: 'document', key: `doc:${doc.path}`, doc })),
      });
    }
    if (allCommands.length > 0) {
      const shown = commandsExpanded ? allCommands : allCommands.slice(0, GROUP_LIMIT);
      out.push({
        id: 'commands',
        label: q.length === 0 ? '常用命令' : '命令',
        total: allCommands.length,
        rows: shown.map((v) => ({
          kind: 'command',
          key: `cmd:${v.cmd.id}`,
          cmd: v.cmd,
          enabled: v.enabled,
          disabledReason: v.disabledReason,
        })),
      });
    }
    if (onOpenDocument !== undefined && matchedTags.length > 0) {
      const shown = tagsExpanded ? matchedTags : matchedTags.slice(0, GROUP_LIMIT);
      out.push({
        id: 'tags',
        label: '标签',
        total: matchedTags.length,
        rows: shown.map((tag) => ({ kind: 'tag', key: `tag:${tag.name}`, tag })),
      });
    }
    return out;
  }, [registry, snapshot, query, docPool, tagPool, docsExpanded, commandsExpanded, tagsExpanded, onOpenDocument]);

  const flat = useMemo<readonly PaletteRow[]>(
    () => groups.flatMap((group) => group.rows),
    [groups],
  );

  // 输入变化后首条默认选中
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // 活动项超出可见范围时钳制
  useEffect(() => {
    if (activeIndex >= flat.length && flat.length > 0) {
      setActiveIndex(flat.length - 1);
    } else if (flat.length === 0 && activeIndex !== 0) {
      setActiveIndex(0);
    }
  }, [flat.length, activeIndex]);

  // palette 内部键盘
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      // IME composition 期间完全忽略
      if (e.nativeEvent.isComposing) return;

      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          e.stopPropagation();
          onClose();
          break;
        case 'ArrowDown':
          e.preventDefault();
          e.stopPropagation();
          if (flat.length > 0) setActiveIndex((i) => (i + 1) % flat.length);
          break;
        case 'ArrowUp':
          e.preventDefault();
          e.stopPropagation();
          if (flat.length > 0) setActiveIndex((i) => (i - 1 + flat.length) % flat.length);
          break;
        case 'Home':
          e.preventDefault();
          e.stopPropagation();
          if (flat.length > 0) setActiveIndex(0);
          break;
        case 'End':
          e.preventDefault();
          e.stopPropagation();
          if (flat.length > 0) setActiveIndex(flat.length - 1);
          break;
        case 'Enter': {
          e.preventDefault();
          e.stopPropagation();
          const target = flat[activeIndex];
          if (target === undefined) {
            onClose();
            return;
          }
          if (target.kind === 'document') {
            onOpenDocument?.(target.doc.path);
            return;
          }
          if (target.kind === 'tag') {
            setQuery(`#${target.tag.name}`);
            setActiveIndex(0);
            inputRef.current?.focus();
            return;
          }
          void onExecute(target.cmd.id);
          break;
        }
      }
    },
    [onClose, onExecute, onOpenDocument, flat, activeIndex],
  );

  if (!isOpen) return null;

  return (
    <div
      className={styles.backdrop}
      data-command-palette-backdrop=""
      onClick={onClose}
    >
      <div
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <input
          ref={inputRef}
          type="text"
          className={styles.input}
          placeholder="搜索命令、文档或标签..."
          aria-label="搜索命令、文档或标签"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div
          className={styles.list}
          role="listbox"
          aria-label="可用命令、文档与标签"
        >
          {flat.length === 0 ? (
            <div className={styles.empty}>没有匹配的命令、文档或标签</div>
          ) : (
            groups.map((group) => (
              <div key={group.id} className={styles.group} role="group" aria-label={group.label}>
                <div className={styles.groupLabel} aria-hidden="true">{group.label}</div>
                {group.rows.map((row) => {
                  const index = flat.indexOf(row);
                  const active = index === activeIndex;
                  const disabled = row.kind === 'command' && !row.enabled;
                  return (
                    <div
                      key={row.key}
                      className={`${styles.item}${active ? ` ${styles.itemActive}` : ''}${disabled ? ` ${styles.itemDisabled}` : ''}`}
                      role="option"
                      aria-selected={active}
                      aria-disabled={disabled || undefined}
                      title={row.kind === 'command' ? row.disabledReason : row.kind === 'document' ? row.doc.path : `#${row.tag.name}`}
                      aria-activedescendant={active ? `ember-cmd-item-${row.key}` : undefined}
                      id={active ? `ember-cmd-item-${row.key}` : undefined}
                      onClick={() => {
                        if (row.kind === 'document') {
                          onOpenDocument?.(row.doc.path);
                          return;
                        }
                        if (row.kind === 'tag') {
                          setQuery(`#${row.tag.name}`);
                          setActiveIndex(0);
                          inputRef.current?.focus();
                          return;
                        }
                        if (row.enabled) void onExecute(row.cmd.id);
                      }}
                    >
                      <span className={styles.title}>
                        {row.kind === 'command' ? row.cmd.title : row.kind === 'document' ? row.doc.name : `#${row.tag.name}`}
                      </span>
                      {row.kind === 'command' && (bindings[row.cmd.id] ?? []).length > 0 ? (
                        <kbd className={styles.kbd}>
                          {formatKeybinding(bindings[row.cmd.id]![0]!)}
                        </kbd>
                      ) : null}
                      {row.kind === 'document' ? (
                        <span className={styles.itemMeta}>{row.doc.path}</span>
                      ) : null}
                      {row.kind === 'tag' ? (
                        <span className={styles.itemMeta}>{row.tag.count} 篇文档</span>
                      ) : null}
                    </div>
                  );
                })}
                {group.total > group.rows.length ? (
                  <button
                    type="button"
                    className={styles.more}
                    onClick={() => {
                      if (group.id === 'documents') setDocsExpanded(true);
                      else if (group.id === 'commands') setCommandsExpanded(true);
                      else setTagsExpanded(true);
                    }}
                  >
                    查看全部 {group.total} 条
                  </button>
                ) : null}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function formatKeybinding(kb: { readonly key: string; readonly meta?: boolean; readonly ctrl?: boolean; readonly shift?: boolean; readonly alt?: boolean }): string {
  const parts: string[] = [];
  if (kb.meta) parts.push('⌘');
  if (kb.ctrl) parts.push('⌃');
  if (kb.shift) parts.push('⇧');
  if (kb.alt) parts.push('⌥');
  parts.push(kb.key.toUpperCase());
  return parts.join('');
}
