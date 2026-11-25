import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from '../windows/ErrorBoundary';
import { applyArticleFontSize, readArticleFontSize } from '../core/article-font';
import '../styles/global.css'; // tokens.css 由 global.css @import 单次引入，禁止重复加载
import './app.css';

const root = document.getElementById('root');
if (!root) throw new Error('缺少 #root 挂载点');

// 启动即应用文章字号偏好，避免窗口首帧字号跳变。
applyArticleFontSize(readArticleFontSize());

// ── 全局兜底（CR-20261120-27 C2-fix）────────────────────────────────────
// 未捕获异常 / 未处理的 Promise 拒绝 → 可关闭的错误条；console.error 保留，不吞错。
// 容器模式（gate:mutable-exports 禁模块级 let；viewportHolder 同款）。
const globalErrorBarHolder: { value: HTMLDivElement | null } = { value: null };
function showGlobalError(message: string): void {
  const existing = globalErrorBarHolder.value;
  if (existing !== null) {
    const textEl = existing.querySelector('[data-global-error-text]');
    if (textEl !== null) textEl.textContent = message;
    return;
  }
  const bar = document.createElement('div');
  bar.setAttribute('role', 'alert');
  bar.style.cssText =
    'position:fixed;left:12px;right:12px;bottom:12px;z-index:9001;display:flex;gap:10px;' +
    'align-items:center;padding:10px 12px;font-family:var(--font-body);font-size:12px;' +
    'color:var(--ember-text-primary);background:var(--ember-bg-surface);' +
    'border:1px solid var(--ember-danger);border-radius:8px;box-sizing:border-box;';
  const text = document.createElement('span');
  text.setAttribute('data-global-error-text', '');
  text.style.cssText = 'flex:1;overflow-wrap:anywhere;';
  text.textContent = message;
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '关闭';
  close.style.cssText =
    'flex-shrink:0;padding:4px 10px;font-family:var(--font-body);font-size:12px;color:' +
    'var(--ember-text-primary);background:transparent;border:1px solid var(--ember-border);' +
    'border-radius:6px;cursor:pointer;';
  close.addEventListener('click', () => {
    bar.remove();
    globalErrorBarHolder.value = null;
  });
  bar.append(text, close);
  document.body.append(bar);
  globalErrorBarHolder.value = bar;
}

window.addEventListener('error', (event) => {
  console.error('[global] 未捕获异常', event.error ?? event.message);
  showGlobalError(`未捕获异常：${String(event.error instanceof Error ? event.error.message : event.message)}`);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[global] 未处理的 Promise 拒绝', event.reason);
  showGlobalError(`未处理的 Promise 拒绝：${String(event.reason)}`);
});

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary scope="app">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
