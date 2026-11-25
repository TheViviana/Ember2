/**
 * P5-C3：编辑器 ↔ Core 的同步判定与冲突裁决。
 *
 * 不引用 CodeMirror，便于在 Node 环境用 Fake 覆盖防回环判定。
 * C3 起每个浮窗固定绑定一篇文档（windowId = path），不存在窗内文档切换，
 * 故 C2 的 `loadDocumentForSwitch` 已删除。
 */

export interface EditorUpdateLike {
  /** update.docChanged */
  readonly docChanged: boolean;
  /** 事务是否带外部回写标记（Core → Editor 产生）。 */
  readonly external: boolean;
}

/** 只有正文变化且不是外部回写时才写回 Core；选区/焦点变化一律忽略。 */
export function shouldWriteBack(update: EditorUpdateLike): boolean {
  return update.docChanged && !update.external;
}

/** Core → Editor：文本相同则不再派发事务，避免无意义更新与光标跳动。 */
export function shouldApplyExternal(currentText: string, nextText: string): boolean {
  return currentText !== nextText;
}

export type ConflictChoiceLike = 'reload' | 'overwrite';
export type ConflictAction = 'reload' | 'overwrite' | 'close';

/**
 * 冲突裁决：文件已被外部删除时，“重新加载”不再读盘，而是接受删除并关闭文档；
 * 其余情况沿用 reload / overwrite。
 */
export function conflictAction(
  kind: 'updated' | 'removed',
  choice: ConflictChoiceLike,
): ConflictAction {
  if (kind === 'removed' && choice === 'reload') return 'close';
  return choice;
}
