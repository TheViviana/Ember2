/**
 * 编辑模式 live-preview：只隐藏光标外的 Markdown 标记，不替换正文、不阻断编辑。
 * 光标/选区进入结构后显示源码；失焦时整篇保持排版。
 */
import { syntaxTree } from '@codemirror/language';
import type { EditorState, Extension, Range } from '@codemirror/state';
import {
  Decoration,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view';
import { frontmatterConcealRange } from './frontmatter-conceal.ts';

interface SourceRange {
  readonly from: number;
  readonly to: number;
}

/** 非空选区用半开区间；空光标允许停在结构边界，便于继续输入标记。 */
export function selectionIntersectsStructure(
  selection: SourceRange,
  structure: SourceRange,
): boolean {
  if (selection.from === selection.to) {
    return selection.from >= structure.from && selection.from <= structure.to;
  }
  return selection.from < structure.to && selection.to > structure.from;
}

function structureIsActive(state: EditorState, structure: SourceRange, focused: boolean): boolean {
  return focused && state.selection.ranges.some(
    (selection) => selectionIntersectsStructure(selection, structure),
  );
}

function skipFollowingSpaces(state: EditorState, from: number, to: number): number {
  const match = /^[\t ]+/.exec(state.doc.sliceString(from, to));
  return from + (match?.[0].length ?? 0);
}

class ListBulletWidget extends WidgetType {
  toDOM(): HTMLElement {
    const bullet = document.createElement('span');
    bullet.className = 'ember-live-list-bullet';
    bullet.textContent = '•';
    bullet.setAttribute('aria-hidden', 'true');
    return bullet;
  }
}

const conceal = Decoration.replace({});
const bullet = Decoration.replace({ widget: new ListBulletWidget() });
const strong = Decoration.mark({ class: 'ember-live-strong' });
const emphasis = Decoration.mark({ class: 'ember-live-emphasis' });
const inlineCode = Decoration.mark({ class: 'ember-live-inline-code' });
const link = Decoration.mark({ class: 'ember-live-link' });
const orderedListMark = Decoration.mark({ class: 'ember-live-ordered-list-mark' });
const quoteLine = Decoration.line({ class: 'ember-live-quote' });
const headingLines = Array.from({ length: 6 }, (_, index) =>
  Decoration.line({ class: `ember-live-heading-${index + 1}` }),
);

/** 由语法树生成装饰；frontmatter 仍由 frontmatter-conceal 独立处理。 */
export function buildLivePreviewDecorations(
  state: EditorState,
  focused = true,
): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const frontmatter = frontmatterConcealRange(state.doc);
  const isFrontmatter = (from: number): boolean =>
    frontmatter !== null && from >= frontmatter.from && from < frontmatter.to;

  syntaxTree(state).iterate({
    enter: (node) => {
      const name = node.type.name;
      if (name !== 'Document' && isFrontmatter(node.from)) return false;

      const heading = /^ATXHeading([1-6])$/.exec(name);
      if (heading !== null) {
        const depth = Number(heading[1]);
        const line = state.doc.lineAt(node.from);
        const headingLine = headingLines[depth - 1];
        if (headingLine !== undefined) decorations.push(headingLine.range(line.from));
        const active = structureIsActive(state, node, focused);
        if (!active) {
          for (let child = node.node.firstChild; child !== null; child = child.nextSibling) {
            if (child.type.name !== 'HeaderMark') continue;
            const to = child.from === node.from
              ? skipFollowingSpaces(state, child.to, node.to)
              : child.to;
            decorations.push(conceal.range(child.from, to));
          }
        }
        return false;
      }

      if (name === 'StrongEmphasis' || name === 'Emphasis') {
        decorations.push(
          (name === 'StrongEmphasis' ? strong : emphasis).range(node.from, node.to),
        );
        if (!structureIsActive(state, node, focused)) {
          for (let child = node.node.firstChild; child !== null; child = child.nextSibling) {
            if (child.type.name === 'EmphasisMark') {
              decorations.push(conceal.range(child.from, child.to));
            }
          }
        }
        return true;
      }

      if (name === 'InlineCode') {
        decorations.push(inlineCode.range(node.from, node.to));
        if (!structureIsActive(state, node, focused)) {
          for (let child = node.node.firstChild; child !== null; child = child.nextSibling) {
            if (child.type.name === 'CodeMark') {
              decorations.push(conceal.range(child.from, child.to));
            }
          }
        }
        return false;
      }

      if (name === 'Link') {
        decorations.push(link.range(node.from, node.to));
        if (!structureIsActive(state, node, focused)) {
          for (let child = node.node.firstChild; child !== null; child = child.nextSibling) {
            if (child.type.name === 'LinkMark' || child.type.name === 'URL' || child.type.name === 'LinkTitle') {
              decorations.push(conceal.range(child.from, child.to));
            }
          }
        }
        return true;
      }

      if (name === 'Blockquote') {
        const first = state.doc.lineAt(node.from).number;
        const last = state.doc.lineAt(node.to).number;
        for (let lineNumber = first; lineNumber <= last; lineNumber += 1) {
          decorations.push(quoteLine.range(state.doc.line(lineNumber).from));
        }
        return true;
      }

      if (name === 'QuoteMark' && !isFrontmatter(node.from)) {
        const line = state.doc.lineAt(node.from);
        if (!structureIsActive(state, line, focused)) {
          decorations.push(
            conceal.range(node.from, skipFollowingSpaces(state, node.to, line.to)),
          );
        }
        return false;
      }

      if (name === 'ListMark') {
        const marker = state.doc.sliceString(node.from, node.to);
        if (/^\d+[.)]$/.test(marker)) {
          decorations.push(orderedListMark.range(node.from, node.to));
          return false;
        }
        const line = state.doc.lineAt(node.from);
        if (!structureIsActive(state, line, focused)) {
          decorations.push(bullet.range(node.from, node.to));
        }
        return false;
      }

      return true;
    },
  });

  return Decoration.set(decorations, true);
}

/** 每个编辑器实例持有独立插件；语法树增量解析完成后也会刷新。 */
export function livePreviewExtension(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildLivePreviewDecorations(view.state, view.hasFocus);
      }

      update(update: ViewUpdate): void {
        const treeChanged = syntaxTree(update.startState) !== syntaxTree(update.state);
        if (
          update.docChanged ||
          update.selectionSet ||
          update.focusChanged ||
          update.viewportChanged ||
          treeChanged
        ) {
          this.decorations = buildLivePreviewDecorations(update.state, update.view.hasFocus);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}
