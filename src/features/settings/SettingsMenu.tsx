/**
 * 顶栏设置下拉菜单（CR-20261120-35 / CR-36）。
 *
 * - 锚定顶栏设置按钮：面板左边缘与按钮对齐、上边缘贴在按钮下方，
 *   按钮与内容是一体的，不再出现"按钮在左、面板在右"的分裂；
 * - 单列菜单；分组标题可折叠，标题下直接是功能入口；
 * - 点击菜单外（且不在设置按钮上）自动收起；Esc / 再次点触发器也关闭；
 * - 不渲染全屏遮罩，避免截获画布与浮窗的指针事件。
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type RefObject,
} from 'react';
import {
  initialCollapsedSections,
  toggleCollapsedSection,
  type SettingsSection,
  type SettingsSectionId,
} from './settings-menu-model.ts';
import styles from './settings-menu.module.css';

export type { SettingsEntry, SettingsSection } from './settings-menu-model.ts';

/** 面板宽度上限，与 CSS `max-width` 保持一致，用于贴边收纳。 */
const PANEL_MAX_WIDTH = 360;
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 6;

interface PanelPosition {
  readonly left: number;
  readonly top: number;
  readonly maxHeight: number;
}

export interface SettingsMenuProps {
  readonly open: boolean;
  readonly sections: readonly SettingsSection[];
  readonly onSelect: (id: string) => void;
  readonly onClose: () => void;
  /** 设置按钮：面板以它为准定位，保证按钮与内容连成一体。 */
  readonly anchorRef?: RefObject<HTMLElement | null>;
}

/** CR-20261121-58：设置条目 12px 细线小图标（按 id 映射，缺失不渲染）。 */
const ENTRY_ICONS: Readonly<Record<string, ReactElement>> = {
  appearance: (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5v11" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11" fill="currentColor" stroke="none" />
    </svg>
  ),
  shortcuts: (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <rect x="1.5" y="4" width="13" height="8" rx="1.5" />
      <path d="M4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M5 9.5h6" strokeLinecap="round" />
    </svg>
  ),
  updater: (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" strokeLinecap="round" />
      <path d="M13.7 1.8v2.6h-2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  tools: (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <circle cx="8" cy="8.5" r="5" />
      <path d="M8 5.5v3l2 1.5" strokeLinecap="round" />
      <path d="M5.5 1.5h5" strokeLinecap="round" />
    </svg>
  ),
  ai: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M10.5 3.5A2.3 2.3 0 0 0 8.2 5.6 2.3 2.3 0 0 0 6.3 8.7a2.3 2.3 0 0 0 .5 4.2A2.3 2.3 0 0 0 9 17h1.5v-13.5Z" />
      <path d="M13.5 3.5A2.3 2.3 0 0 1 15.8 5.6 2.3 2.3 0 0 1 17.7 8.7a2.3 2.3 0 0 1-.5 4.2A2.3 2.3 0 0 1 15 17h-1.5v-13.5Z" />
      <path d="M10.5 17v1.5a1.5 1.5 0 0 0 3 0V17" />
    </svg>
  ),
  translate: (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <path d="M2 3.5h6M5 3.5V2M7 3.5c-.6 2.6-2.2 4.6-4.5 5.8M3.2 5.6C4 7.5 5.6 9 7.5 9.8" strokeLinecap="round" />
      <path d="M9 13.5 11.5 7l2.5 6.5M10 11.5h3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  library: (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2l1.6 2H13a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5V3.5Z" />
    </svg>
  ),
};

export function SettingsMenu({
  open,
  sections,
  onSelect,
  onClose,
  anchorRef,
}: SettingsMenuProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const [collapsed, setCollapsed] = useState<readonly SettingsSectionId[]>(() =>
    initialCollapsedSections(sections),
  );
  const [position, setPosition] = useState<PanelPosition | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const measure = (): void => {
      const rect = anchorRef?.current?.getBoundingClientRect() ?? null;
      const top = rect === null ? 0 : rect.bottom + ANCHOR_GAP;
      const rawLeft = rect === null ? VIEWPORT_MARGIN : rect.left;
      const left = Math.max(
        VIEWPORT_MARGIN,
        Math.min(rawLeft, window.innerWidth - PANEL_MAX_WIDTH - VIEWPORT_MARGIN),
      );
      setPosition({
        left,
        top,
        maxHeight: Math.max(200, window.innerHeight - top - VIEWPORT_MARGIN),
      });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [open, onClose]);

  // CR-20261122-67 §4：打开期间监听 pointerdown（捕获阶段），点击落在面板与设置按钮之外则收起。
  // 用 capture 而非 click：避免子组件 stopPropagation 吞掉事件，且在画布/浮窗接管前先判定。
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef?.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [open, onClose, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => panelRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  if (!open) return null;

  const style: CSSProperties = position === null
    ? { left: VIEWPORT_MARGIN }
    : { left: position.left, top: position.top, maxHeight: position.maxHeight };

  return (
    <div className={styles.host}>
      <section
        ref={panelRef}
        className={styles.panel}
        style={style}
        role="dialog"
        aria-label="设置菜单"
        tabIndex={-1}
      >
        <div className={styles.sections}>
          {sections.map((section) => {
            const isCollapsed = collapsed.includes(section.id);
            return (
              <section key={section.id} className={styles.section} aria-label={section.label}>
                <button
                  type="button"
                  className={styles.sectionHeader}
                  aria-expanded={!isCollapsed}
                  onClick={() => setCollapsed((prev) => toggleCollapsedSection(prev, section.id))}
                >
                  <span className={styles.chevron} aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
                  <span className={styles.sectionLabel}>{section.label}</span>
                </button>
                {isCollapsed ? null : (
                  <div className={styles.entries}>
                    {section.entries.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        className={styles.entry}
                        disabled={entry.disabled}
                        onClick={() => onSelect(entry.id)}
                      >
                        {/* CR-20261121-58：条目 12px 细线小图标（左），与文字 8px 间距 */}
                        {ENTRY_ICONS[entry.id] ? (
                          <span className={styles.entryIcon} aria-hidden="true">
                            {ENTRY_ICONS[entry.id]}
                          </span>
                        ) : null}
                        <span className={styles.entryText}>
                          <span className={styles.entryTitle}>{entry.title}</span>
                          <span className={styles.entryDescription}>{entry.description}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </section>
    </div>
  );
}
