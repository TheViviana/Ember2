/**
 * 设置壳：右侧栏（2026-11-25 由居中浮窗改为贴右全高侧栏）。
 *
 * 纯展示组件：首页是分区设置清单（标签 + 说明 + 箭头），点入后在栏内切到详情页。
 * 入口、页面与动作由 SettingsShellHost 决定；本组件只负责开合、焦点与关闭。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { findSettingsNavEntry, type SettingsNavSection } from './settings-nav.ts';
import { filterSettingsSections, findRecentEntries } from './settings-search.ts';
import { loadRecentSettings, recordRecentSetting } from './settings-recent.ts';
import styles from './SettingsShell.module.css';

/** 隐私模式下 localStorage 可能抛错；失败时最近列表退化为空。 */
function settingsStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** 首页（设置清单）的保留 id；不是登记表条目。 */
export const SETTINGS_HOME_ID = 'home';

export interface SettingsShellProps {
  readonly open: boolean;
  readonly sections: readonly SettingsNavSection[];
  readonly activeId: string;
  readonly onSelect: (id: string) => void;
  readonly onClose: () => void;
  /** 首页每行右侧的当前值摘要（主题、字号、模型、目标语言、库名）。 */
  readonly badges?: Readonly<Record<string, string>>;
  readonly children: ReactNode;
}

export function SettingsShell({
  open,
  sections,
  activeId,
  onSelect,
  onClose,
  badges,
  children,
}: SettingsShellProps) {
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const active = findSettingsNavEntry(sections, activeId);
  const isHome = activeId === SETTINGS_HOME_ID || active === null;
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<readonly string[]>(() => {
    const storage = settingsStorage();
    return storage === null ? [] : loadRecentSettings(storage);
  });
  const filteredSections = useMemo(
    () => filterSettingsSections(sections, query),
    [query, sections],
  );
  const recentEntries = useMemo(
    () => (query.trim() === '' ? findRecentEntries(sections, recent) : []),
    [query, recent, sections],
  );

  const handleEntry = (id: string): void => {
    const entry = findSettingsNavEntry(sections, id);
    if (entry === null || entry.disabled === true) return;
    if (entry.page !== undefined) {
      const storage = settingsStorage();
      if (storage !== null) setRecent(recordRecentSetting(storage, id));
    }
    setQuery('');
    onSelect(id);
  };

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => activeRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, activeId]);

  // 打开壳时重读最近列表（可能在别处清理过）；进入详情页时收起搜索。
  useEffect(() => {
    if (!open) return;
    const storage = settingsStorage();
    if (storage !== null) setRecent(loadRecentSettings(storage));
  }, [open]);

  useEffect(() => {
    if (!isHome) setQuery('');
  }, [isHome]);

  useEffect(() => {
    if (!open) return;
    // 冒泡阶段监听：快捷键录制等子页在 window 捕获阶段 stopPropagation + preventDefault 后，
    // 事件不会到达这里，录制态 Esc 只取消录制、不关闭设置壳。
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className={styles.host} role="presentation">
      <div
        className={styles.backdrop}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      />
      <section className={styles.window} role="dialog" aria-modal="true" aria-label="设置">
        <header className={styles.header}>
          <div className={styles.heading}>
            {isHome ? null : (
              <button
                type="button"
                className={styles.backButton}
                aria-label="返回设置列表"
                onClick={() => onSelect(SETTINGS_HOME_ID)}
              >
                ←
              </button>
            )}
            <div className={styles.headingText}>
              <h2 className={styles.title}>{isHome ? '设置' : (active?.title ?? '设置')}</h2>
              <p className={styles.subtitle}>
                {isHome ? '修改即保存，下次启动自动恢复' : (active?.description ?? '')}
              </p>
            </div>
          </div>
          <button type="button" className={styles.closeButton} onClick={onClose} aria-label="关闭设置">
            ×
          </button>
        </header>
        {isHome ? (
          <nav className={styles.list} aria-label="设置分区">
            <div className={styles.searchRow}>
              <input
                className={styles.searchInput}
                type="search"
                value={query}
                placeholder="搜索设置项"
                aria-label="搜索设置项"
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </div>
            {recentEntries.length > 0 ? (
              <div className={styles.recent} aria-label="最近使用">
                <span className={styles.recentLabel}>最近</span>
                <div className={styles.recentChips}>
                  {recentEntries.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      className={styles.recentChip}
                      onClick={() => handleEntry(entry.id)}
                    >
                      {entry.title}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {filteredSections.length === 0 ? (
              <div className={styles.searchEmpty}>
                <p>没有匹配的设置项</p>
                <button
                  type="button"
                  className={styles.searchClear}
                  onClick={() => setQuery('')}
                >
                  清除搜索
                </button>
              </div>
            ) : null}
            {filteredSections.map((section) => (
              <section className={styles.group} key={section.id}>
                <h3 className={styles.groupLabel}>{section.label}</h3>
                {section.entries.map((entry) => (
                  <button
                    key={entry.id}
                    ref={entry.id === activeId ? activeRef : undefined}
                    type="button"
                    className={styles.row}
                    disabled={entry.disabled}
                    onClick={() => handleEntry(entry.id)}
                  >
                    <span className={styles.rowBody}>
                      <span className={styles.rowTitle}>{entry.title}</span>
                      <span className={styles.rowDescription}>{entry.description}</span>
                    </span>
                    <span className={styles.rowMeta}>
                      {badges?.[entry.id] === undefined ? null : (
                        <span className={styles.rowBadge}>{badges[entry.id]}</span>
                      )}
                      <span className={styles.rowChevron} aria-hidden="true">
                        ›
                      </span>
                    </span>
                  </button>
                ))}
              </section>
            ))}
          </nav>
        ) : (
          <div className={styles.contentBody}>{children}</div>
        )}
      </section>
    </div>
  );
}
