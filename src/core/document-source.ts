import { parseDocument, parseFrontmatter } from '#doc-model';
import { isMap, isScalar, isSeq, parse as parseYaml, parseDocument as parseYamlDocument } from 'yaml';
import type { Scalar } from 'yaml';
import type { Heading } from 'mdast';

export type DocumentSourceKind = 'title' | 'tags' | 'body';
export type DocumentSourceSyntax = 'yaml' | 'markdown';

export interface DocumentSourceRange {
  readonly kind: DocumentSourceKind;
  readonly syntax: DocumentSourceSyntax;
  /** 相对完整文档的 UTF-16 raw offset，end 不包含在范围内。 */
  readonly start: number;
  readonly end: number;
}

export interface DocumentSource {
  readonly text: string;
  readonly ranges: readonly DocumentSourceRange[];
}

export interface DocumentSourceReplacement {
  readonly range: DocumentSourceRange;
  readonly replacement: string;
}

export interface DocumentReplacementResult {
  readonly text: string;
  readonly error: string | null;
}

function quotedContentRange(raw: string, range: DocumentSourceRange): DocumentSourceRange {
  const value = raw.slice(range.start, range.end);
  const first = value[0];
  const last = value[value.length - 1];
  if (value.length >= 2 && ((first === '"' && last === '"') || (first === "'" && last === "'"))) {
    return { ...range, start: range.start + 1, end: range.end - 1 };
  }
  return range;
}

function yamlScalarRange(
  raw: string,
  rawOffset: number,
  node: Scalar<unknown>,
  kind: 'title' | 'tags',
): DocumentSourceRange | null {
  if (typeof node.value !== 'string' || node.range == null) return null;
  const [start, valueEnd] = node.range;
  const content = quotedContentRange(raw, {
    kind,
    syntax: 'yaml',
    start,
    end: valueEnd,
  });
  return { ...content, start: content.start + rawOffset, end: content.end + rawOffset };
}

function yamlRanges(text: string, raw: string, rawOffset: number): readonly DocumentSourceRange[] {
  const document = parseYamlDocument(raw);
  if (document.errors.length > 0 || !isMap(document.contents)) return [];
  const ranges: DocumentSourceRange[] = [];
  for (const pair of document.contents.items) {
    if (!isScalar(pair.key) || pair.key.value === null) continue;
    if (pair.key.value === 'title' && isScalar(pair.value)) {
      const range = yamlScalarRange(raw, rawOffset, pair.value, 'title');
      if (range !== null) ranges.push(range);
    }
    if (pair.key.value === 'tags' && isSeq(pair.value)) {
      for (const item of pair.value.items) {
        if (!isScalar(item)) continue;
        const range = yamlScalarRange(raw, rawOffset, item, 'tags');
        if (range !== null) ranges.push(range);
      }
    }
  }
  if (ranges.some((range) => range.kind === 'title')) return ranges;

  const parsed = parseDocument(text);
  const bodyStart = text.length - parsed.body.length;
  const heading = parsed.tree.children.find((node): node is Heading => node.type === 'heading' && node.depth === 1);
  const first = heading?.children[0];
  const last = heading?.children[heading.children.length - 1];
  const start = first?.position?.start.offset;
  const end = last?.position?.end.offset;
  if (start !== undefined && end !== undefined && end >= start) {
    ranges.push({ kind: 'title', syntax: 'markdown', start: bodyStart + start, end: bodyStart + end });
  } else if (heading?.position !== undefined) {
    const headingStart = heading.position.start.offset;
    const headingEnd = heading.position.end.offset;
    if (headingStart !== undefined && headingEnd !== undefined) {
      ranges.push({ kind: 'title', syntax: 'markdown', start: bodyStart + headingStart, end: bodyStart + headingEnd });
    }
  }
  return ranges;
}

/** 从完整文档提取可搜索范围；所有 offset 均指向原始字节对应的 JS UTF-16 位置。 */
export function readDocumentSource(text: string): DocumentSource {
  const parsed = parseDocument(text);
  const bodyStart = text.length - parsed.body.length;
  const ranges: DocumentSourceRange[] = [{
    kind: 'body',
    syntax: 'markdown',
    start: bodyStart,
    end: text.length,
  }];
  const frontmatter = parseFrontmatter(text);
  if (frontmatter.frontmatter !== null && frontmatter.raw !== null) {
    const rawOffset = text.indexOf('\n') + 1;
    ranges.push(...yamlRanges(text, frontmatter.raw, rawOffset));
  } else {
    ranges.push(...yamlRanges(text, '', 0));
  }
  return Object.freeze({ text, ranges: Object.freeze(ranges) });
}

/** 读取合法 frontmatter 中的文档 id；缺失或类型不符返回 null。 */
export function readDocumentId(text: string): string | null {
  const parsed = parseFrontmatter(text);
  const id = parsed.frontmatter?.id;
  return typeof id === 'string' && id !== '' ? id : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateYamlReplacement(
  source: DocumentSource,
  nextText: string,
  validateTitle: boolean,
  validateTags: boolean,
): string | null {
  const before = parseFrontmatter(source.text);
  const after = parseFrontmatter(nextText);
  if (after.error !== null || after.frontmatter === null || after.raw === null) {
    return '替换会使 frontmatter 失效，本文档未提交';
  }
  let beforeValue: unknown;
  let afterValue: unknown;
  try {
    beforeValue = before.raw === null ? null : parseYaml(before.raw);
    afterValue = parseYaml(after.raw);
  } catch (error: unknown) {
    return `替换后 YAML 无法解析：${error instanceof Error ? error.message : String(error)}`;
  }
  if (!isRecord(beforeValue) || !isRecord(afterValue)) return '替换后 frontmatter 必须是键值映射';
  if (!Object.is(beforeValue.id, afterValue.id)) return '替换会改变文档 id，本文档未提交';
  if (validateTitle && typeof afterValue.title !== 'string') {
    return '替换会改变 title 的字符串类型，本文档未提交';
  }
  if (validateTags && (!Array.isArray(afterValue.tags)
    || !afterValue.tags.every((tag: unknown) => typeof tag === 'string'))) {
    return '替换会改变 tags 的字符串列表类型，本文档未提交';
  }
  return null;
}

/** 仅按 raw offset 降序切片，不重新序列化 Markdown 或 YAML。 */
export function applyDocumentReplacements(
  source: DocumentSource,
  replacements: readonly DocumentSourceReplacement[],
): DocumentReplacementResult {
  const ordered = [...replacements].sort((a, b) => b.range.start - a.range.start || b.range.end - a.range.end);
  let text = source.text;
  let validateTitle = false;
  let validateTags = false;
  for (const item of ordered) {
    text = `${text.slice(0, item.range.start)}${item.replacement}${text.slice(item.range.end)}`;
    if (item.range.syntax === 'yaml' && item.range.kind === 'title') validateTitle = true;
    if (item.range.syntax === 'yaml' && item.range.kind === 'tags') validateTags = true;
  }
  if (!validateTitle && !validateTags) return { text, error: null };
  return { text, error: validateYamlReplacement(source, text, validateTitle, validateTags) };
}
