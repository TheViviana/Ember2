/**
 * DOM 世界层：C2/C3 的唯一挂载点。
 * 负责创建容器并把 ViewportTransform 落成 CSS transform；C2 起容器变换折入
 * `origin * s`，使子元素的 local 坐标与三式 `screen = absolute * s + tx` 等价。
 */
import { worldContainerOffset } from './node-layout.ts';
import type { ViewportTransform } from './viewport.ts';

export interface WorldLayer {
  readonly element: HTMLDivElement;
  /** C2/C3 唯一挂载点（CR-20261117-01 §4.2）。 */
  getWorldElement(): HTMLElement;
  apply(transform: ViewportTransform): void;
  dispose(): void;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * transform-origin 固定为 0 0；平移量取 `tx + origin * s`（origin 为 0 时与 C1 完全一致），
 * 因此子元素 local 坐标满足 `screen = local * s + tx + origin * s`。
 */
export function worldTransformCss(transform: ViewportTransform): string {
  const offset = worldContainerOffset(transform);
  return `translate3d(${round(offset.x)}px, ${round(offset.y)}px, 0) scale(${round(transform.scale)})`;
}

export function createWorldLayer(className: string): WorldLayer {
  const element = document.createElement('div');
  element.className = className;
  element.style.transformOrigin = '0 0';

  return {
    element,
    getWorldElement(): HTMLElement {
      return element;
    },
    apply(transform: ViewportTransform): void {
      element.style.transform = worldTransformCss(transform);
    },
    dispose(): void {
      element.remove();
    },
  };
}
