import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRemoveEdgeCommands } from '../../../src/app/canvas/canvas-interactions.ts';
import { CanvasInteractionController } from '../../../src/app/canvas/document-controller.ts';
import type { CanvasDocument } from '../../../src/app/canvas/format.ts';

function sourceDocument(): CanvasDocument {
  return {
    schemaVersion: 2,
    nodes: [
      { id: 'a', label: 'A', x: 0, y: 0 },
      { id: 'b', label: 'B', x: 200, y: 0 },
    ],
    edges: [
      { id: 'e1', from: { nodeId: 'a' }, to: { nodeId: 'b' } },
      { id: 'e2', from: { nodeId: 'b' }, to: { nodeId: 'a' } },
    ],
  };
}

function controller(readOnly = false): CanvasInteractionController {
  return new CanvasInteractionController({
    canvasId: 'edge-deletion',
    document: sourceDocument(),
    readOnly,
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

void test('Delete 与右键菜单共用的连线删除命令只生成 removeEdge', () => {
  assert.deepEqual(createRemoveEdgeCommands(['e1', 'e2']), [
    { kind: 'removeEdge', id: 'e1' },
    { kind: 'removeEdge', id: 'e2' },
  ]);
  assert.deepEqual(createRemoveEdgeCommands([]), []);
});

void test('连线删除经统一历史执行，undo/redo 恢复原边集', () => {
  const instance = controller();
  const before = instance.getDocument();
  const commands = createRemoveEdgeCommands(['e1']);

  assert.equal(instance.execute(commands), true);
  assert.deepEqual(
    instance.getDocument().edges.map((edge) => (edge as { readonly id: string }).id),
    ['e2'],
  );
  assert.deepEqual(instance.getDocument().nodes, before.nodes);
  assert.equal(instance.getHistory().past[0]?.kind, 'removeEdge');
  assert.deepEqual(instance.getHistory().past[0]?.commands, commands);

  assert.equal(instance.undo(), true);
  assert.deepEqual(instance.getDocument(), before);
  assert.equal(instance.redo(), true);
  assert.deepEqual(
    instance.getDocument().edges.map((edge) => (edge as { readonly id: string }).id),
    ['e2'],
  );
});

void test('只读画布拒绝连线删除且不推进历史', () => {
  const instance = controller(true);
  const before = instance.getDocument();
  assert.equal(instance.execute(createRemoveEdgeCommands(['e1'])), false);
  assert.equal(instance.getDocument(), before);
  assert.equal(instance.getHistory().past.length, 0);
});
