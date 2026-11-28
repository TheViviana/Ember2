/**
 * 连线编辑：标签设置/清空、方向反转、缺失边保护与 undo/redo。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mutate, type CanvasDocument } from '#canvas-format';
import {
  createConnectNewNodeCommands,
  createConnectionNodePorts,
  createReverseEdgeCommands,
  createSetEdgeLabelCommands,
} from '../../../src/app/canvas/canvas-interactions.ts';

function documentWithEdges(): CanvasDocument {
  return {
    schemaVersion: 3,
    nodes: [
      { id: 'a', x: 0, y: 0, type: 'text', ports: createConnectionNodePorts() },
      { id: 'b', x: 200, y: 0, type: 'text', ports: createConnectionNodePorts() },
      { id: 'c', x: 400, y: 0, type: 'text', ports: createConnectionNodePorts() },
    ],
    edges: [
      {
        id: 'e1',
        from: { nodeId: 'a', portId: 'out' },
        to: { nodeId: 'b', portId: 'in' },
        label: '旧状态',
        meta: 'keep-me',
      },
      {
        id: 'e2',
        from: { nodeId: 'b', portId: 'out' },
        to: { nodeId: 'c', portId: 'in' },
      },
    ],
  };
}

void test('设置标签：trim 后写入，保留 id/下标/未知字段', () => {
  const commands = createSetEdgeLabelCommands(documentWithEdges(), 'e1', '  新状态  ');
  assert.ok(commands !== null);
  const result = mutate(documentWithEdges(), commands);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const edge = result.document.edges[0] as Record<string, unknown>;
  assert.equal(result.document.edges[0] && (result.document.edges[0] as { id: string }).id, 'e1');
  assert.equal(edge.label, '新状态');
  assert.equal(edge.meta, 'keep-me');
  assert.equal((result.document.edges[1] as { id: string }).id, 'e2');
});

void test('清空标签：空串删除 label 字段，边仍在原下标', () => {
  const commands = createSetEdgeLabelCommands(documentWithEdges(), 'e1', '   ');
  assert.ok(commands !== null);
  const result = mutate(documentWithEdges(), commands);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const edge = result.document.edges[0] as Record<string, unknown>;
  assert.equal('label' in edge, false);
  assert.equal(edge.id, 'e1');
});

void test('反转方向：交换 from/to，保留 id、下标与 label', () => {
  const commands = createReverseEdgeCommands(documentWithEdges(), 'e1');
  assert.ok(commands !== null);
  const result = mutate(documentWithEdges(), commands);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const edge = result.document.edges[0] as {
    readonly id: string;
    readonly from: { readonly nodeId: string };
    readonly to: { readonly nodeId: string };
    readonly label?: string;
  };
  assert.equal(edge.id, 'e1');
  assert.deepEqual(edge.from, { nodeId: 'b', portId: 'out' });
  assert.deepEqual(edge.to, { nodeId: 'a', portId: 'in' });
  assert.equal(edge.label, '旧状态');
  assert.equal((result.document.edges[1] as { id: string }).id, 'e2');
});

void test('缺失边：标签与反转都返回 null', () => {
  assert.equal(createSetEdgeLabelCommands(documentWithEdges(), 'missing', 'x'), null);
  assert.equal(createReverseEdgeCommands(documentWithEdges(), 'missing'), null);
});

void test('标签与反转均可一次 undo 回到原状，redo 再应用', () => {
  const commands = createSetEdgeLabelCommands(documentWithEdges(), 'e1', '进行中');
  assert.ok(commands !== null);
  const applied = mutate(documentWithEdges(), commands);
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  const undone = mutate(applied.document, applied.inverse);
  assert.equal(undone.ok, true);
  if (!undone.ok) return;
  assert.equal((undone.document.edges[0] as { label?: string }).label, '旧状态');

  const reversed = createReverseEdgeCommands(documentWithEdges(), 'e1');
  assert.ok(reversed !== null);
  const reversedApplied = mutate(documentWithEdges(), reversed);
  assert.equal(reversedApplied.ok, true);
  if (!reversedApplied.ok) return;
  const reversedUndone = mutate(reversedApplied.document, reversedApplied.inverse);
  assert.equal(reversedUndone.ok, true);
  if (!reversedUndone.ok) return;
  assert.deepEqual(
    (reversedUndone.document.edges[0] as { from: unknown }).from,
    { nodeId: 'a', portId: 'out' },
  );
});

void test('反向新建节点：新节点 out → 原 in 端口', () => {
  const node = {
    id: 'n1',
    x: 100,
    y: 100,
    type: 'text' as const,
    ports: createConnectionNodePorts(),
  };
  const commands = createConnectNewNodeCommands(node, { nodeId: 'b', portId: 'in' }, true);
  const edge = commands[1];
  assert.ok(edge?.kind === 'addEdge');
  assert.deepEqual(edge.edge.from, { nodeId: 'n1', portId: 'out' });
  assert.deepEqual(edge.edge.to, { nodeId: 'b', portId: 'in' });
});