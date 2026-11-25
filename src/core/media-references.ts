/**
 * 从 Markdown 原文提取安全的库内媒体引用（P6 B5）。
 *
 * 只接受 `media/image|audio|video/...` 相对路径；代码块/行内代码由 mdast 解析，
 * 其内容不会是 image/link 节点，因此天然不产生可替换范围。offset 均为相对完整
 * 文档原文的 UTF-16 位置，end 不包含在范围内。
 */
import { parseDocument } from '#doc-model';
import type { Image, Link, Root, RootContent } from 'mdast';
import { illegalSegment } from './path-segments.ts';

export interface MediaReference {
  readonly kind: 'image' | 'audio' | 'video';
  readonly path: string;
  readonly label: string;
  readonly from: number;
  readonly to: number;
}

interface MediaTarget {
  readonly kind: 'image' | 'audio' | 'video';
  readonly path: string;
}

const MEDIA_PATH_RE = /^media\/(image|audio|video)\//;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** URL → 安全库内媒体路径；拒绝绝对地址、scheme、反斜杠、空段与 `..` 逃逸。 */
export function mediaTargetForUrl(url: string): MediaTarget | null {
  if (url === '' || url.includes('\\') || url.startsWith('/') || url.startsWith('#')) return null;
  if (SCHEME_RE.test(url) || url.includes('?') || url.includes('#')) return null;
  if (illegalSegment(url) !== null) return null;
  const match = MEDIA_PATH_RE.exec(url);
  if (match === null) return null;
  return { kind: match[1] as MediaTarget['kind'], path: url };
}

function labelFromPath(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name === '' ? path : name;
}

function textContent(node: RootContent | Image | Link): string {
  if ('value' in node) return node.value;
  if ('alt' in node && typeof node.alt === 'string') return node.alt;
  if ('children' in node) {
    return node.children
      .map((child) => ('value' in child ? child.value : ''))
      .join('');
  }
  return '';
}

/** 遍历 mdast，输出不与前面范围重叠的媒体引用，按 from 升序。 */
export function readMediaReferences(text: string): readonly MediaReference[] {
  const parsed = parseDocument(text);
  const bodyStart = text.length - parsed.body.length;
  const references: MediaReference[] = [];

  const visit = (node: Root | RootContent): void => {
    if (node.type === 'image' || node.type === 'link') {
      const target = mediaTargetForUrl(node.url);
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (target !== null && start !== undefined && end !== undefined && end > start) {
        references.push({
          kind: target.kind,
          path: target.path,
          label: textContent(node) === '' ? labelFromPath(target.path) : textContent(node),
          from: bodyStart + start,
          to: bodyStart + end,
        });
      }
      // 链接可能包裹图片：继续下钻，重叠范围由后面的 accepted 去重裁剪。
      if (node.type === 'image') return;
    }
    if ('children' in node) {
      for (const child of node.children) visit(child);
    }
  };
  visit(parsed.tree);

  const sorted = references.sort((a, b) => a.from - b.from || a.to - b.to);
  const accepted: MediaReference[] = [];
  let lastEnd = -1;
  for (const reference of sorted) {
    if (reference.from < lastEnd) continue;
    accepted.push(reference);
    lastEnd = reference.to;
  }
  return accepted;
}
