/**
 * CR-20261119-23：媒体库窗口状态机（纯 reducer，零 React / 零 IPC / 零 app / 零 data）。
 *
 * 六态：idle / loading / ready / error / confirming / deleting（D3）。
 * - in-flight（loading/deleting）拒绝全部交互动作；confirming 只接受确认/取消；
 * - 加载失败 → error（entries 置空）；删除失败 → error（**entries 保留**，列表不闪失）；
 * - DELETE_OK → 回 loading 重新拉取（数据流：显示 via → 刷新）；
 * - TAB_CHANGE / SHOW_MORE 仅 ready；TAB_CHANGE 重置懒加载切片。
 */

import {
  FIRST_SLICE,
  MORE_SLICE,
  sortForDisplay,
  type MediaEntry,
  type MediaTab,
} from './media-groups.ts';

export type MediaListStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'error'
  | 'confirming'
  | 'deleting';

export interface MediaListError {
  readonly code?: string;
  readonly message: string;
}

export type DeleteVia = 'system' | 'workbench';

export interface MediaListState {
  readonly status: MediaListStatus;
  /** 已排序（modifiedMs 降序）的全量条目。 */
  readonly entries: readonly MediaEntry[];
  readonly tab: MediaTab;
  /** 懒加载已渲染条数（作用于当前 tab 的过滤结果）。 */
  readonly visibleCount: number;
  readonly error: MediaListError | null;
  /** confirming / deleting 的目标媒体路径。 */
  readonly pendingPath: string | null;
  /** 最近一次删除的实际落点（系统回收站 / 库内 workbench）。 */
  readonly lastDeleteVia: DeleteVia | null;
}

export type MediaListAction =
  | { readonly type: 'LOAD_START' }
  | { readonly type: 'LOAD_OK'; readonly entries: readonly MediaEntry[] }
  | { readonly type: 'LOAD_ERR'; readonly code?: string; readonly message: string }
  | { readonly type: 'TAB_CHANGE'; readonly tab: MediaTab }
  | { readonly type: 'SHOW_MORE' }
  | { readonly type: 'CONFIRM_OPEN'; readonly path: string }
  | { readonly type: 'CONFIRM_CANCEL' }
  | { readonly type: 'DELETE_START' }
  | { readonly type: 'DELETE_OK'; readonly via: DeleteVia }
  | { readonly type: 'DELETE_ERR'; readonly code?: string; readonly message: string };

export function createMediaListState(): MediaListState {
  return Object.freeze({
    status: 'idle',
    entries: Object.freeze([]),
    tab: 'all',
    visibleCount: 0,
    error: null,
    pendingPath: null,
    lastDeleteVia: null,
  });
}

export function mediaListReducer(  state: MediaListState,
  action: MediaListAction,
): MediaListState {
  // in-flight：loading / deleting 只接受本阶段 resolver（LOAD_* / DELETE_*），
  // 交互动作（TAB_CHANGE / SHOW_MORE / CONFIRM_OPEN）一律拒绝。
  if (state.status === 'loading' || state.status === 'deleting') {
    if (action.type === 'LOAD_OK') {
      return Object.freeze({
        ...state,
        status: 'ready',
        entries: sortForDisplay(action.entries),
        visibleCount: FIRST_SLICE,
        error: null,
      });
    }
    if (action.type === 'LOAD_ERR') {
      return Object.freeze({
        ...state,
        status: 'error',
        entries: state.entries,
        error: Object.freeze({ code: action.code, message: action.message }),
      });
    }
    if (action.type === 'DELETE_OK') {
      return Object.freeze({
        ...state,
        status: 'loading', // 数据流：显示 via 后重新拉取
        pendingPath: null,
        lastDeleteVia: action.via,
        error: null,
      });
    }
    if (action.type === 'DELETE_ERR') {
      return Object.freeze({
        ...state,
        status: 'error',
        entries: state.entries, // 删除失败列表不闪失
        pendingPath: null,
        error: Object.freeze({ code: action.code, message: action.message }),
      });
    }
    return state;
  }
  // confirming：只接受取消与确认后的删除启动。
  if (state.status === 'confirming') {
    if (action.type === 'CONFIRM_CANCEL') {
      return Object.freeze({ ...state, status: 'ready', pendingPath: null });
    }
    if (action.type === 'DELETE_START') {
      return Object.freeze({ ...state, status: 'deleting' });
    }
    return state;
  }

  switch (action.type) {
    case 'LOAD_START':
      return Object.freeze({ ...state, status: 'loading', error: null });
    case 'TAB_CHANGE':
      return Object.freeze({ ...state, tab: action.tab, visibleCount: FIRST_SLICE });
    case 'SHOW_MORE':
      return Object.freeze({ ...state, visibleCount: state.visibleCount + MORE_SLICE });
    case 'CONFIRM_OPEN':
      // 仅就绪 / 错误态可发起删除确认（idle 无列表可删）。
      if (state.status !== 'ready' && state.status !== 'error') return state;
      return Object.freeze({
        ...state,
        status: 'confirming',
        pendingPath: action.path,
        error: null,
      });
    default:
      return state;
  }
}

// FIRST_SLICE / MORE_SLICE 语义在 media-groups.ts 单源；此处再导出供窗口层使用。
export { FIRST_SLICE, MORE_SLICE };
