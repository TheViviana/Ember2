/**
 * CR-20261119-08：新建文档输入面板。
 * 一个 input + 目标目录 label + Enter 确认 / Esc 取消 + 错误消息。
 * 定位逻辑复用 doc-submenu-model.positionDocSubmenu（翻转 + 视口夹取）。
 * 成功后自动展开父目录并高亮新建行。
 */
import { useLayoutEffect, useRef, useState, useEffect, type FormEvent } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { positionDocSubmenu, type SubmenuAnchorRect } from '../canvas/doc-submenu-model.ts';
import { useEmberStore } from '../stores/ember-store';
import { useTreeStore } from '../stores/tree-store';
import { validateNewDocPath } from './doc-new.ts';
import { openWindow, getViewport } from '../../windows/use-window-manager.ts';
import { EDITOR_WINDOW_CONTENT } from '../../windows/content-types.ts';
import styles from './DocNewInput.module.css';

interface DocNewInputProps {
  /** 面板锚点（getBoundingClientRect 形状）。 */
  readonly anchor: SubmenuAnchorRect;
  /** 初始目标目录（相对库根，空代表库根）。 */
  readonly targetDir: string;
  /** 关闭回调（成功或取消都触发）。 */
  readonly onClose: () => void;
}

export function DocNewInput({ anchor, targetDir, onClose }: DocNewInputProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [input, setInput] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const createDoc = useEmberStore((state) => state.createDoc);
  const expandAncestors = useTreeStore((state) => state.expandAncestors);
  const setActivePath = useTreeStore((state) => state.setActivePath);

  // 定位：复用 DocSubmenu 的翻转逻辑。
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    const size = { width: panel.offsetWidth, height: panel.offsetHeight };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const pos = positionDocSubmenu(anchor, size, viewport);
    panel.style.left = `${pos.left}px`;
    panel.style.top = `${pos.top}px`;
  }, [anchor]);

  // 挂载时 focus 输入框；外点关闭；Esc 取消。
  useEffect(() => {
    const el = inputRef.current;
    el?.focus();
    el?.select();

    const onPointerDown = (event: PointerEvent): void => {
      const panel = panelRef.current;
      if (panel === null) return;
      if (event.target instanceof Node && panel.contains(event.target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onClose]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (creating) return;

    const v = validateNewDocPath(input, targetDir);
    if (!v.ok) {
      setErrorMsg(v.message);
      return;
    }

    setCreating(true);
    setErrorMsg(null);
    const r = await createDoc(v.rel);
    setCreating(false);

    if (!r.ok) {
      setErrorMsg(r.message);
      return;
    }

    // 成功：展开父目录 → 高亮新建行 → 打开编辑器。索引已在 createDoc 内同步。
    expandAncestors(v.rel);
    setActivePath(v.rel);
    openWindow(v.rel, EDITOR_WINDOW_CONTENT, getViewport());
    onClose();
  }

  // IME 守卫：中文输入法 Enter 选候选词时不触发 submit（避免意外创建空名）。
  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing && event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  const dirLabel = targetDir === '' ? '库根' : targetDir;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="新建文档"
      className={styles.panel}
    >
      <div
        role="heading"
        aria-level={3}
        className={styles.title}
      >
        新建文档（目标：{dirLabel}）
      </div>
      <form onSubmit={(e) => void handleSubmit(e)}>
        <input
          ref={inputRef}
          type="text"
          value={input}
          placeholder="文件名（自动补 .md）"
          disabled={creating}
          className={styles.input}
          onKeyDown={handleKeyDown}
          onChange={(e) => { setInput(e.target.value); setErrorMsg(null); }}
        />
        {errorMsg !== null ? (
          <p role="alert" className={styles.error}>{errorMsg}</p>
        ) : null}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.cancelBtn}
            onClick={onClose}
            disabled={creating}
          >
            取消
          </button>
          <button
            type="submit"
            className={styles.createBtn}
            disabled={creating}
          >
            {creating ? '创建中' : '创建'}
          </button>
        </div>
      </form>
    </div>
  );
}
