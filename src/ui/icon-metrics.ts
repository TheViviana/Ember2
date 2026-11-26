/** 图标几何常量：与渲染组件分离，便于在 Node 测试中直接校验描边换算。 */

export type IconSize = 12 | 14 | 16;
export const ICON_STROKE_PX = 1.25;

/** 由目标尺寸反算 strokeWidth，避免 viewBox 缩放后线条忽粗忽细。 */
export function iconStrokeWidth(size: IconSize, viewBox = '0 0 24 24'): number {
  const base = Number.parseFloat(viewBox.trim().split(/\s+/)[2] ?? '24');
  return (ICON_STROKE_PX * (Number.isFinite(base) && base > 0 ? base : 24)) / size;
}
