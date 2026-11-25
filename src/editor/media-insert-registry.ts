import type { EditorInsertPoint, EditorMediaInsertion } from './host.ts';

export type EditorMediaInserter = (
  media: EditorMediaInsertion,
  point: EditorInsertPoint,
) => void;

const inserters = new Map<string, EditorMediaInserter>();

/** EditorView 句柄就绪后由 EditorWindow 登记；注销只移除本次登记的回调。 */
export function registerEditorMediaInserter(
  windowId: string,
  inserter: EditorMediaInserter,
): () => void {
  inserters.set(windowId, inserter);
  return () => {
    if (inserters.get(windowId) === inserter) inserters.delete(windowId);
  };
}

/** 返回 false 仅表示目标浮窗尚未登记；插入失败由目标编辑器自行提示。 */
export function insertMediaIntoEditor(
  windowId: string,
  media: EditorMediaInsertion,
  point: EditorInsertPoint,
): boolean {
  const inserter = inserters.get(windowId);
  if (inserter === undefined) return false;
  inserter(media, point);
  return true;
}
