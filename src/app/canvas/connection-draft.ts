/**
 * R2：连线草稿的三次贝塞尔几何（屏幕坐标，不碰 DOM）。
 *
 * 与落定边共用同一控制柄规则（`edge-layout` 的 EDGE_CURVE_OFFSET_*），
 * 保证拖动中与松手后的曲线形态一致。`d` 直接写入 SVG `<path>`。
 */
import { EDGE_CURVE_OFFSET_MAX, EDGE_CURVE_OFFSET_MIN } from './edge-layout.ts';
import type { Point } from './viewport.ts';

export interface DraftCurve {
  readonly p0: Point;
  readonly c1: Point;
  readonly c2: Point;
  readonly p3: Point;
  /** SVG path：`M p0 C c1 c2 p3`，坐标保留两位小数。 */
  readonly d: string;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function point({ x, y }: Point): string {
  return `${round2(x)} ${round2(y)}`;
}

/**
 * 起点为源端口锚点，终点为指针；控制柄水平，长度随水平距离增长并夹在
 * [EDGE_CURVE_OFFSET_MIN, EDGE_CURVE_OFFSET_MAX]，与落定边一致。
 * reverse=true 时起点是目标 in 端口，切线朝左（从右侧反向拉线）。
 */
export function draftCurve(anchor: Point, current: Point, reverse = false): DraftCurve {
  const offset = Math.min(
    EDGE_CURVE_OFFSET_MAX,
    Math.max(EDGE_CURVE_OFFSET_MIN, Math.abs(current.x - anchor.x) * 0.5),
  );
  const dir = reverse ? -1 : 1;
  const c1 = { x: anchor.x + dir * offset, y: anchor.y };
  const c2 = { x: current.x - dir * offset, y: current.y };
  return {
    p0: anchor,
    c1,
    c2,
    p3: current,
    d: `M ${point(anchor)} C ${point(c1)}, ${point(c2)}, ${point(current)}`,
  };
}
