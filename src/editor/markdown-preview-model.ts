/**
 * CR-20261120-34：Markdown 安全预览的 AST → 渲染模型（纯函数，零 React）。
 *
 * 规则：
 * - 只消费 `#doc-model` 已解析出的 mdast，不引入 HTML 管线；
 * - raw HTML 节点一律保留为文本（`html`），由渲染层按纯文本转义输出；
 * - 图片/音视频只接受库内 `media/` 引用（`mediaTargetForUrl`），其余按字面文本；
 * - 链接不在本层判定可打开性，只给出 URL，由 `classifyPreviewUrl` +
 *   `resolveInternalDocPath` 供渲染层决定是否可点。
 */
import type { PhrasingContent, Root, RootContent } from 'mdast';
import { mediaTargetForUrl } from '../core/media-references.ts';
import { splitWikiLinks } from '../core/markdown.ts';

export type PreviewMediaKind = 'image' | 'audio' | 'video';

export type PreviewInline =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'break' }
  | {
      readonly kind: 'strong' | 'emphasis' | 'delete';
      readonly children: readonly PreviewInline[];
    }
  | { readonly kind: 'code'; readonly value: string }
  | {
      readonly kind: 'math';
      readonly value: string;
      /** 行内公式为 false，块级公式为 true（块级单独成块，此字段仅行内使用）。 */
      readonly display: boolean;
    }
  | {
      readonly kind: 'wikilink';
      readonly target: string;
      readonly label: string;
      readonly embedded: boolean;
    }
  | {
      readonly kind: 'link';
      readonly url: string;
      readonly title: string | null;
      readonly children: readonly PreviewInline[];
    }
  | {
      readonly kind: 'media';
      readonly media: PreviewMediaKind;
      readonly path: string;
      readonly label: string;
    }
  /** raw HTML：渲染层必须按纯文本输出，绝不解码为 DOM。 */
  | { readonly kind: 'html'; readonly value: string }
  /** 非库内图片等无法安全呈现的内容：按字面文本输出。 */
  | { readonly kind: 'literal'; readonly value: string };

export type PreviewAlign = 'left' | 'right' | 'center' | null;

/** 正文（已去 frontmatter）中的 UTF-16 偏移；用于阅读模式选段定位。 */
export interface PreviewBlockPosition {
  readonly start: number;
  readonly end: number;
}

type PreviewBlockBody =
  | {
      readonly kind: 'heading';
      readonly depth: 1 | 2 | 3 | 4 | 5 | 6;
      readonly children: readonly PreviewInline[];
    }
  | { readonly kind: 'paragraph'; readonly children: readonly PreviewInline[] }
  | { readonly kind: 'code'; readonly language: string | null; readonly value: string }
  | { readonly kind: 'math'; readonly value: string }
  | { readonly kind: 'blockquote'; readonly children: readonly PreviewBlock[] }
  | {
      readonly kind: 'list';
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly (readonly PreviewBlock[])[];
      /** 与 items 等长；任务列表项为 true/false，普通项为 null。 */
      readonly itemChecked: readonly (boolean | null)[];
    }
  | { readonly kind: 'thematicBreak' }
  | { readonly kind: 'html'; readonly value: string }
  | {
      readonly kind: 'table';
      readonly align: readonly PreviewAlign[];
      readonly header: readonly (readonly PreviewInline[])[];
      readonly rows: readonly (readonly PreviewInline[])[][];
    };

export type PreviewBlock = PreviewBlockBody & { readonly position?: PreviewBlockPosition };

function textOfInline(nodes: readonly PreviewInline[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case 'text':
        case 'code':
        case 'literal':
        case 'html':
          return node.value;
        case 'math':
          return node.value;
        case 'wikilink':
          return node.label;
        case 'media':
          return node.label;
        case 'break':
          return '\n';
        default:
          return textOfInline(node.children);
      }
    })
    .join('');
}

function mediaInline(url: string, label: string): PreviewInline | null {
  const target = mediaTargetForUrl(url);
  if (target === null) return null;
  return {
    kind: 'media',
    media: target.kind,
    path: target.path,
    label: label === '' ? labelFromPath(target.path) : label,
  };
}

function labelFromPath(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name === '' ? path : name;
}

function splitWikilinkInline(value: string): PreviewInline[] {
  if (!value.includes('[[')) return [{ kind: 'text', value }];
  return splitWikiLinks(value).map((segment) => (
    segment.kind === 'text'
      ? { kind: 'text' as const, value: segment.value }
      : {
          kind: 'wikilink' as const,
          target: segment.target,
          label: segment.label,
          embedded: segment.embedded,
        }
  ));
}

function toInline(node: PhrasingContent): PreviewInline[] {
  // remark-math 的 inlineMath 不在 mdast 的 PhrasingContent 联合里，按扩展节点读取。
  if ((node as unknown as { type: string }).type === 'inlineMath') {
    const value = (node as unknown as { value?: string }).value ?? '';
    return [{ kind: 'math', value, display: false }];
  }
  switch (node.type) {
    case 'text':
      return splitWikilinkInline(node.value);
    case 'break':
      return [{ kind: 'break' }];
    case 'inlineCode':
      return [{ kind: 'code', value: node.value }];
    case 'html':
      return [{ kind: 'html', value: node.value }];
    case 'strong':
      return [{ kind: 'strong', children: inlineList(node.children) }];
    case 'emphasis':
      return [{ kind: 'emphasis', children: inlineList(node.children) }];
    case 'delete':
      return [{ kind: 'delete', children: inlineList(node.children) }];
    case 'image': {
      const media = mediaInline(node.url, node.alt ?? '');
      if (media !== null) return [media];
      return [{ kind: 'literal', value: node.alt === null || node.alt === undefined || node.alt === '' ? node.url : node.alt }];
    }
    case 'link': {
      const children = inlineList(node.children);
      // 音视频库内引用直接渲染控件；图片仍按普通链接文本展示，避免误判尺寸。
      const media = mediaInline(node.url, textOfInline(children));
      if (media !== null && media.kind === 'media' && media.media !== 'image') return [media];
      return [
        {
          kind: 'link',
          url: node.url,
          title: typeof node.title === 'string' ? node.title : null,
          children,
        },
      ];
    }
    default:
      return [];
  }
}

function inlineList(nodes: readonly PhrasingContent[]): readonly PreviewInline[] {
  const out: PreviewInline[] = [];
  for (const node of nodes) out.push(...toInline(node));
  return out;
}

function toBlocks(nodes: readonly RootContent[]): readonly PreviewBlock[] {
  const out: PreviewBlock[] = [];
  for (const node of nodes) out.push(...toBlock(node));
  return out;
}

function positionOf(node: RootContent): PreviewBlockPosition | undefined {
  const position = (node as unknown as {
    position?: { start?: { offset?: number }; end?: { offset?: number } };
  }).position;
  const start = position?.start?.offset;
  const end = position?.end?.offset;
  if (typeof start !== 'number' || typeof end !== 'number') return undefined;
  return { start, end };
}

function toBlock(node: RootContent): readonly PreviewBlock[] {
  const blocks = toBlockBody(node);
  const position = positionOf(node);
  if (position === undefined) return blocks;
  return blocks.map((block) => ({ ...block, position }));
}

function toBlockBody(node: RootContent): readonly PreviewBlock[] {
  // remark-math 的块级 math 不在 mdast 的 RootContent 联合里，按扩展节点读取。
  if ((node as unknown as { type: string }).type === 'math') {
    const value = (node as unknown as { value?: string }).value ?? '';
    return [{ kind: 'math', value }];
  }
  switch (node.type) {
    case 'paragraph':
      return [{ kind: 'paragraph', children: inlineList(node.children) }];
    case 'heading':
      return [
        {
          kind: 'heading',
          depth: node.depth,
          children: inlineList(node.children),
        },
      ];
    case 'code':
      return [
        {
          kind: 'code',
          language: node.lang === null || node.lang === undefined || node.lang === '' ? null : node.lang,
          value: node.value,
        },
      ];
    case 'blockquote':
      return [{ kind: 'blockquote', children: toBlocks(node.children) }];
    case 'list': {
      const items = node.children.map((item) => toBlocks(item.children));
      const itemChecked = node.children.map((item) => {
        const checked = (item as unknown as { checked?: boolean | null }).checked;
        return typeof checked === 'boolean' ? checked : null;
      });
      return [
        {
          kind: 'list',
          ordered: node.ordered === true,
          start: node.ordered === true && typeof node.start === 'number' ? node.start : 1,
          items,
          itemChecked,
        },
      ];
    }
    case 'thematicBreak':
      return [{ kind: 'thematicBreak' }];
    case 'html':
      return [{ kind: 'html', value: node.value }];
    case 'table': {
      const align = node.align ?? [];
      return [
        {
          kind: 'table',
          align,
          header: node.children[0]?.children.map((cell) => inlineList(cell.children)) ?? [],
          rows: node.children.slice(1).map((row) => row.children.map((cell) => inlineList(cell.children))),
        },
      ];
    }
    case 'definition':
    case 'footnoteDefinition':
    case 'yaml':
      return [];
    default: {
      // 未知容器节点：有子节点就继续下钻；有字面值就降级为段落文本。
      if ('children' in node && Array.isArray(node.children)) {
        return toBlocks(node.children);
      }
      if ('value' in node && typeof node.value === 'string') {
        return [{ kind: 'paragraph', children: [{ kind: 'text', value: node.value }] }];
      }
      return [];
    }
  }
}

export function toPreviewBlocks(tree: Root): readonly PreviewBlock[] {
  return toBlocks(tree.children);
}

/** 链接可打开性判定：unsafe 必须按纯文本渲染，不得写 href。 */
export type PreviewUrlKind = 'anchor' | 'internal' | 'external' | 'unsafe';

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export function classifyPreviewUrl(url: string): PreviewUrlKind {
  const trimmed = url.trim();
  if (trimmed.startsWith('#')) return 'anchor';
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('vbscript:') || lower.startsWith('data:')) {
    return 'unsafe';
  }
  if (lower.startsWith('//') || SCHEME_RE.test(trimmed)) return 'external';
  return 'internal';
}

/**
 * 库内相对链接 → 目标文档路径（基于当前文档目录）；越出库根返回 null。
 * 查询串与锚点被丢弃；URL 编码按段解码，非法编码保留原文。
 */
export function resolveInternalDocPath(fromDocPath: string, url: string): string | null {
  const withoutHash = url.split('#')[0] ?? '';
  const withoutQuery = withoutHash.split('?')[0] ?? '';
  if (withoutQuery === '') return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    decoded = withoutQuery;
  }

  const from = fromDocPath.replace(/\\/g, '/');
  const base = from.split('/').slice(0, -1);
  const raw = decoded.replace(/\\/g, '/');
  const segments = raw.startsWith('/') ? raw.slice(1).split('/') : [...base, ...raw.split('/')];

  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.length === 0 ? null : out.join('/');
}
