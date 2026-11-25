import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mutate, type CanvasDocument, type CanvasMutateResult } from '#canvas-format';

function succeed(result: CanvasMutateResult) {
  if (!result.ok) assert.fail('预期 mutate 成功');
  return result;
}

const original: CanvasDocument = {
  schemaVersion: 2,
  nodes: [
    {
      id: 'a',
      x: 0,
      y: 0,
      type: 'text',
      ports: [
        { id: 'in', dir: 'in' },
        { id: 'out', dir: 'out' },
      ],
    },
  ],
  edges: [],
};

void test('addNode/addEdge 结构拷贝入库，调用方后续嵌套修改不污染文档', () => {
  const node = {
    id: 'b',
    x: 10,
    y: 20,
    type: 'text' as const,
    ports: [
      { id: 'in', dir: 'in' as const, name: 'original' },
      { id: 'out', dir: 'out' as const },
    ],
    custom: { nested: { value: 'node-original' } },
  };
  const edge = {
    id: 'e1',
    from: { nodeId: 'a', portId: 'out' },
    to: { nodeId: 'b', portId: 'in' },
    custom: { nested: { value: 'edge-original' } },
  };
  const result = succeed(mutate(original, [
    { kind: 'addNode', node },
    { kind: 'addEdge', edge },
  ]));
  const storedNode = result.document.nodes[1];
  const storedEdge = result.document.edges[0];
  assert.notEqual(storedNode, node);
  assert.notEqual(storedEdge, edge);
  const snapshot = JSON.stringify(result.document);

  const firstPort = node.ports[0];
  assert.ok(firstPort !== undefined);
  firstPort.name = 'caller-changed';
  node.custom.nested.value = 'caller-changed';
  edge.from.nodeId = 'missing';
  edge.custom.nested.value = 'caller-changed';

  assert.equal(JSON.stringify(result.document), snapshot);
});

void test('removeNode 的 restoreNode inverse 仍恢复原条目引用', () => {
  const entry = original.nodes[0];
  const removed = succeed(mutate(original, [{ kind: 'removeNode', id: 'a' }]));
  const inverse = removed.inverse[0];
  assert.ok(inverse?.kind === 'restoreNode');
  assert.equal(inverse.entry, entry);

  const restored = succeed(mutate(removed.document, removed.inverse));
  assert.equal(restored.document.nodes[0], entry);
});
