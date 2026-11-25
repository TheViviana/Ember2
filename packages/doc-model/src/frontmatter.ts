/**
 * CR-20261119-20：doc-model frontmatter 提取与字段收窄（纯函数，零 IO，永不抛）。
 *
 * 识别文件开头的 `---\\n…\\n---` YAML 块；已知字段（id/title/summary/tags/aliases/created/updated）
 * 按类型收窄，未知键归入 extras 不丢；YAML 语法错 → frontmatter null + error + body 取全文
 * （坏 frontmatter 当正文，不阻断文档加载，§3.5）；所有非致命问题进 warnings。
 */
import { parse as parseYaml } from 'yaml';

export interface DocFrontmatter {
  readonly id?: string;
  readonly title?: string;
  readonly summary?: string;
  readonly tags?: string[];
  readonly aliases?: string[];
  readonly created?: string;
  readonly updated?: string;
  /** 未知键原样保留（不丢、不用 any）。 */
  readonly extras: Record<string, unknown>;
}

export interface FrontmatterParse {
  readonly frontmatter: DocFrontmatter | null;
  /** 去掉 frontmatter 块后的正文；YAML 语法错时为全文（块当正文）。 */
  readonly body: string;
  /** 原始 frontmatter 文本（调试/重写用）；无块为 null。 */
  readonly raw: string | null;
  /** 解析失败信息（成功为 null）。 */
  readonly error: string | null;
  /** 字段类型不符等非致命问题；parseDocument 汇聚进 ParseOutcome.warnings。 */
  readonly warnings: readonly string[];
}

const KNOWN_KEYS: readonly string[] = Object.freeze([
  'id',
  'title',
  'summary',
  'tags',
  'aliases',
  'created',
  'updated',
]);

/** 开头 frontmatter 块：首行 `---`，内部任意内容（非贪婪），闭合 `---` 独占一行（或文件结束）。 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export function parseFrontmatter(text: string): FrontmatterParse {
  const match = FRONTMATTER_RE.exec(text);
  if (match === null) {
    return Object.freeze({
      frontmatter: null,
      body: text,
      raw: null,
      error: null,
      warnings: Object.freeze([]),
    });
  }
  const raw: string = match[1] ?? '';
  const body: string = text.slice(match[0].length);
  const warnings: string[] = [];

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Object.freeze({
      frontmatter: null,
      body: text,
      raw,
      error: message,
      warnings: Object.freeze([`frontmatter YAML 解析失败，已按正文处理：${message}`]),
    });
  }

  // 空 frontmatter（`---\\n---`）：视为无 frontmatter。
  if (parsed === null || parsed === undefined) {
    return Object.freeze({ frontmatter: null, body, raw, error: null, warnings: Object.freeze([]) });
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    const message = `frontmatter 顶层必须是键值映射，实际为 ${Array.isArray(parsed) ? '数组' : typeof parsed}`;
    return Object.freeze({
      frontmatter: null,
      body: text,
      raw,
      error: message,
      warnings: Object.freeze([message]),
    });
  }

  const record = parsed as Record<string, unknown>;
  const known = new Set<string>(KNOWN_KEYS);
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!known.has(key)) extras[key] = value;
  }

  // 标量字段：非字符串一律忽略 + warning（§3.2「String() 降级或忽略」二选一，取忽略——确定性更强）。
  const scalar = (key: string): string | undefined => {
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value === 'string') return value;
    warnings.push(`frontmatter.${key} 非字符串，已忽略`);
    return undefined;
  };
  // 列表字段：非数组忽略 + warning；数组内非字符串项过滤 + warning。
  const stringList = (key: string): string[] | undefined => {
    const value = record[key];
    if (value === undefined) return undefined;
    if (Array.isArray(value)) {
      const items = value.filter((item): item is string => typeof item === 'string');
      if (items.length !== value.length) warnings.push(`frontmatter.${key} 含非字符串项，已过滤`);
      return items;
    }
    warnings.push(`frontmatter.${key} 非数组，已忽略`);
    return undefined;
  };

  const frontmatter: DocFrontmatter = Object.freeze({
    id: scalar('id'),
    title: scalar('title'),
    summary: scalar('summary'),
    tags: stringList('tags'),
    aliases: stringList('aliases'),
    created: scalar('created'),
    updated: scalar('updated'),
    extras: Object.freeze(extras),
  });
  return Object.freeze({
    frontmatter,
    body,
    raw,
    error: null,
    warnings: Object.freeze(warnings),
  });
}
