/**
 * CR-20261120-34：editor 层的 Markdown 解析入口。
 *
 * 分层门禁禁止 windows/editor 直引 packages，统一由 core 转发 doc-model 解析。
 */
export { parseDocument, parseFrontmatter, splitWikiLinks } from '#doc-model';
export type { WikiLinkSegment } from '#doc-model';
