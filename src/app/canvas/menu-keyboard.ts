/**
 * Cinematic Ember §8.1：菜单键盘焦点移动。
 *
 * 与 DOM 解耦，便于 node 测试；`enabled` 为菜单项可用性数组，`current` 为当前
 * 焦点下标（-1 表示没有焦点项），`delta` 为移动方向。
 */
export function nextMenuIndex(
  enabled: readonly boolean[],
  current: number,
  delta: 1 | -1,
): number {
  const count = enabled.length;
  if (count === 0) return -1;
  // 没有有效焦点时：向下从首项开始，向上从末项开始。
  const start = current >= 0 && current < count ? current : delta === 1 ? -1 : count;
  for (let step = 1; step <= count; step += 1) {
    const index = ((start + delta * step) % count + count) % count;
    if (enabled[index] === true) return index;
  }
  return -1;
}
