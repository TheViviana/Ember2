/**
 * CR-R1-6：媒体判型唯一实现——库内「宽表」与 Finder「严格四容器」并列保留，不合并。
 */

/** 库内媒体宽表（只此一份）。 */
export const LIBRARY_IMAGE_EXTENSIONS: readonly string[] = Object.freeze([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'heic',
]);
export const LIBRARY_AUDIO_EXTENSIONS: readonly string[] = Object.freeze([
  'mp3', 'wav', 'flac', 'm4a', 'ogg',
]);
export const LIBRARY_VIDEO_EXTENSIONS: readonly string[] = Object.freeze([
  'mp4', 'mov', 'm4v', 'webm',
]);

/** Finder 拖入只认这四种容器（CR-20261119-25；真实类型仍由 media_save magic bytes 定）。 */
export const FINDER_CONTAINER_EXTENSIONS: readonly string[] = Object.freeze([
  'mp3', 'm4a', 'mp4', 'mov',
]);

/** 取路径最后一段；同时兼容 Windows 反斜杠。 */
export function fileNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return base === '' ? normalized : base;
}

/** 取小写扩展名；无扩展名或隐藏文件（如 `.md`）返回空串。 */
export function extensionFromPath(path: string): string {
  const base = fileNameFromPath(path);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

export type LibraryMediaKind = 'image' | 'audio' | 'video' | 'doc';

/**
 * 库内媒体相对路径 → kind：先按 `media/image|audio|video|doc/` 前缀，
 * 再按宽表兜底；无法判定返回 `null`，由调用方显式提示。
 */
export function libraryMediaKind(path: string): LibraryMediaKind | null {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  if (normalized.startsWith('media/image/')) return 'image';
  if (normalized.startsWith('media/audio/')) return 'audio';
  if (normalized.startsWith('media/video/')) return 'video';
  if (normalized.startsWith('media/doc/')) return 'doc';

  const extension = extensionFromPath(normalized);
  if (LIBRARY_IMAGE_EXTENSIONS.includes(extension)) return 'image';
  if (LIBRARY_AUDIO_EXTENSIONS.includes(extension)) return 'audio';
  if (LIBRARY_VIDEO_EXTENSIONS.includes(extension)) return 'video';
  return null;
}
