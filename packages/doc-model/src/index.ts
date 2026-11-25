/**
 * doc-model：纯逻辑层（无 IO、无 React/Tauri 依赖，gate:layers 强制）。
 * I3（CR-20261119-20）：单一 Markdown 解析管线 + frontmatter + wikilink；
 * DOC_MODEL_VERSION 保持 `2.0.0-p0`：版本语义待 core 接入时统一裁定（复核修订）。
 */
export const DOC_MODEL_VERSION = '2.0.0-p0';
export { parseDocument, parseToMdast } from './markdown/pipeline.ts';
export type { ParseOutcome } from './markdown/pipeline.ts';
export { parseFrontmatter } from './frontmatter.ts';
export type { DocFrontmatter, FrontmatterParse } from './frontmatter.ts';
export { extractWikiLinks, splitWikiLinks } from './wikilink.ts';
export type { WikiLink, WikiLinkSegment } from './wikilink.ts';
