/**
 * CR-20261119-14：库列表状态机——纯 reducer。
 *
 * 零 React / 零 DOM / 零 @tauri-apps。
 * 只管理列表加载/成功/失败状态 + 每次列表全量刷新后的 items 替换。
 * 添加/移除后统一走 REFRESH（列表全量替换，不手动 splice——与 Rust 返回一致）。
 */

import type { LibraryDto } from '../../../src/types/ipc.ts';

export type LibraryListState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly items: readonly LibraryDto[] }
  | { readonly kind: 'error'; readonly message: string };

export type LibraryListAction =
  | { readonly type: 'OPEN' }
  | { readonly type: 'REFRESH'; readonly items: readonly LibraryDto[] }
  | { readonly type: 'REFRESH_FAIL'; readonly message: string }
  | { readonly type: 'CLOSE' };

export const LIBRARY_LIST_INITIAL: LibraryListState = Object.freeze({ kind: 'idle' });

export function libraryListReducer(
  _state: LibraryListState,
  action: LibraryListAction,
): LibraryListState {
  switch (action.type) {
    case 'OPEN':
      return Object.freeze({ kind: 'loading' });
    case 'REFRESH':
      return Object.freeze({ kind: 'ok', items: Object.freeze(action.items) });
    case 'REFRESH_FAIL':
      return Object.freeze({ kind: 'error', message: action.message });
    case 'CLOSE':
      return Object.freeze({ kind: 'idle' });
    default: {
      // 穷尽校验（未来加 action 时 TS 会报）
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}
