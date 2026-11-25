/**
 * CR-20261119-20：doc-model wikilink 提取（纯函数，零额外依赖，幂等不改原文）。
 *
 * 支持 `[[target]]` / `[[target|alias]]` / `![[embed]]` / `![[embed|alias]]`；
 * 前置 `\` 转义（`\[[…]]`、`\![[…]]`）不提取；对 body（已去 frontmatter）运行，
 * 避免把 frontmatter 里的 `[[` 误判为链接。
 */

export interface WikiLink {
  /** `[[target|alias]]` 中的 target（去除首尾空白；空 target 不算链接）。 */
  readonly target: string;
  /** alias，无则不存在该键。 */
  readonly alias?: string;
  /** 展示文本 = alias ?? target。 */
  readonly label: string;
  /** `![[…]]` 嵌入为 true。 */
  readonly embedded: boolean;
}

/** `(!?)` 捕获可选嵌入前缀；内层不含任何方括号。 */
const WIKILINK_RE = /(!?)\[\[([^\][]+)\]\]/g;

export function extractWikiLinks(text: string): WikiLink[] {
  const links: WikiLink[] = [];
  for (const match of text.matchAll(WIKILINK_RE)) {
    const start = match.index ?? 0;
    if (start > 0 && text[start - 1] === '\\') continue;
    const inner: string = match[2] ?? '';
    const pipe = inner.indexOf('|');
    const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
    if (target.length === 0) continue;
    const aliasRaw = pipe === -1 ? '' : inner.slice(pipe + 1).trim();
    const embedded = match[1] === '!';
    links.push(
      Object.freeze(
        aliasRaw.length > 0
          ? { target, alias: aliasRaw, label: aliasRaw, embedded }
          : { target, label: target, embedded },
      ),
    );
  }
  return links;
}

export type WikiLinkSegment =
  | { readonly kind: 'text'; readonly value: string }
  | {
      readonly kind: 'wikilink';
      readonly target: string;
      readonly label: string;
      readonly embedded: boolean;
    };

/**
 * 把纯文本切成「普通文本 / 双链」片段，供阅读模式渲染。
 * 与 extractWikiLinks 共用同一正则与转义规则；转义片段整体保留为文本。
 */
export function splitWikiLinks(text: string): readonly WikiLinkSegment[] {
  const segments: WikiLinkSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(WIKILINK_RE)) {
    const start = match.index ?? 0;
    if (start > 0 && text[start - 1] === '\\') continue;
    const inner: string = match[2] ?? '';
    const pipe = inner.indexOf('|');
    const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
    if (target.length === 0) continue;
    if (start > cursor) segments.push({ kind: 'text', value: text.slice(cursor, start) });
    const aliasRaw = pipe === -1 ? '' : inner.slice(pipe + 1).trim();
    segments.push(
      Object.freeze({
        kind: 'wikilink',
        target,
        label: aliasRaw.length > 0 ? aliasRaw : target,
        embedded: match[1] === '!',
      }),
    );
    cursor = start + match[0].length;
  }
  if (cursor < text.length) segments.push({ kind: 'text', value: text.slice(cursor) });
  return Object.freeze(segments);
}
