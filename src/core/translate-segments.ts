/**
 * 段落级分段（CR-20261121-42/43）：对照翻译的规划与展示共用同一套分段口径。
 *
 * `splitTranslateParagraphs` 与 Rust 侧 `split_paragraphs` 必须逐字节一致
 * （同一测试向量双侧钉住）：以空行为界分段、段内保留单换行、丢弃空白段；
 * 围栏感知——``` / ~~~ 代码围栏与独占一行 `$$` 公式围栏内部的空行不切断段落。
 * AI 模式无 URL 长度限制，超长段落不再按 1,800 字符硬切，整段交给模型。
 */

export const MAX_TRANSLATE_SEGMENTS = 1000;

/**
 * 2026-11-23：AI 翻译单请求的安全字符上限。
 *
 * 之前超长段落整段交给模型，长文（尤其小上下文模型）会出现请求超限、翻译中断。
 * 这里只切「过长的单个段落」，仍按原段落序号回填对照译文；不改变
 * `splitTranslateParagraphs` 与 Rust 的逐字节一致契约。
 */
export const MAX_AI_TRANSLATE_CHUNK_CHARS = 2000;

export interface TranslateChunk {
  /** 原段落序号（对照展示按它回填；同一段可产生多个 chunk）。 */
  readonly index: number;
  readonly text: string;
}

export type PlanSegmentsResult =
  | { readonly ok: true; readonly segments: ReadonlyArray<string> }
  | { readonly ok: false; readonly reason: string };

export function splitTranslateParagraphs(text: string): ReadonlyArray<string> {
  const normalized = text.replace(/\r\n/g, '\n');
  const paragraphs: string[] = [];
  let buffer: string[] = [];
  let inCodeFence = false;
  let inMathFence = false;
  const flush = (): void => {
    const paragraph = buffer.join('\n').trim();
    if (paragraph !== '') paragraphs.push(paragraph);
    buffer = [];
  };
  for (const line of normalized.split('\n')) {
    const trimmed = line.trim();
    if (!inMathFence && (trimmed.startsWith('```') || trimmed.startsWith('~~~'))) {
      inCodeFence = !inCodeFence;
    }
    if (!inCodeFence && trimmed === '$$') {
      inMathFence = !inMathFence;
    }
    if (!inCodeFence && !inMathFence && trimmed === '') {
      flush();
    } else {
      buffer.push(line);
    }
  }
  flush();
  return paragraphs;
}

export function planAiSegments(text: string): PlanSegmentsResult {
  const segments = splitTranslateParagraphs(text);
  if (segments.length > MAX_TRANSLATE_SEGMENTS) {
    return {
      ok: false,
      reason: `单次对照翻译最多 ${MAX_TRANSLATE_SEGMENTS} 段，请分次翻译`,
    };
  }
  return { ok: true, segments };
}


/** 在句号/分号/换行等软边界切分超长段落；无边界时按硬上限切。 */
export function splitLongTranslateText(
  text: string,
  maxChars: number = MAX_AI_TRANSLATE_CHUNK_CHARS,
): readonly string[] {
  const max = Math.max(200, Math.floor(maxChars));
  let rest = text.trim();
  if (rest === '') return [];
  if (rest.length <= max) return [rest];
  const chunks: string[] = [];
  while (rest.length > max) {
    let cut = -1;
    const limit = Math.min(max, rest.length);
    for (let index = limit; index > Math.floor(limit * 0.5); index -= 1) {
      const char = rest[index - 1];
      if (char === '\n' || char === '。' || char === '！' || char === '？' || char === '；' ||
          char === '!' || char === '?' || char === ';' || char === '.') {
        cut = index;
        break;
      }
    }
    if (cut <= 0) {
      const space = rest.lastIndexOf(' ', limit);
      if (space > Math.floor(limit * 0.5)) cut = space + 1;
    }
    if (cut <= 0) cut = limit;
    const chunk = rest.slice(0, cut).trim();
    if (chunk !== '') chunks.push(chunk);
    rest = rest.slice(cut).trimStart();
  }
  if (rest !== '') chunks.push(rest);
  return chunks;
}

/** 把段落列表展开为带原段落序号的翻译块（长段落可拆多块）。 */
export function planAiTranslateChunks(
  segments: readonly string[],
  maxChars: number = MAX_AI_TRANSLATE_CHUNK_CHARS,
): readonly TranslateChunk[] {
  const chunks: TranslateChunk[] = [];
  segments.forEach((source, index) => {
    for (const text of splitLongTranslateText(source, maxChars)) {
      chunks.push({ index, text });
    }
  });
  return chunks;
}
