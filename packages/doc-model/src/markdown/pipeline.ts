/**
 * CR-20261119-20：doc-model I3 单一 Markdown 解析管线（contract §I I3：全库仅此一套 unified/remark）。
 *
 * 模块级同步 processor（remark-parse + remark-gfm），只 `parse` 不 `run`/`process`
 * （本包无 transformer，复核修订 §3.6）；frontmatter 与 wikilink 独立提取；
 * 永不向调用方抛致命错：所有异常收进 warnings（§3.5），坏文档必须可加载。
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { Root } from 'mdast';
import { parseFrontmatter } from '../frontmatter.ts';
import type { DocFrontmatter } from '../frontmatter.ts';
import { extractWikiLinks } from '../wikilink.ts';
import type { WikiLink } from '../wikilink.ts';

export interface ParseOutcome {
  /** mdast 树（含 GFM 节点）。 */
  readonly tree: Root;
  readonly frontmatter: DocFrontmatter | null;
  /** 去除 frontmatter 后的正文原文。 */
  readonly body: string;
  /** 从 body 提取的 wikilink。 */
  readonly links: readonly WikiLink[];
  /** 非致命问题（frontmatter 解析失败/字段类型不符/wikilink 提取异常），降级不抛。 */
  readonly warnings: readonly string[];
}

/** 模块级单例：同步 parse 用，无 transformer。 */
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

export function parseDocument(text: string): ParseOutcome {
  try {
    const fm = parseFrontmatter(text);
    const warnings: string[] = [...fm.warnings];
    const tree = parseToMdast(fm.body);
    let links: readonly WikiLink[] = [];
    try {
      links = extractWikiLinks(fm.body);
    } catch (e) {
      warnings.push(`wikilink 提取失败：${e instanceof Error ? e.message : String(e)}`);
    }
    return Object.freeze({
      tree,
      frontmatter: fm.frontmatter,
      body: fm.body,
      links,
      warnings: Object.freeze(warnings),
    });
  } catch (e) {
    // §3.5 兜底：任何未预期异常都不得抛给调用方，返回最小 outcome。
    const message = e instanceof Error ? e.message : String(e);
    const emptyTree: Root = { type: 'root', children: [] };
    return Object.freeze({
      tree: emptyTree,
      frontmatter: null,
      body: text,
      links: [],
      warnings: [`markdown 解析失败：${message}`],
    });
  }
}

/** 仅取 mdast 树（不带 frontmatter/wikilink 提取），供未来 diff/渲染复用；同步 parse。 */
export function parseToMdast(body: string): Root {
  return processor.parse(body);
}
