/**
 * C0-B B1/B3：画布视图同步与挂载守卫（纯逻辑，不碰 DOM，可在 node 下测试）。
 *
 * - 外部文档替换（`accept-external`）后必须重新按 `lastOrigin` 应用 origin、
 *   用 inspection 投影重建节点/连线视图，并清空幽灵选中与活动手势；
 * - 挂载代次守卫让过期的 await 结果无法写入新实例。
 */
import type { CanvasProjection } from '#canvas-format';
import { extractEdgeViews, type CanvasEdgeView } from './edge-layout.ts';
import type { CanvasDocument } from './format.ts';
import { createInteractionState, type InteractionState } from './interaction.ts';
import {
  applyOrigin,
  extractNodeViews,
  readOrigin,
  type CanvasNodeView,
} from './node-layout.ts';
import type { ViewportTransform } from './viewport.ts';

export interface CanvasDocumentView {
  readonly nodeViews: readonly CanvasNodeView[];
  readonly edgeViews: readonly CanvasEdgeView[];
  readonly transform: ViewportTransform;
  readonly interaction: InteractionState;
}

/**
 * 按投影重建视图：只渲染 inspection 认可的条目，
 * origin 以文档 `lastOrigin` 为准，选中与手势回到空态。
 */
export function createCanvasDocumentView(input: {
  readonly document: CanvasDocument;
  readonly projection: CanvasProjection;
  readonly transform: ViewportTransform;
}): CanvasDocumentView {
  const nodeViews = extractNodeViews(input.projection.nodes);
  return {
    nodeViews,
    edgeViews: extractEdgeViews(input.projection.edges, nodeViews),
    transform: applyOrigin(input.transform, readOrigin(input.document)),
    interaction: createInteractionState(),
  };
}

/** 设备像素比上限 2（与 C1 既有初始化口径一致）；override 用于浏览器验收注入。 */
export function readCanvasDpr(override?: number): number {
  const candidate = override ?? globalThis.devicePixelRatio;
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate <= 0) return 1;
  return Math.min(candidate, 2);
}

export interface CanvasMountGuard {
  /** 开始一次挂载尝试，返回该次代次。 */
  begin(): number;
  /** 作废当前代次（dispose / abortMount）。 */
  invalidate(): void;
  /** 仅当前代次可通过；过期 Promise 必须丢弃。 */
  isCurrent(generation: number): boolean;
}

export function createCanvasMountGuard(): CanvasMountGuard {
  let latest = 0;
  let active: number | null = null;
  return {
    begin(): number {
      latest += 1;
      active = latest;
      return latest;
    },
    invalidate(): void {
      active = null;
    },
    isCurrent(generation: number): boolean {
      return active === generation;
    },
  };
}
