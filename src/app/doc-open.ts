/**
 * CR-R2-3：打开库内文档的唯一闸门。
 *
 * 各入口只提供索引命中判定、改名别名解析、开窗与未命中提示；
 * 「解析 effectivePath → 查索引 → 打开/提示」的判定顺序在此单源实现。
 */
import { classifyDocLink } from './canvas/canvas-interactions.ts';

export interface OpenLibraryDocumentDeps {
  readonly hasDoc: (path: string) => boolean;
  readonly resolveDocPath: (from: string) => string | null;
  readonly open: (path: string) => void;
  readonly onMissing: (path: string) => void;
}

export type OpenLibraryDocumentResult = 'opened' | 'missing';

export function openLibraryDocument(
  rawPath: string,
  deps: OpenLibraryDocumentDeps,
): OpenLibraryDocumentResult {
  const link = classifyDocLink(rawPath, deps.resolveDocPath, deps.hasDoc);
  if (link.kind === 'ok') {
    deps.open(link.effectivePath);
    return 'opened';
  }
  deps.onMissing(link.kind === 'unbound' ? rawPath : link.effectivePath);
  return 'missing';
}
