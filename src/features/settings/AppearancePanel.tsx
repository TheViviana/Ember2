/* CR-20261121-45 项1：外观设置面板（三选分段：跟随系统/浅色/深色）+ 编辑器行号显隐。 */
import { useState } from 'react';
import { applyThemePreference, readThemePreference, type ThemePreference } from './appearance.ts';
import { readGutterVisible, writeGutterVisible } from '../../core/gutter-preference.ts';
import styles from './appearance-panel.module.css';

const OPTIONS: ReadonlyArray<{ readonly value: ThemePreference; readonly label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

export interface AppearancePanelProps {
  readonly onClose: () => void;
}

export function AppearancePanel({ onClose }: AppearancePanelProps) {
  const [preference, setPreference] = useState<ThemePreference>(() => readThemePreference());
  const [gutterVisible, setGutterVisible] = useState<boolean>(() => readGutterVisible());

  const select = (value: ThemePreference): void => {
    setPreference(value);
    applyThemePreference(value);
  };

  const selectGutter = (visible: boolean): void => {
    setGutterVisible(visible);
    writeGutterVisible(visible);
  };

  return (
    <div className={styles.host}>
      <div className={styles.backdrop} onClick={onClose} />
      <section className={styles.panel} role="dialog" aria-modal="true" aria-label="外观设置">
        <header className={styles.header}>
          <div>
            <h2 className={styles.title}>外观</h2>
            <p className={styles.subtitle}>界面配色的手动偏好</p>
          </div>
          <button type="button" className={styles.closeButton} onClick={onClose} aria-label="关闭外观设置">
            ×
          </button>
        </header>
        <div className={styles.segmented} role="radiogroup" aria-label="主题">
          {OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={preference === option.value}
              className={`${styles.option} ${preference === option.value ? styles.optionActive : ''}`}
              onClick={() => select(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className={styles.hint}>
          「跟随系统」时主题随 macOS 外观自动切换；手动选择立即生效并记住偏好。
        </p>
        <h3 className={styles.groupLabel}>编辑器</h3>
        <div className={styles.segmented} role="radiogroup" aria-label="浮窗行号">
          <button
            type="button"
            role="radio"
            aria-checked={gutterVisible}
            className={`${styles.option} ${gutterVisible ? styles.optionActive : ''}`}
            onClick={() => selectGutter(true)}
          >
            显示行号
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={!gutterVisible}
            className={`${styles.option} ${gutterVisible ? '' : styles.optionActive}`}
            onClick={() => selectGutter(false)}
          >
            隐藏行号
          </button>
        </div>
        <p className={styles.hint}>对所有已打开与后续打开的编辑浮窗立即生效。</p>
      </section>
    </div>
  );
}
