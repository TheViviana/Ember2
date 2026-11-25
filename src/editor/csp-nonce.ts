/**
 * 生产 CSP 的样式 nonce（CodeMirror style-mod 注入 <style> 使用）。
 *
 * 背景（2026-11-23 打包版回归）：生产 CSP 的 `style-src-elem` 只允许
 * 'self' + 固定 nonce + index.html 内联样式哈希；CodeMirror 6 的 baseTheme
 * 由 style-mod 在运行时注入 <style>，若不通过 `EditorView.cspNonce` facet
 * 把 nonce 交给 style-mod，这些样式在打包版会被 CSP 拦截，开发版因
 * `devCsp` 含 unsafe-inline 而看不出问题（表现为：显示行号后正文被行号
 * 槽挤到视口外、滚动条失效）。
 *
 * 该值必须与 `src-tauri/tauri.conf.json` 生产 CSP 的 `nonce-` 完全一致，
 * 由 `tests/csp.test.ts` 双侧钉死；改动任一侧都会红。
 */
export const EDITOR_STYLE_NONCE = 'RW1iZXJFZGl0b3JTdHlsZU5vbmNl';
