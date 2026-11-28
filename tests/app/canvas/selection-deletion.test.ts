import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeleteSelectionCommands } from '../../../src/app/canvas/canvas-interactions.ts';
import { CanvasInteractionController } from '../../../src/app/canvas/document-controller.ts';
import type { CanvasDocument } from '../../../src/app/canvas/format.ts';

function sourceDocument(): CanvasDocument {
  return {
    schemaVersion: 3,
    nodes: [
      { id: 'a', label: 'A', x: 0, y: 0 },
      { id: 'b', label: 'B', x: 160, y: 0 },
      { id: 'c', label: 'C', x: 320, y: 0 },
      { id: 'd', label: 'D', x: 480, y: 0 },
    ],
    edges: [
      { id: 'e1', from: { nodeId: 'a' }, to: { nodeId: 'b' } },
      { id: 'e2', from: { nodeId: 'b' }, to: { nodeId: 'c' } },
      { id: 'e3', from: { nodeId: 'c' }, to: { nodeId: 'd' } },
      { id: 'e4', from: { nodeId: 'd' }, to: { nodeId: 'a' } },
    ],
  };
}

function controller(): CanvasInteractionController {
  return new CanvasInteractionController({
    canvasId: 'selection-deletion',
    document: sourceDocument(),
    store: {
      save: () => Promise.resolve({}),
      open: () => Promise.resolve({ exists: true, text: null, sha256: 'sha', modifiedMs: null }),
    },
    applyPositions: () => undefined,
    onConflict: () => undefined,
    schedule: () => 1,
    cancelSchedule: () => undefined,
  });
}

void test('框选节点与额外选边合并一批，级联边不重复删除且一次 undo 全撤', () => {
  const instance = controller();
  const before = instance.getDocument();
  const commands = createDeleteSelectionCommands(before, ['a', 'b'], ['e1', 'e3']);

  assert.deepEqual(commands, [
    { kind: 'removeNode', id: 'a' },
    { kind: 'removeNode', id: 'b' },
    { kind: 'removeEdge', id: 'e3' },
  ]);
  assert.equal(instance.execute(commands), true);
  assert.deepEqual(
    instance.getDocument().nodes.map((node) => (node as { readonly id: string }).id),
    ['c', 'd'],
  );
  assert.deepEqual(instance.getDocument().edges, []);
  assert.equal(instance.getHistory().past.length, 1);
  assert.deepEqual(instance.getHistory().past[0]?.commands, commands);

  assert.equal(instance.undo(), true);
  assert.deepEqual(instance.getDocument(), before);
});

void test('仅选中边时仍只生成 removeEdge 并保持单批历史', () => {
  const instance = controller();
  const before = instance.getDocument();
  const commands = createDeleteSelectionCommands(before, [], ['e1', 'e3']);

  assert.deepEqual(commands, [
    { kind: 'removeEdge', id: 'e1' },
    { kind: 'removeEdge', id: 'e3' },
  ]);
  assert.equal(instance.execute(commands), true);
  assert.deepEqual(instance.getDocument().nodes, before.nodes);
  assert.deepEqual(
    instance.getDocument().edges.map((edge) => (edge as { readonly id: string }).id),
    ['e2', 'e4'],
  );
  assert.equal(instance.getHistory().past.length, 1);
  assert.equal(instance.undo(), true);
  assert.deepEqual(instance.getDocument(), before);
});

void test('空选择不生成删除命令', () => {
  assert.deepEqual(createDeleteSelectionCommands(sourceDocument(), [], []), []);
});
