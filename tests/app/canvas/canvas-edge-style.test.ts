/**
 * 连线样式命令：设置 / 清空 / 部分更新，保留 id、下标、未知字段与未知子键；
 * 一次修改可整体 undo/redo；边不存在返回 null。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mutate, type CanvasDocument } from '#canvas-format';
import {
  buildScreenEdges,
  extractEdgeViews,
} from '../../../src/app/canvas/edge-layout.ts';
import { createViewportTransform } from '../../../src/app/canvas/viewport.ts';
import {
  createReverseEdgeCommands,
  createSetEdgeLabelCommands,
  createSetEdgeStyleCommands,
} from '../../../src/app/canvas/canvas-interactions.ts';

function documentWithEdges(): CanvasDocument {
  return {
    schemaVersion: 3,
    nodes: [
      { id: 'a', x: 0, y: 0, type: 'text' },
      { id: 'b', x: 200, y: 0, type: 'text' },
      { id: 'c', x: 400, y: 0, type: 'text' },
    ],
    edges: [
      {
        id: 'e1',
        from: { nodeId: 'a', portId: 'out' },
        to: { nodeId: 'b', portId: 'in' },
        label: '旧状态',
        meta: 'keep-me',
        style: { color: 'primary', future: 'keep-me' },
      },
      {
        id: 'e2',
        from: { nodeId: 'b', portId: 'out' },
        to: { nodeId: 'c', portId: 'in' },
      },
    ],
  };
}

function edgeAt(result: ReturnType<typeof mutate>, index: number): Record<string, unknown> {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('mutate failed');
  return result.document.edges[index] as Record<string, unknown>;
}

void test('设置样式：写入 patch 键，保留 id/下标/未知字段与未知子键', () => {
  const commands = createSetEdgeStyleCommands(documentWithEdges(), 'e1', {
    line: 'dashed',
    arrow: 'both',
  });
  assert.ok(commands !== null);
  const result = mutate(documentWithEdges(), commands);
  const edge = edgeAt(result, 0);

  assert.equal(edge.id, 'e1');
  assert.equal(edge.label, '旧状态');
  assert.equal(edge.meta, 'keep-me');
  assert.deepEqual(edge.style, {
    color: 'primary',
    future: 'keep-me',
    line: 'dashed',
    arrow: 'both',
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal((result.document.edges[1] as { id: string }).id, 'e2');
});

void test('部分更新：null 删除单键，未知子键与其他键不动', () => {
  const commands = createSetEdgeStyleCommands(documentWithEdges(), 'e1', { color: null });
  assert.ok(commands !== null);
  const edge = edgeAt(mutate(documentWithEdges(), commands), 0);

  assert.deepEqual(edge.style, { future: 'keep-me' });
});

void test('清空全部样式：删除整个 style 字段', () => {
  const commands = createSetEdgeStyleCommands(documentWithEdges(), 'e1', {
    color: null,
    line: null,
    arrow: null,
    route: null,
  });
  assert.ok(commands !== null);
  const edge = edgeAt(mutate(documentWithEdges(), commands), 0);

  // 未知子键不属于四键，仍会保留；全部已知键清空但未知子键存在时不删字段。
  assert.deepEqual(edge.style, { future: 'keep-me' });

  const bare = documentWithEdges();
  const bareEdges = bare.edges.map((item, index) =>
    index === 0 ? { id: 'e1', from: { nodeId: 'a', portId: 'out' }, to: { nodeId: 'b', portId: 'in' }, style: { color: 'primary' } } : item,
  );
  const bareCommands = createSetEdgeStyleCommands({ ...bare, edges: bareEdges }, 'e1', {
    color: null,
  });
  assert.ok(bareCommands !== null);
  const bareEdge = edgeAt(mutate({ ...bare, edges: bareEdges }, bareCommands), 0);
  assert.equal('style' in bareEdge, false);
});

void test('边不存在：返回 null', () => {
  assert.equal(createSetEdgeStyleCommands(documentWithEdges(), 'missing', { line: 'dashed' }), null);
});

void test('样式修改可一次 undo 回到原状，redo 再应用', () => {
  const original = documentWithEdges();
  const commands = createSetEdgeStyleCommands(original, 'e1', { line: 'dashed', arrow: 'none' });
  assert.ok(commands !== null);
  const applied = mutate(original, commands);
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  assert.deepEqual(edgeAt(applied, 0).style, {
    color: 'primary',
    future: 'keep-me',
    line: 'dashed',
    arrow: 'none',
  });

  const undone = mutate(applied.document, applied.inverse);
  assert.equal(undone.ok, true);
  if (!undone.ok) return;
  assert.deepEqual(edgeAt(undone, 0).style, { color: 'primary', future: 'keep-me' });

  const redone = mutate(undone.document, commands);
  assert.equal(redone.ok, true);
  if (!redone.ok) return;
  assert.deepEqual(edgeAt(redone, 0).style, {
    color: 'primary',
    future: 'keep-me',
    line: 'dashed',
    arrow: 'none',
  });
});

void test('route orthogonal 端到端：命令落盘后能生成直角折线点', () => {
  const commands = createSetEdgeStyleCommands(documentWithEdges(), 'e2', { route: 'orthogonal' });
  assert.ok(commands !== null);
  const applied = mutate(documentWithEdges(), commands);
  assert.equal(applied.ok, true);
  if (!applied.ok) return;

  const nodes = [
    { type: 'text' as const, id: 'a', label: 'a', x: 0, y: 0 },
    { type: 'text' as const, id: 'b', label: 'b', x: 200, y: 0 },
    { type: 'text' as const, id: 'c', label: 'c', x: 400, y: 100 },
  ];
  const views = extractEdgeViews(applied.document.edges, nodes);
  const e2 = views.find((view) => view.id === 'e2');
  assert.equal(e2?.style?.route, 'orthogonal');

  const screen = buildScreenEdges(views, nodes, createViewportTransform(0, 0, 1)).find(
    (edge) => edge.id === 'e2',
  );
  assert.ok(screen !== undefined);
  assert.equal(screen.route, 'orthogonal');
  assert.ok(screen.points !== undefined);
  assert.ok((screen.points?.length ?? 0) >= 3);
});

void test('改标签与反转连线都完整保留 style', () => {
  const labelCommands = createSetEdgeLabelCommands(documentWithEdges(), 'e1', '新状态');
  assert.ok(labelCommands !== null);
  const labeled = mutate(documentWithEdges(), labelCommands);
  assert.deepEqual(edgeAt(labeled, 0).style, { color: 'primary', future: 'keep-me' });

  const reverseCommands = createReverseEdgeCommands(documentWithEdges(), 'e1');
  assert.ok(reverseCommands !== null);
  const reversed = mutate(documentWithEdges(), reverseCommands);
  assert.deepEqual(edgeAt(reversed, 0).style, { color: 'primary', future: 'keep-me' });
});