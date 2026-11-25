/**
 * CR-20261119-13：⌘K 命令面板（palette）。
 *
 * 本组件只引 bus + context + react，**不引 src/app**（gate:layers）。
 * 搜索算法见 §5.3；键盘/IME 交互见 §5.4；a11y 见 §7。
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

const MAX_RESULTS = 50;

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
}

/**
 * 渲染 palette overlay。
 * 不包含键盘监听（⌘K capture 由 AppShell 注册，传入 toggle/open/close）；
 * 只处理 palette 内部的 ↑↓ Enter Esc / IME / 遮罩点击 / 焦点陷阱。
 */
export function CommandPaletteComponent(props: CommandPaletteComponentProps): ReactElement | null {
  const { isOpen, onClose, onExecute, registry, snapshot, bindings } = props;
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const preOpenActiveRef = useRef<Element | null>(null);

  // 每次打开重置
  useEffect(() => {
    if (isOpen) {
      preOpenActiveRef.current = document.activeElement;
      setQuery('');
      setActiveIndex(0);
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

  // 搜索排序
  const visible = useMemo<readonly Visible[]>(() => {
    const all = registry.list(snapshot);
    const scored = all
      .map((c) => ({ cmd: c, enabled: c.enabled, disabledReason: c.disabledReason, score: scoreCommand(query, c) }))
      .filter((v) => v.score > 0 || query.trim().length === 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS).map(({ cmd, enabled, disabledReason }) => ({ cmd, enabled, disabledReason }));
  }, [registry, snapshot, query]);

  // 活动项超出可见范围时钳制
  useEffect(() => {
    if (activeIndex >= visible.length && visible.length > 0) {
      setActiveIndex(visible.length - 1);
    } else if (visible.length === 0 && activeIndex !== 0) {
      setActiveIndex(0);
    }
  }, [visible.length, activeIndex]);

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
          if (visible.length > 0) setActiveIndex((i) => (i + 1) % visible.length);
          break;
        case 'ArrowUp':
          e.preventDefault();
          e.stopPropagation();
          if (visible.length > 0) setActiveIndex((i) => (i - 1 + visible.length) % visible.length);
          break;
        case 'Home':
          e.preventDefault();
          e.stopPropagation();
          if (visible.length > 0) setActiveIndex(0);
          break;
        case 'End':
          e.preventDefault();
          e.stopPropagation();
          if (visible.length > 0) setActiveIndex(visible.length - 1);
          break;
        case 'Enter': {
          e.preventDefault();
          e.stopPropagation();
          if (visible.length === 0) {
            onClose();
            return;
          }
          const target = visible[activeIndex];
          if (!target) {
            onClose();
            return;
          }
          void onExecute(target.cmd.id);
          break;
        }
      }
    },
    [onClose, onExecute, visible, activeIndex],
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
          placeholder="搜索命令..."
          aria-label="搜索命令"
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
          aria-label="可用命令"
        >
          {visible.length === 0 ? (
            <div className={styles.empty}>未找到命令</div>
          ) : (
            visible.map((v, idx) => (
              <div
                key={v.cmd.id}
                className={`${styles.item}${idx === activeIndex ? ` ${styles.itemActive}` : ''}${!v.enabled ? ` ${styles.itemDisabled}` : ''}`}
                role="option"
                aria-selected={idx === activeIndex}
                aria-disabled={!v.enabled || undefined}
                aria-activedescendant={
                  idx === activeIndex ? `ember-cmd-item-${v.cmd.id}` : undefined
                }
                id={idx === activeIndex ? `ember-cmd-item-${v.cmd.id}` : undefined}
                onClick={() => {
                  if (v.enabled) void onExecute(v.cmd.id);
                }}
              >
                <span className={styles.title}>{v.cmd.title}</span>
                {(bindings[v.cmd.id] ?? []).length > 0 ? (
                  <kbd className={styles.kbd}>
                    {formatKeybinding(bindings[v.cmd.id]![0]!)}
                  </kbd>
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
