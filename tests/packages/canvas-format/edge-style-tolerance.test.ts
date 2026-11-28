/**
 * 连线样式宽容性：style 是可选渲染提示，未知子键/非法值/缺省键都不得产生 issue，
 * 且必须原样保留在投影与写回中（旧版本 Ember 读取时忽略并原样保留）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect, mutate, type CanvasCommand, type CanvasDocument } from '#canvas-format';

function document(edges: readonly unknown[]): CanvasDocument {
  return {
    schemaVersion: 3,
    nodes: [
      { id: 'a', type: 'text', x: 0, y: 0 },
      { id: 'b', type: 'text', x: 200, y: 0 },
      { id: 'c', type: 'text', x: 400, y: 0 },
    ],
    edges,
  };
}

void test('style 未知子键、非法枚举与缺省键均零 issue 且原样保留', () => {
  const edges = [
    {
      id: 'e1',
      from: { nodeId: 'a', portId: 'out' },
      to: { nodeId: 'b', portId: 'in' },
      style: { line: 'dashed', arrow: 'both', color: 'primary', route: 'curve', future: 1 },
    },
    {
      id: 'e2',
      from: { nodeId: 'b', portId: 'out' },
      to: { nodeId: 'c', portId: 'in' },
      style: { line: 'bogus', arrow: 42, color: null, unknownNested: { keep: true } },
    },
    {
      id: 'e3',
      from: { nodeId: 'c', portId: 'out' },
      to: { nodeId: 'a', portId: 'in' },
    },
  ];

  const result = inspect(document(edges));
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.projection.edges[0]?.style, edges[0]?.style);
  assert.deepEqual(result.projection.edges[1]?.style, edges[1]?.style);
  assert.equal('style' in (result.projection.edges[2] ?? {}), false);
});

void test('样式边经 mutate 重建后保留未知子键', () => {
  const original = document([
    {
      id: 'e1',
      from: { nodeId: 'a', portId: 'out' },
      to: { nodeId: 'b', portId: 'in' },
      style: { line: 'dashed', future: 'keep-me' },
      meta: 'edge-meta',
    },
  ]);
  const commands: readonly CanvasCommand[] = [
    { kind: 'removeEdge', id: 'e1' },
    {
      kind: 'addEdge',
      edge: {
        id: 'e1',
        from: { nodeId: 'a', portId: 'out' },
        to: { nodeId: 'b', portId: 'in' },
        style: { line: 'dashed', future: 'keep-me', arrow: 'none' },
        meta: 'edge-meta',
      },
      index: 0,
    },
  ];

  const result = mutate(original, commands);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const edge = result.document.edges[0] as {
    readonly style?: Readonly<Record<string, unknown>>;
    readonly meta?: unknown;
  };
  assert.deepEqual(edge.style, { line: 'dashed', future: 'keep-me', arrow: 'none' });
  assert.equal(edge.meta, 'edge-meta');
});