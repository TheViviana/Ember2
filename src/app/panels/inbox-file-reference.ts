import type { EditorFileReference } from '../../editor/host.ts';
import { illegalSegment } from '../../core/path-segments.ts';
import { mediaKindFromLibraryPath } from '../dnd/finder-paths.ts';

function safeSegments(path: string): boolean {
  return path !== '' && illegalSegment(path) === null;
}

/** 只把收集箱路径解析为当前库内、可安全引用的文档或媒体。 */
export function resolveInboxFileReference(
  sourcePath: string,
  libraryRoot: string | null,
  hasDoc: (relativePath: string) => boolean,
): EditorFileReference | null {
  if (libraryRoot === null || libraryRoot === '') return null;
  const source = sourcePath.replace(/\\/g, '/');
  const root = libraryRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const prefix = `${root}/`;
  const relative = source.startsWith(prefix)
    ? source.slice(prefix.length)
    : source.startsWith('/')
      ? null
      : source;
  if (relative === null || !safeSegments(relative)) return null;
  if (relative.toLowerCase().endsWith('.md')) {
    return hasDoc(relative) ? { kind: 'doc', path: relative } : null;
  }
  if (!relative.startsWith('media/') || mediaKindFromLibraryPath(relative) === null) return null;
  return { kind: 'media', path: relative };
}
