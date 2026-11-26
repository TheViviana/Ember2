/**
 * 编辑区隐藏 YAML frontmatter：标签经浮窗标签栏管理（§标签栏），正文保持可编辑。
 *
 * 用 Decoration.replace 把 frontmatter 块做视觉隐藏——不改变文档内容，
 * 写回（doc.toString()）仍含完整 frontmatter，标签栏的 withDocumentTags 写回不受影响。
 */
import { StateField } from '@codemirror/state';
import type { Text } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';

/** frontmatter 的隐藏范围（含起止 --- 行与其后换行）；无 frontmatter 或未闭合则 null。 */
export function frontmatterConcealRange(doc: Text): { readonly from: number; readonly to: number } | null {
  if (doc.lines === 0) return null;
  if (doc.line(1).text.trim() !== '---') return null;
  for (let n = 2; n <= doc.lines; n += 1) {
    const t = doc.line(n).text.trim();
    if (t === '---' || t === '...') {
      const to = n < doc.lines ? doc.line(n).to + 1 : doc.line(n).to;
      return { from: 0, to };
    }
  }
  return null;
}

const conceal = Decoration.replace({});

function build(doc: Text): DecorationSet {
  const range = frontmatterConcealRange(doc);
  return range === null ? Decoration.none : Decoration.set([conceal.range(range.from, range.to)]);
}

export const frontmatterConceal = StateField.define<DecorationSet>({
  create(state) {
    return build(state.doc);
  },
  update(value, tr) {
    return tr.docChanged ? build(tr.newDoc) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});
