/**
 * 格式工具栏的纯文本变换：输入整篇文本与选区，输出一次替换。
 *
 * 不依赖 CodeMirror 实例，便于单测；EditorView 负责把结果 dispatch 成事务。
 */

export type FormatActionId =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'inlineCode'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bulletList'
  | 'orderedList'
  | 'quote'
  | 'task'
  | 'table'
  | 'link'
  | 'math';

export interface FormatRange {
  readonly from: number;
  readonly to: number;
}

export interface FormatChange {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
  /** 应用后的选区（left === right 表示光标）。 */
  readonly anchor: number;
  readonly head: number;
}

const INLINE_MARKERS: Partial<Record<FormatActionId, string>> = {
  bold: '**',
  italic: '*',
  strike: '~~',
  inlineCode: '`',
  math: '$',
};

function inlineChange(
  doc: string,
  range: FormatRange,
  marker: string,
): FormatChange {
  const selected = doc.slice(range.from, range.to);
  const inside = doc.slice(range.from - marker.length, range.from) === marker
    && doc.slice(range.to, range.to + marker.length) === marker;
  if (inside) {
    return {
      from: range.from - marker.length,
      to: range.to + marker.length,
      insert: selected,
      anchor: range.from - marker.length,
      head: range.from - marker.length + selected.length,
    };
  }
  const wrappedInside = selected.length >= marker.length * 2
    && selected.startsWith(marker)
    && selected.endsWith(marker);
  if (wrappedInside) {
    const inner = selected.slice(marker.length, -marker.length);
    return {
      from: range.from,
      to: range.to,
      insert: inner,
      anchor: range.from,
      head: range.from + inner.length,
    };
  }
  return {
    from: range.from,
    to: range.to,
    insert: `${marker}${selected}${marker}`,
    anchor: range.from + marker.length,
    head: range.from + marker.length + selected.length,
  };
}

function lineBounds(doc: string, range: FormatRange): { start: number; end: number } {
  const start = doc.lastIndexOf('\n', Math.max(0, range.from - 1)) + 1;
  const nextBreak = doc.indexOf('\n', range.to);
  return { start, end: nextBreak === -1 ? doc.length : nextBreak };
}

const LINE_PREFIX: Partial<Record<FormatActionId, string>> = {
  bulletList: '- ',
  orderedList: '1. ',
  quote: '> ',
  task: '- [ ] ',
  h1: '# ',
  h2: '## ',
  h3: '### ',
};

function stripExistingPrefix(line: string): string {
  return line.replace(/^(?:#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+)/, '');
}

function lineChange(
  doc: string,
  range: FormatRange,
  prefix: string,
): FormatChange {
  const { start, end } = lineBounds(doc, range);
  const lines = doc.slice(start, end).split('\n');
  const allPrefixed = lines.every((line) => line.startsWith(prefix));
  const next = lines
    .map((line) => {
      if (allPrefixed) return line.slice(prefix.length);
      const body = stripExistingPrefix(line);
      return body === '' ? prefix.trimEnd() : `${prefix}${body}`;
    })
    .join('\n');
  return {
    from: start,
    to: end,
    insert: next,
    anchor: start,
    head: start + next.length,
  };
}

const TABLE_TEMPLATE = '| 列 1 | 列 2 |\n| --- | --- |\n|  |  |';

export function buildFormatChange(
  doc: string,
  range: FormatRange,
  action: FormatActionId,
): FormatChange {
  const inline = INLINE_MARKERS[action];
  if (inline !== undefined) return inlineChange(doc, range, inline);

  if (action === 'link') {
    const selected = doc.slice(range.from, range.to);
    const label = selected === '' ? '链接文字' : selected;
    const insert = `[${label}](url)`;
    const urlStart = range.from + label.length + 3;
    return {
      from: range.from,
      to: range.to,
      insert,
      anchor: urlStart,
      head: urlStart + 3,
    };
  }

  if (action === 'table') {
    return {
      from: range.from,
      to: range.to,
      insert: TABLE_TEMPLATE,
      anchor: range.from + TABLE_TEMPLATE.length,
      head: range.from + TABLE_TEMPLATE.length,
    };
  }

  const prefix = LINE_PREFIX[action];
  if (prefix !== undefined) return lineChange(doc, range, prefix);
  return { from: range.from, to: range.to, insert: doc.slice(range.from, range.to), anchor: range.to, head: range.to };
}
