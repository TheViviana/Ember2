/**
 * 段落级分段（CR-20261121-42/43）：对照翻译的规划与展示共用同一套分段口径。
 *
 * `splitTranslateParagraphs` 与 Rust 侧 `split_paragraphs` 必须逐字节一致
 * （同一测试向量双侧钉住）：以空行为界分段、段内保留单换行、丢弃空白段；
 * 围栏感知——``` / ~~~ 代码围栏与独占一行 `$$` 公式围栏内部的空行不切断段落。
 * AI 模式无 URL 长度限制，超长段落不再按 1,800 字符硬切，整段交给模型。
 */

export const MAX_TRANSLATE_SEGMENTS = 500;

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
