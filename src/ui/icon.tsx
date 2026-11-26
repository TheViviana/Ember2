/**
 * 统一线性图标：尺寸只有 12 / 14 / 16 三档，任何 viewBox 下有效描边都是 1.25px。
 * 只负责几何与描边，不引入颜色；颜色一律 currentColor 继承按钮状态。
 */
import type { ReactNode } from 'react';
import { iconStrokeWidth } from './icon-metrics.ts';
import type { IconSize } from './icon-metrics.ts';

export type { IconSize } from './icon-metrics.ts';
export { ICON_STROKE_PX, iconStrokeWidth } from './icon-metrics.ts';

export interface IconProps {
  readonly size?: IconSize;
  /** 默认 24×24；沿用原图标坐标系时显式传入。 */
  readonly viewBox?: string;
  readonly className?: string;
  readonly children: ReactNode;
}

export function Icon({ size = 16, viewBox = '0 0 24 24', className, children }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth={iconStrokeWidth(size, viewBox)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}
