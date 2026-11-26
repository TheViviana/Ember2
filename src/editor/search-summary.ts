/**
 * 搜索面板的匹配摘要（纯逻辑）：总数 + 当前选区命中序号。
 * 与 CodeMirror 的 SearchQuery 共用同一套游标，正则/整词/大小写口径一致。
 */
import type { EditorState } from '@codemirror/state';
import type { SearchQuery } from '@codemirror/search';

export interface SearchSummary {
  readonly total: number;
  /** 1-based 命中序号；0 表示当前光标不在任何命中内。 */
  readonly index: number;
  /** 正则语法是否有效；无效时不枚举匹配。 */
  readonly valid: boolean;
}

export function summarizeSearch(
  state: EditorState,
  query: SearchQuery,
  selectionFrom: number = state.selection.main.from,
): SearchSummary {
  if (query.search === '') return { total: 0, index: 0, valid: true };
  if (!query.valid) return { total: 0, index: 0, valid: false };
  let total = 0;
  let index = 0;
  try {
    const cursor = query.getCursor(state);
    for (let next = cursor.next(); next.done !== true; next = cursor.next()) {
      const match = next.value as { readonly from: number; readonly to: number };
      total += 1;
      if (index === 0 && selectionFrom >= match.from && selectionFrom <= match.to) {
        index = total;
      }
    }
  } catch {
    return { total: 0, index: 0, valid: false };
  }
  return { total, index, valid: true };
}
