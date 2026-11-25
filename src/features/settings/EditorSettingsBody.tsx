/**
 * 设置壳「编辑器」页：编辑浮窗行号与文章正文字号。
 *
 * 从原 AppearancePanel 拆出；外框由 SettingsShell 提供。
 */
import { useState } from 'react';
import { readGutterVisible, writeGutterVisible } from '../../core/gutter-preference.ts';
import {
  readArticleFontSize,
  writeArticleFontSize,
  type ArticleFontSize,
} from '../../core/article-font.ts';
import styles from './editor-settings.module.css';

const FONT_OPTIONS: ReadonlyArray<{ readonly value: ArticleFontSize; readonly label: string }> = [
  { value: 'small', label: '较小' },
  { value: 'default', label: '默认' },
  { value: 'large', label: '较大' },
  { value: 'xlarge', label: '特大' },
];

export function EditorSettingsBody() {
  const [gutterVisible, setGutterVisible] = useState<boolean>(() => readGutterVisible());
  const [articleFont, setArticleFont] = useState<ArticleFontSize>(() => readArticleFontSize());

  const selectGutter = (visible: boolean): void => {
    setGutterVisible(visible);
    writeGutterVisible(visible);
  };

  const selectArticleFont = (value: ArticleFontSize): void => {
    setArticleFont(value);
    writeArticleFontSize(value);
  };

  return (
    <div className={styles.body}>
      <h3 className={styles.groupLabel}>浮窗行号</h3>
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

      <h3 className={styles.groupLabel}>正文字号</h3>
      <div className={styles.segmented} role="radiogroup" aria-label="文章正文字号">
        {FONT_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={articleFont === option.value}
            className={`${styles.option} ${articleFont === option.value ? styles.optionActive : ''}`}
            onClick={() => selectArticleFont(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className={styles.hint}>同时作用于编辑模式与阅读模式的文章正文。</p>
    </div>
  );
}
