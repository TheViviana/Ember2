/* 主题初始化：渲染发生前恢复用户手动外观偏好；跟随系统时不设置 data-theme。
 * 偏好键 'ember.theme'（'light' | 'dark'）——设置界面的手动切换写同一个键。
 * CSP script-src 'self' 禁内联脚本（tests/csp.test.ts），故以外链经典脚本在 <head> 加载。 */
(function () {
  try {
    var theme = localStorage.getItem('ember.theme');
    if (theme === 'light' || theme === 'dark') {
      /* data-theme 切 color-scheme，body 的 light-dark 首帧底色随之解析（html 保持透明，
       * 圆角裁切在 body——绝不可给 html 设背景色，否则主界面四角出现方角色块） */
      document.documentElement.dataset.theme = theme;
    }
  } catch {
    /* localStorage 不可用（隐私模式等）：跟随系统外观 */
  }
})();
