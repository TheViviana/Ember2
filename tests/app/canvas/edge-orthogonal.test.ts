/**
 * M3 直角折线：确定性三点/五点路由、折线中点、折线命中（含拐角）与 LOD/旧值回退。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildOrthogonalPoints,
  buildScreenEdges,
  DEFAULT_EDGE_STYLE,
  EDGE_ORTHOGONAL_STUB,
  edgeMidpoint,
  edgeSamples,
  extractEdgeViews,
  hitTestEdges,
  pointAtPolylineLength,
  polylineLength,
  type CanvasEdgeView,
  type ScreenEdge,
} from '../../../src/app/canvas/edge-layout.ts';
import { sampleScreenEdge } from '../../../src/app/canvas/edge-pulse.ts';
import type { CanvasNodeView } from '../../../src/app/canvas/node-layout.ts';
import { createViewportTransform } from '../../../src/app/canvas/viewport.ts';

const EPSILON = 1e-9;

function orthogonalEdge(points: readonly { readonly x: number; readonly y: number }[]): ScreenEdge {
  const first = points[0] ?? { x: 0, y: 0 };
  const last = points.at(-1) ?? first;
  return {
    id: 'ortho',
    straight: false,
    p0: first,
    c1: first,
    c2: last,
    p3: last,
    aabb: {
      left: Math.min(...points.map((point) => point.x)),
      top: Math.min(...points.map((point) => point.y)),
      right: Math.max(...points.map((point) => point.x)),
      bottom: Math.max(...points.map((point) => point.y)),
    },
    style: { ...DEFAULT_EDGE_STYLE, route: 'orthogonal' },
    route: 'orthogonal',
    points,
  };
}

void test('buildOrthogonalPoints：正向空间足够时三点路由', () => {
  assert.deepEqual(buildOrthogonalPoints({ x: 0, y: 0 }, { x: 200, y: 100 }), [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 200, y: 100 },
  ]);
});

void test('buildOrthogonalPoints：目标在左侧时五点绕行', () => {
  assert.deepEqual(buildOrthogonalPoints({ x: 200, y: 0 }, { x: 100, y: 100 }), [
    { x: 200, y: 0 },
    { x: 200 + EDGE_ORTHOGONAL_STUB, y: 0 },
    { x: 200 + EDGE_ORTHOGONAL_STUB, y: 50 },
    { x: 100 - EDGE_ORTHOGONAL_STUB, y: 50 },
    { x: 100 - EDGE_ORTHOGONAL_STUB, y: 100 },
    { x: 100, y: 100 },
  ]);
});

void test('buildOrthogonalPoints：水平对齐退化为直线', () => {
  assert.deepEqual(buildOrthogonalPoints({ x: 0, y: 10 }, { x: 200, y: 10.2 }), [
    { x: 0, y: 10 },
    { x: 200, y: 10.2 },
  ]);
});

function node(id: string, x: number, y: number): CanvasNodeView {
  return { type: 'text', id, label: id, x, y };
}

function edge(id: string, from: string, to: string, route: 'curve' | 'orthogonal'): CanvasEdgeView {
  return { id, from, to, style: { ...DEFAULT_EDGE_STYLE, route } };
}

void test('buildScreenEdges：orthogonal 生成 points 与折线 aabb', () => {
  const [screen] = buildScreenEdges(
    [edge('e1', 'a', 'b', 'orthogonal')],
    [node('a', 0, 0), node('b', 400, 100)],
    createViewportTransform(0, 0, 1),
  );

  assert.ok(screen !== undefined);
  assert.equal(screen.route, 'orthogonal');
  assert.deepEqual(screen.points, [
    { x: 160, y: 48 },
    { x: 280, y: 48 },
    { x: 280, y: 148 },
    { x: 400, y: 148 },
  ]);
  assert.deepEqual(screen.aabb, { left: 160, top: 48, right: 400, bottom: 148 });
});

void test('buildScreenEdges：LOD 低缩放不生成 points，仍走直线', () => {
  const [screen] = buildScreenEdges(
    [edge('e1', 'a', 'b', 'orthogonal')],
    [node('a', 0, 0), node('b', 400, 100)],
    createViewportTransform(0, 0, 0.2),
  );

  assert.ok(screen !== undefined);
  assert.equal(screen.straight, true);
  assert.equal(screen.points, undefined);
  assert.deepEqual(edgeSamples(screen), [screen.p0, screen.p3]);
});

void test('旧值/未知 route 回退曲线，不产生空白连线', () => {
  const nodes = [node('a', 0, 0), node('b', 400, 100)];
  const raw = [{
    id: 'e1',
    from: { nodeId: 'a', portId: 'out' },
    to: { nodeId: 'b', portId: 'in' },
    style: { route: 'spline' },
  }];
  const views = extractEdgeViews(raw, nodes);
  assert.equal(views[0]?.style?.route, 'curve');

  const [screen] = buildScreenEdges(views, nodes, createViewportTransform(0, 0, 1));
  assert.ok(screen !== undefined);
  assert.equal(screen.points, undefined);
  assert.equal(screen.route, 'curve');
});

void test('edgeMidpoint：直角折线取弧长 50% 处', () => {
  const edge = orthogonalEdge([
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 200, y: 100 },
  ]);

  assert.deepEqual(edgeMidpoint(edge), { x: 100, y: 50 });
  assert.equal(polylineLength(edge.points ?? []), 300);
});

void test('pointAtPolylineLength：0 / 端点 / 跨界夹紧', () => {
  const points = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ];
  assert.deepEqual(pointAtPolylineLength(points, 0), { x: 0, y: 0 });
  assert.deepEqual(pointAtPolylineLength(points, 150), { x: 100, y: 50 });
  assert.deepEqual(pointAtPolylineLength(points, 999), { x: 100, y: 100 });
  assert.deepEqual(pointAtPolylineLength(points, -5), { x: 0, y: 0 });
});

void test('edgeSamples / hitTestEdges：命中折线与圆角拐角附近', () => {
  const edge = orthogonalEdge([
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 200, y: 100 },
  ]);

  assert.deepEqual(edgeSamples(edge), edge.points);

  const onSegment = hitTestEdges([edge], { x: 50, y: 2 });
  assert.equal(onSegment?.edgeId, 'ortho');

  /* 拐角内角附近：到两段折线的距离都应在 6px 容差内。 */
  const atCorner = hitTestEdges([edge], { x: 103, y: 97 });
  assert.equal(atCorner?.edgeId, 'ortho');

  assert.equal(hitTestEdges([edge], { x: 50, y: 40 }), null);
});

void test('sampleScreenEdge：直角折线按折线顶点累计弧长', () => {
  const edge = orthogonalEdge([
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ]);
  const sample = sampleScreenEdge(edge);

  assert.deepEqual(sample.points, edge.points);
  assert.deepEqual(sample.cumulative, [0, 100, 200]);
  assert.equal(sample.length, 200);
  assert.equal(Math.abs(sample.length - 200) < EPSILON, true);
});