/**
 * 反向链接索引（按需建立）。
 *
 * 纯函数：输入全库文档文本，输出「目标文档 → 引用来源」；不 invoke、不缓存文件。
 * 目标是让用户主动触发时才全库读取，未建立索引时 UI 明确提示不完整。
 */
import { extractWikiLinks, parseDocument, parseFrontmatter } from '#doc-model';
import { posixBaseName, posixParentDir } from './path-utils.ts';

export interface LinkSource {
  readonly path: string;
  readonly sha256: string;
  readonly text: string;
}

export interface LinkIndexEntry {
  readonly path: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly targets: readonly string[];
}

export interface LinkIndex {
  readonly entries: ReadonlyMap<string, LinkIndexEntry>;
  /** 仅包含至少一条入链的文档路径。 */
  readonly backlinks: ReadonlyMap<string, readonly LinkIndexEntry[]>;
  readonly sourceCount: number;
}

const MARKDOWN_EXT_RE = /\.md$/i;

function stripExtension(path: string): string {
  return path.replace(MARKDOWN_EXT_RE, '');
}

function normalizeTarget(raw: string): string {
  const withoutAnchor = raw.split('#')[0] ?? '';
  return stripExtension(withoutAnchor.trim().replace(/^\/+/, ''));
}

function directoryOf(path: string): string {
  return posixParentDir(path);
}

function resolveRelative(sourcePath: string, target: string): string {
  if (target.startsWith('/')) return target.replace(/^\/+/, '');
  const segments = [...directoryOf(sourcePath).split('/'), ...target.split('/')];
  const stack: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join('/');
}

function basenameOf(path: string): string {
  return posixBaseName(stripExtension(path));
}

function pushUnique<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list === undefined) {
    map.set(key, [value]);
    return;
  }
  if (!list.includes(value)) list.push(value);
}

export function buildLinkIndex(sources: readonly LinkSource[]): LinkIndex {
  const entries = new Map<string, LinkIndexEntry>();
  const byKey = new Map<string, LinkIndexEntry>();
  const byBasename = new Map<string, LinkIndexEntry[]>();
  const byAlias = new Map<string, LinkIndexEntry[]>();

  for (const source of sources) {
    const frontmatter = parseFrontmatter(source.text).frontmatter;
    const title = frontmatter?.title ?? basenameOf(source.path);
    const aliases = frontmatter?.aliases ?? [];
    const targets = extractWikiLinks(parseDocument(source.text).body).map((link) => link.target);
    const entry: LinkIndexEntry = Object.freeze({
      path: source.path,
      title,
      aliases: Object.freeze([...aliases]),
      targets: Object.freeze(targets),
    });
    entries.set(source.path, entry);
    byKey.set(stripExtension(source.path).toLowerCase(), entry);
    pushUnique(byBasename, basenameOf(source.path).toLowerCase(), entry);
    for (const alias of [title, ...aliases]) {
      const key = alias.trim().toLowerCase();
      if (key !== '') pushUnique(byAlias, key, entry);
    }
  }

  const backlinks = new Map<string, LinkIndexEntry[]>();
  for (const entry of entries.values()) {
    for (const rawTarget of entry.targets) {
      const target = normalizeTarget(rawTarget);
      if (target === '') continue;
      const matches = new Set<LinkIndexEntry>();
      if (target.includes('/')) {
        const absolute = resolveRelative(entry.path, target);
        const exact = byKey.get(absolute.toLowerCase());
        if (exact !== undefined) matches.add(exact);
      } else {
        for (const candidate of byBasename.get(target.toLowerCase()) ?? []) matches.add(candidate);
      }
      for (const candidate of byAlias.get(target.toLowerCase()) ?? []) matches.add(candidate);
      for (const targetEntry of matches) {
        if (targetEntry.path === entry.path) continue;
        pushUnique(backlinks, targetEntry.path, entry);
      }
    }
  }

  const frozenBacklinks = new Map<string, readonly LinkIndexEntry[]>();
  for (const [path, list] of backlinks) {
    frozenBacklinks.set(path, Object.freeze([...list].sort((a, b) => a.path.localeCompare(b.path))));
  }
  return Object.freeze({
    entries,
    backlinks: frozenBacklinks,
    sourceCount: sources.length,
  });
}

export function backlinksOf(index: LinkIndex, path: string): readonly LinkIndexEntry[] {
  return index.backlinks.get(path) ?? [];
}
