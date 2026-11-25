/**
 * 设置壳「外观」页：主题三选 + 动态背景三档。
 *
 * 不含宿主 / 遮罩 / 标题 / 关闭按钮，外框由 SettingsShell 提供。
 */
import { useState } from 'react';
import { applyThemePreference, readThemePreference, type ThemePreference } from './appearance.ts';
import {
  readAmbientMotionPreference,
  writeAmbientMotionPreference,
  type AmbientMotionPreference,
} from './ambient-motion.ts';
import styles from './appearance-panel.module.css';

const OPTIONS: ReadonlyArray<{ readonly value: ThemePreference; readonly label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

const AMBIENT_OPTIONS: ReadonlyArray<{
  readonly value: AmbientMotionPreference;
  readonly label: string;
}> = [
  { value: 'off', label: '关闭' },
  { value: 'static', label: '静态' },
  { value: 'dynamic', label: '动态' },
];

export function AppearanceSettingsBody() {
  const [preference, setPreference] = useState<ThemePreference>(() => readThemePreference());
  const [ambient, setAmbient] = useState<AmbientMotionPreference>(() =>
    readAmbientMotionPreference(),
  );

  const select = (value: ThemePreference): void => {
    setPreference(value);
    applyThemePreference(value);
  };

  const selectAmbient = (value: AmbientMotionPreference): void => {
    setAmbient(value);
    writeAmbientMotionPreference(value);
  };

  return (
    <div className={styles.body}>
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

      <div className={styles.group}>
        <span className={styles.groupLabel}>动态背景</span>
        <div className={styles.segmented} role="radiogroup" aria-label="动态背景">
          {AMBIENT_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={ambient === option.value}
              className={`${styles.option} ${ambient === option.value ? styles.optionActive : ''}`}
              onClick={() => selectAmbient(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className={styles.hint}>
          「动态」会跟随画布上选中的图片节点缓慢换色；关闭后仍保留底色、点阵、暗角与颗粒。
          系统开启「减少动态效果」时自动按静态显示。
        </p>
      </div>
    </div>
  );
}

