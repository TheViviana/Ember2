/**
 * 编辑器行号偏好（设置→外观→编辑器）。
 *
 * - localStorage 记住选择，默认显示行号；
 * - 通过 window 自定义事件广播，已打开的编辑器窗口立即生效，无需重开文档。
 *
 * 位于 core：纯 localStorage + window 事件，无 UI/状态库依赖，供 editor 与
 * features/settings 两侧共同消费（CR-20261121-51 自 editor/ 上移，消除层间双向边）。
 */

const STORAGE_KEY = 'ember.editor.gutter';
const CHANGE_EVENT = 'ember:editor-gutter-change';

export function readGutterVisible(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'hidden';
  } catch {
    /* localStorage 不可用：保持默认显示 */
    return true;
  }
}

export function writeGutterVisible(visible: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, visible ? 'visible' : 'hidden');
  } catch {
    /* 隐私模式等：仅本次会话生效 */
  }
  window.dispatchEvent(new CustomEvent<boolean>(CHANGE_EVENT, { detail: visible }));
}

export function subscribeGutterVisible(listener: (visible: boolean) => void): () => void {
  const handler = (event: Event): void => {
    if (event instanceof CustomEvent && typeof event.detail === 'boolean') {
      listener(event.detail);
      return;
    }
    listener(readGutterVisible());
  };
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}
