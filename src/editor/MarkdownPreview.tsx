/**
 * CR-20261120-34：Markdown 安全预览渲染层。
 *
 * 只把 `markdown-preview-model` 的渲染模型映射为 React 元素：
 * - raw HTML 以文本节点输出，React 自动转义，不写 `dangerouslySetInnerHTML`；
 * - 库内媒体走 `media://` 只读协议；
 * - 内链按当前文档目录解析后交给 `onOpenInternalLink`，外链只显示文本。
 */
import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { parseDocument, parseFrontmatter } from '../core/markdown.ts';
import { splitTranslateParagraphs } from '../core/translate-segments.ts';
import { mediaUrlForPath } from '../core/media-url.ts';
import {
  classifyPreviewUrl,
  resolveInternalDocPath,
  toPreviewBlocks,
  type PreviewBlock,
  type PreviewInline,
} from './markdown-preview-model.ts';
import styles from './MarkdownPreview.module.css';

export interface MarkdownPreviewProps {
  readonly text: string;
  /** 当前文档库内相对路径，用于解析相对链接。 */
  readonly docPath: string;
  readonly onOpenInternalLink?: (path: string) => void;
  /** 对照翻译状态：segments 按段落序号内联到对应原文下方（CR-20261121-43）。 */
  readonly translation?: PreviewTranslation | null;
  /** 正文是否启用衬线；译文取相反字族，避免正文与译文同字族导致层次不清。 */
  readonly articleSerif?: boolean;
}

/** 译文展示状态（与 translate-store 的状态同名，editor 层不依赖 app 层类型）。 */
export type PreviewTranslationStatus = 'idle' | 'streaming' | 'done' | 'error' | 'cancelled';

export interface PreviewTranslation {
  readonly status: PreviewTranslationStatus;
  /** 对照翻译段（CR-20261121-42/43）：按段落序号内联到对应原文下方。 */
  readonly segments?: ReadonlyArray<{
    readonly index: number;
    readonly source: string;
    readonly text: string;
  }>;
  /** 分段进度（CR-20261120-40）：两模式都有值，驱动「翻译」按钮后的 N/M 计数徽标。 */
  readonly progress?: { readonly done: number; readonly total: number } | null;
  /** 2026-11-23：失败后可从失败段继续（AI 模式）。 */
  readonly canResume?: boolean;
}


/** 内链打开能力经 context 注入，避免模块级可变状态在 StrictMode 下串窗。 */
export interface InternalLinkOpener {
  readonly resolve: (url: string) => string | null;
  readonly open: (path: string) => void;
}

const OpenerContext = createContext<InternalLinkOpener | null>(null);

function renderInline(nodes: readonly PreviewInline[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (node.kind) {
      case 'text':
        return <span key={key}>{node.value}</span>;
      case 'break':
        return <br key={key} />;
      case 'strong':
        return <strong key={key}>{renderInline(node.children, key)}</strong>;
      case 'emphasis':
        return <em key={key}>{renderInline(node.children, key)}</em>;
      case 'delete':
        return <del key={key}>{renderInline(node.children, key)}</del>;
      case 'code':
        return (
          <code key={key} className={styles.inlineCode}>
            {node.value}
          </code>
        );
      case 'math':
        return <MathInline key={key} value={node.value} />;
      case 'wikilink':
        return <WikiLinkInline key={key} node={node} />;
      case 'html':
        return (
          <span key={key} className={styles.rawHtml} data-raw-html="true">
            {node.value}
          </span>
        );
      case 'literal':
        return (
          <span key={key} className={styles.literal}>
            {node.value}
          </span>
        );
      case 'media':
        return (
          <span key={key} className={styles.media}>
            {node.media === 'image' ? (
              <img
                className={styles.mediaElement}
                src={mediaUrlForPath(node.path)}
                alt={node.label}
                loading="lazy"
              />
            ) : node.media === 'audio' ? (
              <audio className={styles.audioElement} src={mediaUrlForPath(node.path)} controls preload="metadata" />
            ) : (
              <video
                className={styles.mediaElement}
                src={mediaUrlForPath(node.path)}
                controls
                preload="metadata"
                playsInline
              />
            )}
            <span className={styles.mediaLabel}>{node.label}</span>
          </span>
        );
      case 'link':
        return <PreviewLink key={key} node={node} keyPrefix={key} />;
      default:
        return null;
    }
  });
}

function MathInline({ value }: { readonly value: string }): ReactNode {
  const html = useMemo(
    () => katex.renderToString(value, { displayMode: false, throwOnError: false }),
    [value],
  );
  // KaTeX 输出由其自身转义；输入来自 mdast 公式节点，不包含 raw HTML。
  return <span className={styles.mathInline} dangerouslySetInnerHTML={{ __html: html }} />;
}

function MathBlock({ value }: { readonly value: string }): ReactNode {
  const html = useMemo(
    () => katex.renderToString(value, { displayMode: true, throwOnError: false }),
    [value],
  );
  return (
    <div className={styles.mathBlock} dangerouslySetInnerHTML={{ __html: html }} />
  );
}

function resolveWikiTarget(opener: InternalLinkOpener, target: string): string | null {
  const withoutAnchor = target.split('#')[0] ?? '';
  if (withoutAnchor === '') return null;
  const direct = opener.resolve(withoutAnchor);
  if (direct !== null) return direct;
  const trimmed = withoutAnchor.replace(/\/+$/, '');
  const lastSegment = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  if (lastSegment.includes('.')) return null;
  return opener.resolve(`${withoutAnchor}.md`);
}

function WikiLinkInline({
  node,
}: {
  readonly node: Extract<PreviewInline, { kind: 'wikilink' }>;
}): ReactNode {
  const opener = useContext(OpenerContext);
  if (opener === null) return <span className={styles.textLink}>{node.label}</span>;
  const target = resolveWikiTarget(opener, node.target);
  if (target === null) {
    return (
      <span className={styles.textLink} title={node.target}>
        {node.label}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={styles.internalLink}
      title={target}
      onClick={() => opener.open(target)}
    >
      {node.label}
    </button>
  );
}

function PreviewLink({
  node,
  keyPrefix,
}: {
  readonly node: Extract<PreviewInline, { kind: 'link' }>;
  readonly keyPrefix: string;
}): ReactNode {
  const kind = classifyPreviewUrl(node.url);
  const children = renderInline(node.children, keyPrefix);
  if (kind === 'external' || kind === 'anchor') {
    return (
      <span className={styles.textLink} title={node.url}>
        {children}
      </span>
    );
  }
  if (kind === 'unsafe') {
    // 危险协议只保留可见文本，绝不写入 href / 可点击通道。
    return <span>{children}</span>;
  }
  return <InternalLink url={node.url} title={node.title}>{children}</InternalLink>;
}

/**
 * 内链按钮：解析目标路径后交给宿主打开；宿主未提供回调时退化为纯文本。
 */
function InternalLink({
  url,
  title,
  children,
}: {
  readonly url: string;
  readonly title: string | null;
  readonly children: ReactNode;
}): ReactNode {
  const opener = useContext(OpenerContext);
  if (opener === null) return <span className={styles.textLink}>{children}</span>;
  const target = opener.resolve(url);
  if (target === null) return <span className={styles.textLink}>{children}</span>;
  return (
    <button
      type="button"
      className={styles.internalLink}
      title={title ?? target}
      onClick={() => opener.open(target)}
    >
      {children}
    </button>
  );
}

function renderBlock(block: PreviewBlock, index: number): ReactNode {
  const key = `block-${index}`;
  switch (block.kind) {
    case 'heading': {
      const Tag = `h${block.depth}` as const;
      return <Tag key={key} className={styles.heading}>{renderInline(block.children, key)}</Tag>;
    }
    case 'paragraph':
      return (
        <p key={key} className={styles.paragraph}>
          {renderInline(block.children, key)}
        </p>
      );
    case 'code':
      return (
        <pre key={key} className={styles.codeBlock} data-language={block.language ?? undefined}>
          <code>{block.value}</code>
        </pre>
      );
    case 'math':
      return <MathBlock key={key} value={block.value} />;
    case 'blockquote':
      return (
        <blockquote key={key} className={styles.blockquote}>
          {block.children.map((child, childIndex) => renderBlock(child, childIndex))}
        </blockquote>
      );
    case 'list': {
      const items = block.items.map((itemBlocks, itemIndex) => {
        const checked = block.itemChecked[itemIndex] ?? null;
        return (
          <li
            key={`${key}-item-${itemIndex}`}
            className={checked === null ? undefined : styles.taskItem}
          >
            {checked === null ? null : (
              <input
                type="checkbox"
                className={styles.taskCheckbox}
                checked={checked}
                readOnly
                disabled
                aria-label={checked ? '已完成' : '未完成'}
              />
            )}
            {itemBlocks.map((child, childIndex) => renderBlock(child, childIndex))}
          </li>
        );
      });
      return block.ordered ? (
        <ol key={key} className={styles.list} start={block.start === 1 ? undefined : block.start}>
          {items}
        </ol>
      ) : (
        <ul key={key} className={styles.list}>
          {items}
        </ul>
      );
    }
    case 'thematicBreak':
      return <hr key={key} className={styles.rule} />;
    case 'html':
      // 安全口径：raw HTML 一律按纯文本展示，不解析标签。
      return (
        <pre key={key} className={styles.rawHtmlBlock} data-raw-html="true">
          <code>{block.value}</code>
        </pre>
      );
    case 'table':
      return (
        <div key={key} className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                {block.header.map((cell, cellIndex) => (
                  <th key={`${key}-h-${cellIndex}`} style={{ textAlign: block.align[cellIndex] ?? undefined }}>
                    {renderInline(cell, `${key}-h-${cellIndex}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={`${key}-r-${rowIndex}`}>
                  {row.map((cell, cellIndex) => (
                    <td
                      key={`${key}-r-${rowIndex}-c-${cellIndex}`}
                      style={{ textAlign: block.align[cellIndex] ?? undefined }}
                    >
                      {renderInline(cell, `${key}-r-${rowIndex}-c-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return null;
  }
}

export function MarkdownPreview({
  text,
  docPath,
  onOpenInternalLink,
  translation,
  articleSerif = false,
}: MarkdownPreviewProps) {
  // 对照内联（CR-20261121-43）：正文按围栏感知空行分段，逐段渲染；
  // 每段的译文（按段落序号对位）直接附在该段原文下方，不集中成块、不自动滚屏。
  const body = useMemo(() => parseFrontmatter(text).body, [text]);
  const paragraphs = useMemo(() => splitTranslateParagraphs(body), [body]);
  const pairsByIndex = useMemo(() => {
    const map = new Map<number, Array<{ readonly source: string; readonly text: string }>>();
    for (const pair of translation?.segments ?? []) {
      const list = map.get(pair.index);
      if (list === undefined) {
        map.set(pair.index, [pair]);
      } else {
        list.push(pair);
      }
    }
    return map;
  }, [translation?.segments]);

  const opener = useMemo<InternalLinkOpener | null>(() => {
    if (onOpenInternalLink === undefined) return null;
    return {
      resolve: (url) => resolveInternalDocPath(docPath, url),
      open: (path) => onOpenInternalLink(path),
    };
  }, [docPath, onOpenInternalLink]);

  return (
    <OpenerContext.Provider value={opener}>
      <div className={styles.preview} data-markdown-preview={docPath}>
        {paragraphs.length === 0 ? (
          <p className={styles.empty}>（空文档）</p>
        ) : (
          paragraphs.map((paragraphText, index) => (
            <div key={index}>
              {toPreviewBlocks(parseDocument(paragraphText).tree).map((block, blockIndex) =>
                renderBlock(block, blockIndex),
              )}
              {(pairsByIndex.get(index) ?? []).map((pair, pairIndex) => (
                <p
                  key={pairIndex}
                  className={`${styles.translationInline} ${articleSerif ? styles.translationSans : ''}`}
                >
                  {pair.text}
                </p>
              ))}
            </div>
          ))
        )}
      </div>
    </OpenerContext.Provider>
  );
}
