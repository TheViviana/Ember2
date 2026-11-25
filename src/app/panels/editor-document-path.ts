/** EditorWindow 的窗口 id 保持不变，仅把实际文档路径解析到最新改名终点。 */
export function resolveEditorDocumentPath(
  windowId: string,
  resolve: (from: string) => string | null,
): string {
  return resolve(windowId) ?? windowId;
}
