/**
 * 确定性长文本切分（纯函数，零 React / 零 IPC）。
 *
 * 预算单位是 UTF-16 字符数。切点优先段落（`\n\n`）、Markdown 标题、换行；
 * 代码围栏内不切，只有单块超限时才在围栏内硬切，并保证不切开代理对。
 * 返回的是原文偏移，不复制正文，调用方用 slice 取块。
 */

export interface TextChunk {
  readonly start: number;
  readonly end: number;
}

interface Range {
  readonly start: number;
  readonly end: number;
}

const FENCE_LINE = /^ {0,3}(```|~~~)/;
const HEADING_LINE = /^ {0,3}#{1,6} /;

/** 代码围栏覆盖区间 [start, end)，包含开闭围栏整行；未闭合围栏延伸到文末。 */
function fenceRanges(text: string): readonly Range[] {
  const ranges: Range[] = [];
  let open: number | null = null;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    if (FENCE_LINE.test(text.slice(lineStart, lineEnd))) {
      if (open === null) {
        open = lineStart;
      } else {
        ranges.push({ start: open, end: newline === -1 ? text.length : newline + 1 });
        open = null;
      }
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  if (open !== null) ranges.push({ start: open, end: text.length });
  return ranges;
}

function insideFence(ranges: readonly Range[], pos: number): boolean {
  return ranges.some((range) => range.start < pos && pos < range.end);
}

/** 切点落在代理对中间时回退一个 code unit。 */
function codePointCut(text: string, cut: number): number {
  if (cut <= 0 || cut >= text.length) return cut;
  const prev = text.charCodeAt(cut - 1);
  const next = text.charCodeAt(cut);
  const prevHigh = prev >= 0xd800 && prev <= 0xdbff;
  const nextLow = next >= 0xdc00 && next <= 0xdfff;
  return prevHigh && nextLow ? cut - 1 : cut;
}

function isSpace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v';
}

function trimStart(text: string, start: number): number {
  let pos = start;
  while (pos < text.length && isSpace(text[pos] ?? '')) pos += 1;
  return pos;
}

function trimEnd(text: string, start: number, end: number): number {
  let pos = end;
  while (pos > start && isSpace(text[pos - 1] ?? '')) pos -= 1;
  return pos;
}

/** 按「段落 → 标题 → 换行」优先级选切点；围栏内的候选跳过，全部不可用返回 -1。 */
function pickCut(
  text: string,
  start: number,
  windowEnd: number,
  fences: readonly Range[],
): number {
  const window = text.slice(start, windowEnd);

  const paragraph = window.lastIndexOf('\n\n');
  if (paragraph >= 0) {
    const pos = start + paragraph + 2;
    if (!insideFence(fences, pos)) return pos;
  }

  const headings: number[] = [];
  let lineStart = start;
  while (lineStart < windowEnd) {
    const newlineAt = text.indexOf('\n', lineStart);
    const lineEnd = newlineAt === -1 ? text.length : newlineAt;
    if (lineStart > start && HEADING_LINE.test(text.slice(lineStart, lineEnd))) {
      headings.push(lineStart);
    }
    if (newlineAt === -1 || newlineAt + 1 >= windowEnd) break;
    lineStart = newlineAt + 1;
  }
  for (const pos of headings.reverse()) {
    if (!insideFence(fences, pos)) return pos;
  }

  const newline = window.lastIndexOf('\n');
  if (newline >= 0) {
    const pos = start + newline + 1;
    if (!insideFence(fences, pos)) return pos;
  }

  return -1;
}

/**
 * 按字符预算切分文本。
 * @param text 原文
 * @param maxChars 单块上限（字符数，>= 1）
 */
export function splitTextByBudget(text: string, maxChars: number): readonly TextChunk[] {
  const limit = Number.isFinite(maxChars) && maxChars >= 1 ? Math.floor(maxChars) : 1;
  const fences = fenceRanges(text);
  const chunks: TextChunk[] = [];
  let pos = 0;

  while (pos < text.length) {
    const start = trimStart(text, pos);
    if (start >= text.length) break;

    if (text.length - start <= limit) {
      const end = trimEnd(text, start, text.length);
      if (end > start) chunks.push({ start, end });
      break;
    }

    const windowEnd = start + limit;
    let cut = pickCut(text, start, windowEnd, fences);
    if (cut < 0) {
      // 整段都在代码围栏内且超过预算：允许围栏内硬切，但退到码点边界。
      cut = codePointCut(text, windowEnd);
      if (cut <= start) cut = start + 1;
    }

    const end = trimEnd(text, start, cut);
    if (end > start) chunks.push({ start, end });
    pos = cut;
  }

  return chunks;
}