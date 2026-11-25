/**
 * CR-R2-1：路径段合法性的 core 单一真源。
 *
 * 只按 `/` 切段——反斜杠在 macOS 是合法文件名字符，这里不做任何归一化。
 * 各调用点保留「前缀 / 反斜杠 / 绝对路径」的既有差异，本模块只回答「哪一段非法」。
 */

/** 非法段的类别：空段、`.`、`..`。 */
export type IllegalSegmentKind = 'empty' | 'dot' | 'dotdot';

/**
 * 按 `/` 切段，返回首个非法段的类别；全部合法返回 `null`。
 *
 * 与旧逻辑 `path.split('/').some(s => s === '' || s === '.' || s === '..')` 等价，
 * 额外返回类别供定位；当前调用点仅以 `!== null` 判合法性。
 */
export function illegalSegment(path: string): IllegalSegmentKind | null {
  for (const segment of path.split('/')) {
    if (segment === '') return 'empty';
    if (segment === '.') return 'dot';
    if (segment === '..') return 'dotdot';
  }
  return null;
}
