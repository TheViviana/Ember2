/**
 * 将安全媒体 Markdown 引用映射为 CodeMirror replace decorations。
 * 选区与引用相交时不装饰，直接显示源码；扩展自身永不 dispatch 文档事务。
 */
import { StateField, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { MediaPreviewWidget, type MediaWidgetSpec } from './media-widgets.ts';

export interface MediaPreviewReference extends MediaWidgetSpec {
  readonly from: number;
  readonly to: number;
}

export type ExtractMediaPreviewReferences = (text: string) => readonly MediaPreviewReference[];

export interface SourceRange {
  readonly from: number;
  readonly to: number;
}

/** 非空选区采用半开区间交集；空光标允许停在引用任一端点。 */
export function selectionIntersectsReference(
  selection: SourceRange,
  reference: SourceRange,
): boolean {
  if (selection.from === selection.to) {
    return selection.from >= reference.from && selection.from <= reference.to;
  }
  return selection.from < reference.to && selection.to > reference.from;
}

export function visibleMediaReferences(
  text: string,
  selections: readonly SourceRange[],
  extract: ExtractMediaPreviewReferences,
): MediaPreviewReference[] {
  return extract(text)
    .filter(
      (reference) =>
        Number.isInteger(reference.from) &&
        Number.isInteger(reference.to) &&
        reference.from >= 0 &&
        reference.to > reference.from &&
        reference.to <= text.length &&
        !selections.some((selection) => selectionIntersectsReference(selection, reference)),
    )
    .sort((a, b) => a.from - b.from || a.to - b.to);
}

export function buildMediaPreviewDecorations(
  state: EditorState,
  extract: ExtractMediaPreviewReferences,
): DecorationSet {
  const references = visibleMediaReferences(state.doc.toString(), state.selection.ranges, extract);
  return Decoration.set(
    references.map((reference) =>
      Decoration.replace({
        widget: new MediaPreviewWidget(reference),
        inclusive: false,
      }).range(reference.from, reference.to),
    ),
  );
}

/** 每个编辑器实例调用一次，创建独立 StateField，避免跨浮窗共享装饰。 */
export function mediaPreviewExtension(extract: ExtractMediaPreviewReferences): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => buildMediaPreviewDecorations(state, extract),
    update: (decorations, transaction) => {
      if (!transaction.docChanged && !transaction.selection) return decorations;
      return buildMediaPreviewDecorations(transaction.state, extract);
    },
  });
  return [field, EditorView.decorations.from(field)];
}
