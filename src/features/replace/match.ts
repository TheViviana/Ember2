import {
  readDocumentSource,
  type DocumentSource,
  type DocumentSourceKind,
  type DocumentSourceRange,
} from '../../core/document-source.ts';

export interface MatchScopes {
  readonly title: boolean;
  readonly body: boolean;
  readonly tags: boolean;
}

export interface MatchContext {
  readonly before: string;
  readonly match: string;
  readonly after: string;
}

export interface DocumentMatch {
  readonly kind: DocumentSourceKind;
  readonly range: DocumentSourceRange;
  readonly context: MatchContext;
}

export interface MatchPreview {
  readonly before: string;
  readonly replacement: string;
  readonly after: string;
}

const PRIORITY: readonly DocumentSourceKind[] = ['title', 'tags', 'body'];

function contextAt(text: string, start: number, end: number): MatchContext {
  const lineStart = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const nextLine = text.indexOf('\n', end);
  const lineEnd = nextLine < 0 ? text.length : nextLine;
  return Object.freeze({
    before: text.slice(lineStart, start),
    match: text.slice(start, end),
    after: text.slice(end, lineEnd),
  });
}

function enabled(scopes: MatchScopes, kind: DocumentSourceKind): boolean {
  return scopes[kind];
}

/** 字面量、大小写敏感、非重叠；标题回退 H1 与正文重叠时按 title → tags → body 去重。 */
export function matchDocumentSource(
  source: DocumentSource,
  query: string,
  scopes: MatchScopes,
): readonly DocumentMatch[] {
  if (query.length === 0 || !PRIORITY.some((kind) => enabled(scopes, kind))) return [];
  const byOffset = new Map<number, DocumentMatch>();
  for (const kind of PRIORITY) {
    if (!enabled(scopes, kind)) continue;
    for (const range of source.ranges) {
      if (range.kind !== kind) continue;
      let offset = range.start;
      while (offset <= range.end - query.length) {
        const found = source.text.indexOf(query, offset);
        if (found < 0 || found + query.length > range.end) break;
        const end = found + query.length;
        if (!byOffset.has(found)) {
          byOffset.set(found, Object.freeze({
            kind,
            range: Object.freeze({ ...range, start: found, end }),
            context: contextAt(source.text, found, end),
          }));
        }
        offset = end;
      }
    }
  }
  return Object.freeze([...byOffset.values()].sort((a, b) => a.range.start - b.range.start));
}

export function findDocumentMatches(
  text: string,
  query: string,
  scopes: MatchScopes,
): readonly DocumentMatch[] {
  return matchDocumentSource(readDocumentSource(text), query, scopes);
}

export function previewDocumentMatch(match: DocumentMatch, replacement: string): MatchPreview {
  return Object.freeze({
    before: match.context.before,
    replacement,
    after: match.context.after,
  });
}
