/**
 * 浮窗内查找替换：自有中文面板，匹配与替换仍走 CodeMirror 的 search 命令，
 * 保持正则、整词、大小写与撤销栈口径一致；⌘F 查找、⌘⌥F 替换。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import { Prec, StateEffect } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import type { Command } from '@codemirror/view';
import {
  findNext,
  findPrevious,
  replaceAll,
  replaceNext,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search';
import { summarizeSearch } from './search-summary.ts';
import type { EditorNoticeTone } from './drop.ts';
import styles from './EditorSearchPanel.module.css';

export interface EditorSearchPanelProps {
  readonly viewRef: RefObject<EditorView | null>;
  readonly onNotice?: (message: string, tone: EditorNoticeTone) => void;
  /** 阅读模式隐藏 CodeMirror，禁止打开面板但仍保留已装配的快捷键。 */
  readonly enabled?: boolean;
}

function buildQuery(
  search: string,
  replacement: string,
  caseSensitive: boolean,
  regexp: boolean,
  wholeWord: boolean,
): SearchQuery | null {
  try {
    return new SearchQuery({
      search,
      replace: replacement,
      caseSensitive,
      regexp,
      wholeWord,
    });
  } catch {
    return null;
  }
}

export function EditorSearchPanel({
  viewRef,
  onNotice,
  enabled = true,
}: EditorSearchPanelProps) {
  const [open, setOpen] = useState(false);
  const [replaceShown, setReplaceShown] = useState(false);
  const [search, setSearch] = useState('');
  const [replacement, setReplacement] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regexp, setRegexp] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [, bumpVersion] = useState(0);
  const openRef = useRef(false);
  const enabledRef = useRef(enabled);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);

  openRef.current = open;
  enabledRef.current = enabled;

  const close = (): void => {
    setOpen(false);
    const view = viewRef.current;
    if (view === null) return;
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) });
    view.focus();
  };

  // 视图就绪后装一次快捷键与文档变更监听；面板关闭时仍保留，避免重复 appendConfig。
  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    const show = (withReplace: boolean): void => {
      if (!enabledRef.current) return;
      const view = viewRef.current;
      const selection = view?.state.selection.main;
      const selected =
        view !== null && selection !== undefined && !selection.empty
          ? view.state.sliceDoc(selection.from, selection.to)
          : '';
      if (selected !== '' && selected.length <= 200 && !selected.includes('\n')) {
        setSearch(selected);
      }
      setReplaceShown(withReplace);
      setOpen(true);
    };
    const install = (): void => {
      if (disposed) return;
      const view = viewRef.current;
      if (view === null) {
        timer = window.setTimeout(install, 50);
        return;
      }
      view.dispatch({
        effects: StateEffect.appendConfig.of(
          Prec.highest(
            keymap.of([
              { key: 'Mod-f', run: () => (show(false), true) },
              { key: 'Mod-Alt-f', run: () => (show(true), true) },
              {
                key: 'Escape',
                run: () => {
                  if (!openRef.current) return false;
                  setOpen(false);
                  view.dispatch({
                    effects: setSearchQuery.of(new SearchQuery({ search: '' })),
                  });
                  view.focus();
                  return true;
                },
              },
            ]),
          ),
        ),
      });
      view.dispatch({
        effects: StateEffect.appendConfig.of(
          EditorView.updateListener.of((update) => {
            if (update.docChanged) bumpVersion((value) => value + 1);
          }),
        ),
      });
    };
    install();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [viewRef]);

  const query = useMemo(
    () => buildQuery(search, replacement, caseSensitive, regexp, wholeWord),
    [caseSensitive, regexp, replacement, search, wholeWord],
  );

  // 查询变化同步到编辑器状态，驱动命中高亮。
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    if (!open) {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) });
      return;
    }
    if (query === null) return;
    view.dispatch({ effects: setSearchQuery.of(query) });
  }, [open, query, viewRef]);

  useEffect(() => {
    if (!open) return;
    const input = replaceShown ? replaceInputRef.current : findInputRef.current;
    input?.focus();
    input?.select();
  }, [open, replaceShown]);

  // 切到阅读模式时收起面板并清空命中高亮，但保留快捷键装配。
  useEffect(() => {
    if (enabled) return;
    setOpen(false);
    const view = viewRef.current;
    view?.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) });
  }, [enabled, viewRef]);

  // 正文变化由 bumpVersion 触发重渲染；摘要直接读当前 state，避免缓存陈旧。
  const view = viewRef.current;
  const summary =
    !open || view === null || query === null
      ? { total: 0, index: 0, valid: query !== null }
      : summarizeSearch(view.state, query);

  const run = (command: Command, emptyMessage: string): void => {
    const view = viewRef.current;
    if (view === null || query === null) return;
    view.dispatch({ effects: setSearchQuery.of(query) });
    if (!command(view)) onNotice?.(emptyMessage, 'info');
    bumpVersion((value) => value + 1);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLFormElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      findInputRef.current?.focus();
      findInputRef.current?.select();
    }
  };

  if (!open) return null;

  return (
    <form
      className={styles.panel}
      role="search"
      aria-label="查找替换"
      onSubmit={(event) => {
        event.preventDefault();
        run(findNext, '未找到匹配');
      }}
      onKeyDown={handleKeyDown}
    >
      <div className={styles.row}>
        <input
          ref={findInputRef}
          className={styles.input}
          value={search}
          placeholder="查找"
          aria-label="查找内容"
          spellCheck={false}
          onChange={(event) => setSearch(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.shiftKey) {
              event.preventDefault();
              run(findPrevious, '未找到匹配');
            }
          }}
        />
        <span className={styles.count} aria-live="polite">
          {query === null || !summary.valid
            ? '正则有误'
            : summary.total === 0
              ? '无匹配'
              : `${summary.index === 0 ? '–' : summary.index} / ${summary.total}`}
        </span>
        <button
          type="button"
          className={styles.iconButton}
          title="上一个（⇧Enter）"
          aria-label="上一个匹配"
          onClick={() => run(findPrevious, '未找到匹配')}
        >
          ↑
        </button>
        <button
          type="button"
          className={styles.iconButton}
          title="下一个（Enter）"
          aria-label="下一个匹配"
          onClick={() => run(findNext, '未找到匹配')}
        >
          ↓
        </button>
        <button
          type="button"
          className={styles.textButton}
          aria-pressed={replaceShown}
          onClick={() => setReplaceShown((value) => !value)}
        >
          替换
        </button>
        <button
          type="button"
          className={styles.iconButton}
          title="关闭（Esc）"
          aria-label="关闭查找"
          onClick={close}
        >
          ×
        </button>
      </div>
      {replaceShown ? (
        <div className={styles.row}>
          <input
            ref={replaceInputRef}
            className={styles.input}
            value={replacement}
            placeholder="替换为"
            aria-label="替换内容"
            spellCheck={false}
            onChange={(event) => setReplacement(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              run(
                event.metaKey || event.ctrlKey ? replaceAll : replaceNext,
                '未找到可替换的匹配',
              );
            }}
          />
          <button
            type="button"
            className={styles.textButton}
            onClick={() => run(replaceNext, '未找到可替换的匹配')}
          >
            替换
          </button>
          <button
            type="button"
            className={styles.textButton}
            onClick={() => run(replaceAll, '未找到可替换的匹配')}
          >
            全部替换
          </button>
        </div>
      ) : null}
      <div className={styles.options}>
        <label className={styles.option}>
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(event) => setCaseSensitive(event.currentTarget.checked)}
          />
          区分大小写
        </label>
        <label className={styles.option}>
          <input
            type="checkbox"
            checked={regexp}
            onChange={(event) => setRegexp(event.currentTarget.checked)}
          />
          正则
        </label>
        <label className={styles.option}>
          <input
            type="checkbox"
            checked={wholeWord}
            onChange={(event) => setWholeWord(event.currentTarget.checked)}
          />
          整词
        </label>
      </div>
    </form>
  );
}

