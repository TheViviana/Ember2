/**
 * 画布文档节点的阅读模式渲染（CR-20261120-34 M3）。
 *
 * - 复用 `markdown-preview-model` 的安全渲染模型，绝不写 `innerHTML`；
 * - raw HTML 按纯文本输出，链接不写 href（节点只读，不承担导航）；
 * - 公式在节点内降级为字面文本（KaTeX 只在阅读窗口渲染），避免画布内加载字体与重排；
 * - 纯转换函数 `previewBlocksToDomNodes` 可在 node 测试中直接断言，DOM 写入留给 `renderPreviewInto`。
 */
import { parseDocument } from '../../core/markdown.ts';
import { mediaUrlForPath } from '../../core/media-url.ts';
import {
  toPreviewBlocks,
  type PreviewBlock,
  type PreviewInline,
} from '../../editor/markdown-preview-model.ts';

/** 渲染中间表示：`tag === '#text'` 表示文本节点。 */
export interface PreviewDomNode {
  readonly tag: string;
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly children?: readonly PreviewDomNode[];
}

function textNode(value: string): PreviewDomNode {
  return { tag: '#text', text: value };
}

function element(
  tag: string,
  children: readonly PreviewDomNode[],
  attrs?: Readonly<Record<string, string>>,
): PreviewDomNode {
  return attrs === undefined ? { tag, children } : { tag, children, attrs };
}

function inlineNodes(nodes: readonly PreviewInline[]): PreviewDomNode[] {
  const out: PreviewDomNode[] = [];
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        out.push(textNode(node.value));
        break;
      case 'break':
        out.push(element('br', []));
        break;
      case 'strong':
      case 'emphasis':
      case 'delete': {
        const tag = node.kind === 'strong' ? 'strong' : node.kind === 'emphasis' ? 'em' : 'del';
        out.push(element(tag, inlineNodes(node.children)));
        break;
      }
      case 'code':
        out.push(element('code', [textNode(node.value)], { 'data-md': 'inline-code' }));
        break;
      case 'math':
        out.push(
          element('span', [textNode(`$${node.value}$`)], { 'data-md': 'math-inline' }),
        );
        break;
      case 'wikilink':
        out.push(
          element('span', [textNode(node.label)], {
            'data-md': 'wikilink',
            'data-wikilink-target': node.target,
            title: node.target,
          }),
        );
        break;
      case 'html':
        out.push(element('span', [textNode(node.value)], { 'data-md': 'raw-html' }));
        break;
      case 'literal':
        out.push(element('span', [textNode(node.value)], { 'data-md': 'literal' }));
        break;
      case 'media': {
        if (node.media !== 'image') {
          out.push(element('span', [textNode(node.label)], { 'data-md': 'media' }));
          break;
        }
        out.push(
          element('img', [], {
            src: mediaUrlForPath(node.path),
            alt: node.label,
            loading: 'lazy',
            draggable: 'false',
          }),
        );
        break;
      }
      case 'link':
        // 节点阅读模式不导航：只显示链接文字。
        out.push(element('span', inlineNodes(node.children), { 'data-md': 'link' }));
        break;
      default:
        break;
    }
  }
  return out;
}

function blockNode(block: PreviewBlock): PreviewDomNode | null {
  switch (block.kind) {
    case 'heading':
      return element(`h${block.depth}`, inlineNodes(block.children), { 'data-md': 'heading' });
    case 'paragraph':
      return element('p', inlineNodes(block.children));
    case 'code':
      return element(
        'pre',
        [element('code', [textNode(block.value)])],
        block.language === null
          ? { 'data-md': 'code' }
          : { 'data-md': 'code', 'data-language': block.language },
      );
    case 'math':
      return element('div', [textNode(`$$${block.value}$$`)], { 'data-md': 'math-block' });
    case 'blockquote': {
      const children = blockNodes(block.children);
      return element('blockquote', children);
    }
    case 'list': {
      const items = block.items.map((itemBlocks, index) => {
        const checked = block.itemChecked[index] ?? null;
        const children: PreviewDomNode[] = [];
        if (checked !== null) {
          children.push(
            element('input', [], {
              type: 'checkbox',
              disabled: '',
              ...(checked ? { checked: '' } : {}),
            }),
          );
        }
        children.push(...blockNodes(itemBlocks));
        return element('li', children, checked === null ? undefined : { 'data-md': 'task-item' });
      });
      if (block.ordered) {
        return element(
          'ol',
          items,
          block.start === 1 ? { 'data-md': 'list' } : { 'data-md': 'list', start: String(block.start) },
        );
      }
      return element('ul', items, { 'data-md': 'list' });
    }
    case 'thematicBreak':
      return element('hr', []);
    case 'html':
      // 安全口径：raw HTML 一律按纯文本展示，不解析标签。
      return element('pre', [element('code', [textNode(block.value)])], {
        'data-md': 'raw-html-block',
      });
    case 'table': {
      const header = element(
        'tr',
        block.header.map((cell, cellIndex) =>
          element('th', inlineNodes(cell), alignAttr(block.align[cellIndex] ?? null)),
        ),
      );
      const rows = block.rows.map((row) =>
        element(
          'tr',
          row.map((cell, cellIndex) =>
            element('td', inlineNodes(cell), alignAttr(block.align[cellIndex] ?? null)),
          ),
        ),
      );
      return element(
        'table',
        [element('thead', [header]), element('tbody', rows)],
        { 'data-md': 'table' },
      );
    }
    default:
      return null;
  }
}

function alignAttr(align: 'left' | 'right' | 'center' | null): Readonly<Record<string, string>> | undefined {
  return align === null ? undefined : { style: `text-align: ${align}` };
}

function blockNodes(blocks: readonly PreviewBlock[]): PreviewDomNode[] {
  const out: PreviewDomNode[] = [];
  for (const block of blocks) {
    const node = blockNode(block);
    if (node !== null) out.push(node);
  }
  return out;
}

/** 纯转换：正文 → 节点 DOM 树（测试入口）。 */
export function previewBlocksToDomNodes(blocks: readonly PreviewBlock[]): readonly PreviewDomNode[] {
  return blockNodes(blocks);
}

/** 正文 → 节点 DOM 树（含 frontmatter 剥离）。 */
export function previewTextToDomNodes(text: string): readonly PreviewDomNode[] {
  return previewBlocksToDomNodes(toPreviewBlocks(parseDocument(text).tree));
}

function appendNode(parent: Node, node: PreviewDomNode): void {
  if (node.tag === '#text') {
    parent.appendChild(document.createTextNode(node.text ?? ''));
    return;
  }
  const el = document.createElement(node.tag);
  if (node.attrs !== undefined) {
    for (const [name, value] of Object.entries(node.attrs)) {
      el.setAttribute(name, value);
    }
  }
  for (const child of node.children ?? []) appendNode(el, child);
  parent.appendChild(el);
}

const CJK_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/g;
const LATIN_CHAR_RE = /[A-Za-z]/g;

/**
 * CR-20261121-56：预览语种判定（首屏采样，CJK 多于拉丁字母 → zh）。
 * 中英混排以占多数者为准；空文本按 zh（默认中文排版）。
 */
export function detectPreviewLang(text: string): 'zh' | 'en' {
  const sample = text.slice(0, 2000);
  const cjk = (sample.match(CJK_CHAR_RE) ?? []).length;
  const latin = (sample.match(LATIN_CHAR_RE) ?? []).length;
  // 并列（含空文本）按 zh：默认中文排版档。
  return cjk >= latin ? 'zh' : 'en';
}

/** 把正文渲染进容器（清空旧内容后重建；data-lang 驱动中英两套排版档）。 */
export function renderPreviewInto(container: HTMLElement, text: string): void {
  const nodes = previewTextToDomNodes(text);
  container.textContent = '';
  container.setAttribute('data-lang', detectPreviewLang(text));
  for (const node of nodes) appendNode(container, node);
}

/** 引擎注入 node-layer 的渲染器；一次创建长期复用。 */
export function createDocPreviewRenderer(): (container: HTMLElement, text: string) => void {
  return renderPreviewInto;
}
