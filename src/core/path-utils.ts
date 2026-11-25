/**
 * 纯 POSIX 路径切分。
 *
 * vault 相对路径与 Finder 绝对路径是两套语义：反斜杠在 macOS 是合法文件名字符，
 * 这里只认 `/`，不做任何反斜杠归一化。
 */

/** `a/b` → `b`；无 `/` 时原样返回；`a/` → `''`。 */
export function posixBaseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

/** `a/b` → `a`；无 `/` 时返回 `''`（库根）；`a/` → `a`。 */
export function posixParentDir(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}
