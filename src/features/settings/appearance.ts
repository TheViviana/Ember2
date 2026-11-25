/* CR-20261121-45 项1：主题手动偏好（设置→常规→外观）。
 * 键 'ember.theme' 与 public/theme-init.js 的首帧恢复约定一致：
 * 'system'=移除键并摘 data-theme（跟随系统），'light'/'dark'=写键并钉 data-theme。 */

export type ThemePreference = 'system' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'ember.theme';

export function readThemePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    /* localStorage 不可用：跟随系统 */
    return 'system';
  }
}

export function applyThemePreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    /* 隐私模式等：仅本次会话生效 */
  }
  const root = document.documentElement;
  if (preference === 'system') delete root.dataset.theme;
  else root.dataset.theme = preference;
  /* 切换助推（theme-v1.1.md §7-8）：切换瞬间开短窗颜色过渡，260ms 后摘除，不常驻全局 transition */
  root.classList.add('theme-transition');
  window.setTimeout(() => root.classList.remove('theme-transition'), 260);
}
