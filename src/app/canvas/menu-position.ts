/** 右键/拉线菜单的视口内收：靠近边缘时向内收，避免菜单掉到可视区外。 */
export function clampMenuPoint(
  point: { readonly x: number; readonly y: number },
  width: number,
  height: number,
  menuWidth = 240,
  menuHeight = 360,
): { readonly x: number; readonly y: number } {
  return {
    x: Math.max(8, Math.min(point.x, Math.max(8, width - menuWidth))),
    y: Math.max(8, Math.min(point.y, Math.max(8, height - menuHeight))),
  };
}
