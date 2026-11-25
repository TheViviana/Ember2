/**
 * 标签写回：重写 frontmatter 的 `tags` 字段，保留其余键与正文。
 *
 * 只在用户显式增删标签时调用；写入后立即复解析校验，失败不返回半成品。
 */
import { parseFrontmatter } from '#doc-model';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { normalizeTagList } from './tag-path.ts';

export interface TagsWriteResult {
  readonly text: string;
  readonly error: string | null;
}

const FRONTMATTER_BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function sameTags(after: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(after) || after.length !== expected.length) return false;
  return after.every((value, index) => value === expected[index]);
}

export function withDocumentTags(text: string, tags: readonly string[]): TagsWriteResult {
  const normalized = normalizeTagList(tags);
  const parsed = parseFrontmatter(text);
  if (parsed.error !== null) {
    return { text, error: 'frontmatter 解析失败，未写入标签' };
  }

  const data: Record<string, unknown> = {};
  if (parsed.raw !== null && parsed.raw.trim() !== '') {
    let value: unknown;
    try {
      value = parseYaml(parsed.raw);
    } catch (error: unknown) {
      return {
        text,
        error: `frontmatter 无法解析：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (value !== null) {
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { text, error: 'frontmatter 不是键值映射，未写入标签' };
      }
      Object.assign(data, value);
    }
  }

  if (normalized.length === 0) delete data.tags;
  else data.tags = [...normalized];

  const match = FRONTMATTER_BLOCK_RE.exec(text);
  const body = match === null ? text : text.slice(match[0].length);
  const raw = Object.keys(data).length === 0 ? '' : stringifyYaml(data).trimEnd();
  const block = raw === '' ? '' : `---\n${raw}\n---\n`;
  const nextText = block === '' ? body : `${block}${body}`;

  const check = parseFrontmatter(nextText);
  if (check.error !== null) return { text, error: '标签写入后 frontmatter 校验失败' };
  const after = check.frontmatter?.tags ?? [];
  if (!sameTags(after, normalized)) return { text, error: '标签写入校验失败，本文档未修改' };
  return { text: nextText, error: null };
}
