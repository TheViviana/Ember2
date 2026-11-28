/**
 * M2 关联高亮：选中节点的 incident 边集合（自环只计一次、重复 id/坏边/缺失节点跳过），
 * 以及高亮层「关联边弱、选中边强」的绘制顺序。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_EDGE_STYLE,
  incidentEdgeIds,
  type CanvasEdgeView,
  type ScreenEdge,
} from '../../../src/app/canvas/edge-layout.ts';
import {
  drawEdgeHighlight,
  type EdgeContext,
  type EdgePath,
} from '../../../src/app/canvas/edge-layer.ts';

function edge(id: string, from: string, to: string): CanvasEdgeView {
  return { id, from, to, style: DEFAULT_EDGE_STYLE };
}

void test('incidentEdgeIds：两端任一命中即计入，自环只一次', () => {
  const edges = [edge('ab', 'a', 'b'), edge('bc', 'b', 'c'), edge('loop', 'a', 'a')];

  assert.deepEqual([...incidentEdgeIds(edges, ['a'])].sort(), ['ab', 'loop']);
  assert.deepEqual([...incidentEdgeIds(edges, ['a', 'b'])].sort(), ['ab', 'bc', 'loop']);
});

void test('incidentEdgeIds：重复 id、空 id 与缺失节点不产生条目', () => {
  const edges = [
    edge('ok', 'a', 'b'),
    edge('ok', 'b', 'c'),
    edge('', 'a', 'c'),
    edge('ghost', 'x', 'y'),
  ];

  assert.deepEqual([...incidentEdgeIds(edges, ['a'])], ['ok']);
  assert.deepEqual([...incidentEdgeIds(edges, ['missing'])], []);
  assert.deepEqual([...incidentEdgeIds(edges, [])], []);
});

function lineEdge(id: string): ScreenEdge {
  return {
    id,
    straight: true,
    p0: { x: 0, y: 0 },
    c1: { x: 0, y: 0 },
    c2: { x: 10, y: 0 },
    p3: { x: 10, y: 0 },
    aabb: { left: 0, top: 0, right: 10, bottom: 0 },
    style: DEFAULT_EDGE_STYLE,
  };
}

void test('高亮层：关联边先弱描边，选中边后强描边（alpha 0.4 → 1）', () => {
  const strokes: { readonly path: EdgePath; readonly alpha: number; readonly width: number }[] = [];
  const ctx: EdgeContext = {
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    globalAlpha: 1,
    stroke(path: EdgePath): void {
      strokes.push({ path, alpha: this.globalAlpha ?? 1, width: this.lineWidth });
    },
    fill(): void {},
  };

  const drawn = drawEdgeHighlight(
    ctx,
    [lineEdge('selected')],
    { edge: '#111111', selected: '#222222', arrow: '#111111' },
    () => ({ moveTo(): void {}, lineTo(): void {}, bezierCurveTo(): void {}, arc(): void {}, closePath(): void {} }),
    [lineEdge('related')],
  );

  assert.equal(drawn, 1);
  assert.deepEqual(
    strokes.map((item) => ({ alpha: item.alpha, width: item.width })),
    [
      { alpha: 0.4, width: 2.5 },
      { alpha: 1, width: 2.5 },
    ],
  );
  assert.equal(ctx.globalAlpha, 1);
});