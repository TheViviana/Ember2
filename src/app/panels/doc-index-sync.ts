/**
 * 前端删除/改名后的索引对账范围（CR-20261122-66）。
 *
 * 后端 `vault_remove` / `vault_rename` 成功后会在 watcher 自写日志里登记，
 * 监听线程会压掉这次「自己造成」的 removed / created 事件；而文档树完全由
 * 索引驱动，所以 UI 必须在成功后主动 `reconcilePaths`，否则已删除的行会继续
 * 留在浮窗里（目录删除时 FSEvents 通常只报目录本身，更不会自动清理子树）。
 */

/** 目标自身或其后代；用于目录删除/改名时圈定受影响的文档路径。 */
export function isWithinPath(path: string, target: string): boolean {
  return path === target || path.startsWith(`${target}/`);
}

/** 删除前：索引中需要移除的文档路径（文章自身或目录下全部后代）。 */
export function removedDocPaths(paths: Iterable<string>, target: string): string[] {
  return [...paths].filter((path) => isWithinPath(path, target));
}

/** 改名后：旧路径与逐项对应的新路径，交给 `reconcilePaths` 一次对账。 */
export function renamedDocPaths(
  paths: Iterable<string>,
  from: string,
  to: string,
): { readonly stale: string[]; readonly fresh: string[] } {
  const stale = removedDocPaths(paths, from);
  return {
    stale,
    fresh: stale.map((path) => `${to}${path.slice(from.length)}`),
  };
}
