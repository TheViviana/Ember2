/**
 * R2：连线草稿纯几何（三次贝塞尔），以及起点与落定边同源。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftCurve } from '../../../src/app/canvas/connection-draft.ts';
import {
  EDGE_CURVE_OFFSET_MAX,
  EDGE_CURVE_OFFSET_MIN,
  absoluteToScreen,
  buildScreenEdges,
  edgeAnchor,
} from '../../../src/app/canvas/edge-layout.ts';
import { nodeSizeOf, type CanvasNodeView } from '../../../src/app/canvas/node-layout.ts';
import { createViewportTransform } from '../../../src/app/canvas/viewport.ts';

const nodeA: CanvasNodeView = { type: 'text', id: 'a', label: 'A', x: 10, y: 20, w: 240, h: 120 };
const nodeB: CanvasNodeView = { type: 'text', id: 'b', label: 'B', x: 400, y: 300, w: 100, h: 60 };

void test('draftCurve：控制柄夹在最小/最大偏移内', () => {
  const anchor = { x: 10, y: 20 };

  const zero = draftCurve(anchor, anchor);
  assert.deepEqual(zero.p0, anchor);
  assert.deepEqual(zero.p3, anchor);
  assert.equal(zero.c1.x, anchor.x + EDGE_CURVE_OFFSET_MIN);
  assert.equal(zero.c2.x, anchor.x - EDGE_CURVE_OFFSET_MIN);

  const near = draftCurve(anchor, { x: 40, y: 20 });
  assert.equal(near.c1.x, anchor.x + EDGE_CURVE_OFFSET_MIN);

  const far = draftCurve(anchor, { x: 1000, y: 20 });
  assert.equal(far.c1.x, anchor.x + EDGE_CURVE_OFFSET_MAX);
  assert.equal(far.c2.x, 1000 - EDGE_CURVE_OFFSET_MAX);

  const mid = draftCurve(anchor, { x: 110, y: 20 });
  assert.equal(mid.c1.x, anchor.x + 50);
  assert.equal(mid.c2.x, 110 - 50);
});

void test('draftCurve：反向拖动也保持水平控制柄', () => {
  const curve = draftCurve({ x: 300, y: 100 }, { x: 40, y: 160 });
  // 水平距离 260 → offset = min(160, max(24, 130)) = 130
  assert.equal(curve.c1.x, 300 + 130);
  assert.equal(curve.c2.x, 40 - 130);
  assert.deepEqual(curve.p3, { x: 40, y: 160 });
  assert.ok(curve.d.startsWith('M 300 100 C '));
});

void test('draftCurve：path 坐标保留两位小数', () => {
  const curve = draftCurve({ x: 0.1234, y: 1.9876 }, { x: 50.5555, y: 60.4444 });
  // CR-20261121-59：控制点离节点边缘至少 30px（EDGE_CURVE_OFFSET_MIN 24→30）
  assert.equal(curve.d, 'M 0.12 1.99 C 30.12 1.99, 20.56 60.44, 50.56 60.44');
});

void test('草稿起点与落定边的 from 端点同源（含显式 w/h）', () => {
  const transform = createViewportTransform();
  const screen = buildScreenEdges([{ id: 'e1', from: 'a', to: 'b' }], [nodeA, nodeB], transform);
  assert.equal(screen.length, 1);
  const p0 = screen[0]?.p0;
  assert.ok(p0 !== undefined);

  const anchor = absoluteToScreen(
    edgeAnchor({ x: nodeA.x, y: nodeA.y }, 'out', nodeSizeOf(nodeA)),
    transform,
  );
  const curve = draftCurve(anchor, { x: 300, y: 140 });
  assert.deepEqual(curve.p0, { x: p0.x, y: p0.y });
});

void test('平移/缩放后草稿起点仍与落定边一致', () => {
  const transform = { ...createViewportTransform(), scale: 2, x: 37, y: -12 };
  const screen = buildScreenEdges([{ id: 'e1', from: 'a', to: 'b' }], [nodeA, nodeB], transform);
  const p0 = screen[0]?.p0;
  assert.ok(p0 !== undefined);

  const anchor = absoluteToScreen(
    edgeAnchor({ x: nodeA.x, y: nodeA.y }, 'out', nodeSizeOf(nodeA)),
    transform,
  );
  assert.deepEqual(anchor, { x: p0.x, y: p0.y });
});
