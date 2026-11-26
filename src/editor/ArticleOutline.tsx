/**
 * 文章点阵大纲（2026-11-23 二次修订 / 第三次调整）。
 *
 * 形态按用户截图：文章浮窗右侧一条点阵，容器高度固定为浮窗内容区的 1/3。
 * - 默认隐藏；指针进入右侧窄热区才淡入，离开即淡出；
 * - 每个点对应一个标题；标题多时点阵在 1/3 容器内上下滚动，不再压成一团；
 * - 越靠上越淡、越靠下越清晰；当前章节为空心圆环；
 * - 悬停/聚焦某个点，左侧浮出「二级标题 / 设计语言」式标签；
 * - 悬停标签放在滚动容器外，避免被滚动条裁切；
 * - 点击跳转，滚动时点阵自动把当前章节滚到可见范围。
 *
 * 条目来自 `article-outline.ts`（编辑/阅读共用源文本解析）；滚动高亮
 * 阅读态读渲染后的标题节点，编辑态用 CodeMirror 文档坐标。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, RefObject, WheelEvent as ReactWheelEvent } from 'react';
import type { ArticleOutlineItem } from './article-outline.ts';
import styles from './ArticleOutline.module.css';

/** 大纲只关心源码或阅读内容；专注开关不影响定位方式。 */
export type OutlineSurface = 'edit' | 'read';

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
const PREVIEW_SELECTOR = '[data-markdown-preview]';
const SCROLLER_SELECTOR = '.cm-scroller';
/** 阅读线：标题顶部越过滚动容器顶部 32px 即视为当前章节。 */
const READING_LINE_OFFSET = 32;
const LEVEL_LABELS = ['一级标题', '二级标题', '三级标题', '四级标题', '五级标题', '六级标题'] as const;

export interface ArticleOutlineProps {
  readonly items: readonly ArticleOutlineItem[];
  readonly mode: OutlineSurface;
  /** 编辑器 body 容器（`[data-markdown-preview]` / `.cm-scroller` 的祖先）。 */
  readonly hostRef: RefObject<HTMLElement | null>;
  /** 编辑模式跳转：定位到 1 基源码行。 */
  readonly onJumpToLine?: (line: number) => void;
  /** 编辑模式：源码行 → 屏幕 y（CodeMirror 文档坐标）。 */
  readonly getLineTop?: (line: number) => number | null;
}

function liveHeadings(host: HTMLElement): readonly HTMLElement[] {
  const preview = host.querySelector<HTMLElement>(PREVIEW_SELECTOR);
  if (preview === null) return [];
  // 源解析只认顶层 ATX/setext 标题；引用/列表内的标题不参与大纲，这里保持同一口径，
  // 避免 DOM 标题数量比源条目多导致点击跳转错位。
  return Array.from(preview.querySelectorAll<HTMLElement>(HEADING_SELECTOR)).filter(
    (heading) =>
      (heading.textContent ?? '').trim() !== '' &&
      heading.closest('blockquote, li, table') === null,
  );
}

function scrollElementFor(host: HTMLElement, mode: OutlineSurface): HTMLElement | null {
  return mode === 'read'
    ? host.querySelector<HTMLElement>(PREVIEW_SELECTOR)
    : host.querySelector<HTMLElement>(SCROLLER_SELECTOR);
}

function levelLabel(depth: number): string {
  return LEVEL_LABELS[Math.min(Math.max(depth, 1), 6) - 1] ?? '标题';
}

export function ArticleOutline({
  items,
  mode,
  hostRef,
  onJumpToLine,
  getLineTop,
}: ArticleOutlineProps) {
  const [visible, setVisible] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [tipTop, setTipTop] = useState(0);
  const zoneRef = useRef<HTMLDivElement | null>(null);
  const dotListRef = useRef<HTMLDivElement | null>(null);
  const dotRefs = useRef(new Map<string, HTMLButtonElement>());

  const active = items.length > 0;

  // 滚动高亮：最后一个越过阅读线的标题即当前章节。
  useEffect(() => {
    if (!active) {
      setActiveId(null);
      setVisible(false);
      setHoveredId(null);
      return;
    }
    const host = hostRef.current;
    if (host === null) return;

    let disposed = false;
    let frame = 0;
    let bound: HTMLElement | null = null;

    const schedule = (): void => {
      if (disposed || frame !== 0) return;
      frame = window.requestAnimationFrame(update);
    };

    const ensureScrollBinding = (): HTMLElement | null => {
      const next = scrollElementFor(host, mode);
      if (next === bound) return bound;
      bound?.removeEventListener('scroll', schedule);
      bound = next;
      bound?.addEventListener('scroll', schedule, { passive: true });
      return bound;
    };

    const update = (): void => {
      frame = 0;
      if (disposed) return;
      const scroll = ensureScrollBinding();
      const anchorTop =
        scroll === null ? 0 : scroll.getBoundingClientRect().top + READING_LINE_OFFSET;
      let next: string | null = null;
      if (mode === 'read') {
        const headings = liveHeadings(host);
        headings.forEach((heading, index) => {
          const item = items[index];
          if (item !== undefined && heading.getBoundingClientRect().top <= anchorTop) {
            next = item.id;
          }
        });
      } else {
        for (const item of items) {
          const top = getLineTop?.(item.line) ?? null;
          if (top !== null && top <= anchorTop) next = item.id;
        }
      }
      setActiveId((previous) => (previous === next ? previous : next));
    };

    schedule();
    // 阅读预览按需懒加载：内容插入后由 MutationObserver 触发一次重算。
    const observer = new MutationObserver(schedule);
    observer.observe(host, { childList: true, subtree: true, characterData: true });
    const retry = window.setTimeout(schedule, 160);
    window.addEventListener('resize', schedule);

    return () => {
      disposed = true;
      observer.disconnect();
      window.clearTimeout(retry);
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      bound?.removeEventListener('scroll', schedule);
      bound = null;
    };
  }, [active, hostRef, items, mode, getLineTop]);

  // 标题多时点阵在 1/3 容器内滚动：当前章节变化后把它滚到可见范围。
  useEffect(() => {
    if (activeId === null) return;
    const list = dotListRef.current;
    const dot = dotRefs.current.get(activeId);
    if (list === null || dot === undefined) return;
    const top = dot.offsetTop;
    const bottom = top + dot.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
  }, [activeId]);

  const jump = useCallback(
    (item: ArticleOutlineItem): void => {
      setActiveId(item.id);
      if (mode !== 'read') {
        onJumpToLine?.(item.line);
        return;
      }
      const host = hostRef.current;
      if (host === null) return;
      const index = items.findIndex((entry) => entry.id === item.id);
      if (index < 0) return;
      liveHeadings(host)[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    [hostRef, items, mode, onJumpToLine],
  );

  // 点阵热区只有 16px 宽，指针停在上面会挡住原生滚轮；手动向前滚动容器。
  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    const host = hostRef.current;
    if (host === null) return;
    const scroll = scrollElementFor(host, mode);
    if (scroll === null) return;
    scroll.scrollTop += event.deltaY;
  };

  // 点阵自己可滚动时，滚轮只滚点阵，不滚正文。
  const handleDotListWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    const list = event.currentTarget;
    if (list.scrollHeight <= list.clientHeight) return;
    event.stopPropagation();
  };

  const showTip = (id: string, target: HTMLElement): void => {
    const zone = zoneRef.current;
    if (zone === null) return;
    const zoneRect = zone.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    setHoveredId(id);
    setTipTop(targetRect.top - zoneRect.top + targetRect.height / 2);
  };

  if (!active) return null;

  const hoveredItem =
    hoveredId === null ? null : (items.find((item) => item.id === hoveredId) ?? null);

  return (
    <div
      ref={zoneRef}
      className={styles.zone}
      onPointerEnter={() => setVisible(true)}
      onPointerLeave={() => {
        setVisible(false);
        setHoveredId(null);
      }}
      onWheel={handleWheel}
    >
      <nav className={styles.rail} data-visible={visible ? 'true' : 'false'} aria-label="文章大纲">
        <div
          ref={dotListRef}
          className={styles.dotList}
          onScroll={() => setHoveredId(null)}
          onWheel={handleDotListWheel}
        >
          {items.map((item, index) => {
            const clarity =
              items.length <= 1 ? 1 : 0.3 + 0.7 * (index / (items.length - 1));
            const activeDot = activeId === item.id;
            const hovered = hoveredId === item.id;
            const level = levelLabel(item.depth);
            const coreStyle = { '--dot-clarity': String(clarity) } as CSSProperties;
            return (
              <button
                key={item.id}
                type="button"
                ref={(element) => {
                  if (element === null) dotRefs.current.delete(item.id);
                  else dotRefs.current.set(item.id, element);
                }}
                className={styles.dot}
                data-active={activeDot ? 'true' : 'false'}
                data-hovered={hovered ? 'true' : 'false'}
                aria-label={`${level}：${item.text}`}
                aria-current={activeDot ? 'location' : undefined}
                onPointerEnter={(event) => showTip(item.id, event.currentTarget)}
                onPointerLeave={() =>
                  setHoveredId((previous) => (previous === item.id ? null : previous))
                }
                onFocus={(event) => showTip(item.id, event.currentTarget)}
                onBlur={() =>
                  setHoveredId((previous) => (previous === item.id ? null : previous))
                }
                onClick={() => jump(item)}
              >
                <span className={styles.dotCore} style={coreStyle} />
              </button>
            );
          })}
        </div>
      </nav>
      {hoveredItem !== null ? (
        <span className={styles.tip} style={{ top: `${tipTop}px` }} aria-hidden="true">
          <span className={styles.tipLevel}>{levelLabel(hoveredItem.depth)}</span>
          <span className={styles.tipText}>{hoveredItem.text}</span>
        </span>
      ) : null}
    </div>
  );
}
