/**
 * CR-20261120-27 C2-fix：文档查看器状态机（纯 reducer，零 React / 零 IPC）。
 *
 * 不变式（复核修订）：
 * - DOC_TIMEOUT 在 viewer === null 时必须 no-op——绝不允许写出无 path 的状态（黑屏根因）；
 * - 动作携带 token，打开新条目后旧计时器不得改写新状态；
 * - DOC_LOADED 后超时不再置 failed（元素已正常加载）。
 */

import type { DocViewerKind } from './doc-viewer.ts';

export interface DocViewerTarget {
  readonly path: string;
  readonly kind: DocViewerKind;
}

export interface DocViewerState {
  /** null = 关闭；非 null = 打开中（path/kind 成对存在，永不分家）。 */
  readonly viewer: DocViewerTarget | null;
  /** 加载失败（onError 或 5s 超时）→ 浮层显示「无法预览」。 */
  readonly failed: boolean;
  /** iframe onLoad 成功 → 取消超时语义。 */
  readonly loaded: boolean;
  /** 打开代次：每次 OPEN_DOC 自增；timeout/loaded 动作按 token 匹配生效。 */
  readonly token: number;
}

export type DocViewerAction =
  | { readonly type: 'OPEN_DOC'; readonly path: string; readonly kind: DocViewerKind }
  | { readonly type: 'CLOSE_DOC' }
  | { readonly type: 'DOC_TIMEOUT'; readonly token: number }
  | { readonly type: 'DOC_LOADED'; readonly token: number };

export function createDocViewerState(): DocViewerState {
  return Object.freeze({
    viewer: null,
    failed: false,
    loaded: false,
    token: 0,
  });
}

export function docViewerReducer(
  state: DocViewerState,
  action: DocViewerAction,
): DocViewerState {
  switch (action.type) {
    case 'OPEN_DOC':
      return Object.freeze({
        viewer: Object.freeze({ path: action.path, kind: action.kind }),
        failed: false,
        loaded: false,
        token: state.token + 1,
      });
    case 'CLOSE_DOC':
      return Object.freeze({ ...state, viewer: null, failed: false, loaded: false });
    case 'DOC_TIMEOUT':
      // 关闭后超时（viewer 已 null）或旧代次超时：一律 no-op——绝不写出无 path 的状态。
      if (state.viewer === null || action.token !== state.token || state.loaded) {
        return state;
      }
      return Object.freeze({ ...state, failed: true });
    case 'DOC_LOADED':
      if (state.viewer === null || action.token !== state.token) return state;
      return Object.freeze({ ...state, loaded: true, failed: false });
    default:
      return state;
  }
}
