/**
 * P6-C1-C：Finder 原生拖入的路径分流（纯逻辑，不碰 DOM / React / IPC）。
 *
 * Finder 拖入走 Tauri 原生通道，`paths` 是文件系统绝对路径，不存在 `dataTransfer`。
 * 这里只负责按扩展名判定可处理类型；实际入库（`media_save`）与建节点由调用方完成。
 * 扩展名判定只做「要不要交给 media_save」的分流，媒体最终类型仍由 Rust magic bytes 决定。
 */

import {
  FINDER_CONTAINER_EXTENSIONS,
  extensionFromPath,
  fileNameFromPath,
  libraryMediaKind,
} from '../../core/media-kind.ts';

export type FinderPathKind = 'doc' | 'image' | 'audio' | 'video' | 'attachment' | 'other';

export { extensionFromPath, fileNameFromPath, libraryMediaKind as mediaKindFromLibraryPath };
export type { LibraryMediaKind } from '../../core/media-kind.ts';

const MARKDOWN_EXTENSION = 'md';

/** CR-20261120-26：只读附件严格白名单（PDF/HTML；docx/Office 不做）。 */
const ATTACHMENT_EXTENSIONS: readonly string[] = ['pdf', 'html', 'htm'];

/**
 * `.md` → doc；图片扩展名 → image；**严格四容器 mp3/m4a/mp4/mov → audio/video**
 * （CR-20261119-25；扩展名大小写不敏感；真实类型由 `media_save` 的 magic bytes 定，
 * 扩展名与内容不符按单项失败提示，不中断同批其它文件）；其余一律 other
 * （wav/flac/ogg/m4v/webm 等维持 other——其他格式不新增，现有额外媒体格式保留）。
 */
export function finderPathKind(path: string): FinderPathKind {
  const extension = extensionFromPath(path);
  if (extension === MARKDOWN_EXTENSION) return 'doc';
  if (libraryMediaKind(path) === 'image') return 'image';
  if (FINDER_CONTAINER_EXTENSIONS.includes(extension)) {
    return extension === 'mp3' || extension === 'm4a' ? 'audio' : 'video';
  }
  if (ATTACHMENT_EXTENSIONS.includes(extension)) return 'attachment';
  return 'other';
}

export interface FinderPathGroups {
  readonly docs: readonly string[];
  readonly images: readonly string[];
  readonly audios: readonly string[];
  readonly videos: readonly string[];
  readonly attachments: readonly string[];
  readonly others: readonly string[];
}

/** 按输入顺序分组，不重排、不去重（落点提示按原顺序给出）。 */
export function groupFinderPaths(paths: readonly string[]): FinderPathGroups {
  const docs: string[] = [];
  const images: string[] = [];
  const audios: string[] = [];
  const attachments: string[] = [];
  const videos: string[] = [];
  const others: string[] = [];
  for (const path of paths) {
    switch (finderPathKind(path)) {
      case 'doc':
        docs.push(path);
        break;
      case 'image':
        images.push(path);
        break;
      case 'audio':
        audios.push(path);
        break;
      case 'video':
        videos.push(path);
        break;
      case 'attachment':
        attachments.push(path);
        break;
      default:
        others.push(path);
        break;
    }
  }
  return { docs, images, audios, videos, attachments, others };
}

/**
 * 库内媒体相对路径 → 媒体 kind：实现在 `src/core/media-kind.ts`，
 * 此处仅按旧名转出，保持 app 侧调用点不变。
 */
