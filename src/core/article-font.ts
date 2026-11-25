/**
 * 文章正文字号偏好（设置→外观→编辑器）。
 *
 * - localStorage 记住选择，默认「默认」（沿用设计 token）；
 * - 通过根元素 `--article-font-scale` 生效，编辑区与阅读区共用同一比例；
 * - 使用比例而非绝对 px：正文 14px 与衬线阅读 17px 各自按比例放大，
 *   不会在切换阅读模式后出现字号不连续；
 * - 「默认」移除变量，恢复 CSS 里的 1 倍基准。
 */

export type ArticleFontSize = 'small' | 'default' | 'large' | 'xlarge';

const STORAGE_KEY = 'ember.editor.article-font';
const CSS_VAR = '--article-font-scale';

const SIZE_SCALE: Record<Exclude<ArticleFontSize, 'default'>, string> = {
  small: '0.9',
  large: '1.15',
  xlarge: '1.3',
};

export function readArticleFontSize(): ArticleFontSize {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'small' || stored === 'large' || stored === 'xlarge') return stored;
  } catch {
    /* localStorage 不可用：保持默认 */
  }
  return 'default';
}

export function applyArticleFontSize(size: ArticleFontSize): void {
  const root = document.documentElement;
  if (size === 'default') {
    root.style.removeProperty(CSS_VAR);
    return;
  }
  root.style.setProperty(CSS_VAR, SIZE_SCALE[size]);
}

export function writeArticleFontSize(size: ArticleFontSize): void {
  try {
    localStorage.setItem(STORAGE_KEY, size);
  } catch {
    /* 隐私模式等：仅本次会话生效 */
  }
  applyArticleFontSize(size);
}
