/**
 * rename 的纯内存路径迁移；调用方仍独占文档集合与通知时机。
 */
export function migrateDocumentPath<T extends { path: string }>(
  docs: Map<string, T>,
  from: string,
  to: string,
  aliases?: Map<string, string>,
): T | null {
  if (aliases) {
    // 连续改名时把所有指向旧路径的别名直接压缩到新终点。
    for (const [alias, target] of aliases) {
      if (target === from) aliases.set(alias, to);
    }
    aliases.set(from, to);
    // 新终点是当前真实路径，不应再被解析成其他路径（也覆盖改回旧名）。
    aliases.delete(to);
  }
  const source = docs.get(from);
  if (!source) return null;
  docs.delete(from);
  const target = docs.get(to);
  // 两端同时打开：保留目标视图，丢弃源视图（同一个文件不重复开窗）。
  if (target) return target;
  source.path = to;
  docs.set(to, source);
  return source;
}
