/**
 * 层级标签（斜杠命名）工具：`项目/前端/编辑器`。
 *
 * 只做规范化与展示拆分，不读写文档；写入 frontmatter 由 frontmatter-edit 负责。
 */

const MAX_TAG_LENGTH = 120;

/** 规范化为 `a/b/c`；空输入、全斜杠或超长返回 null。 */
export function normalizeTagPath(raw: string): string | null {
  const cleaned = raw.trim().replace(/^#+/, '').replace(/\/+/g, '/');
  const segments = cleaned
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  const joined = segments.join('/');
  if (joined.length > MAX_TAG_LENGTH) return null;
  return joined;
}

/** 去重并保持输入顺序；非法项直接丢弃。 */
export function normalizeTagList(raws: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of raws) {
    const tag = normalizeTagPath(raw);
    if (tag === null || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return Object.freeze(tags);
}

/** 叶节点名称：`项目/前端` → `前端`。 */
export function tagLeaf(tag: string): string {
  const index = tag.lastIndexOf('/');
  return index === -1 ? tag : tag.slice(index + 1);
}

/** 根节点名称：`项目/前端` → `项目`。 */
export function tagRoot(tag: string): string {
  const index = tag.indexOf('/');
  return index === -1 ? tag : tag.slice(0, index);
}
