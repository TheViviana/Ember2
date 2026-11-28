import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRemoveNodeCommands } from '../../../src/app/canvas/canvas-interactions.ts';
import { CanvasInteractionController } from '../../../src/app/canvas/document-controller.ts';
import type { CanvasDocument } from '../../../src/app/canvas/format.ts';

function sourceDocument(): CanvasDocument {
  return {
    schemaVersion: 3,
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
    canvasId: 'node-deletion',
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

void test('F2 右键删除命令一次直接执行，级联边同批删除且一次 undo 恢复', () => {
  const instance = controller();
  const before = instance.getDocument();
  const commands = createRemoveNodeCommands(['a']);

  assert.deepEqual(commands, [{ kind: 'removeNode', id: 'a' }]);
  assert.equal(instance.execute(commands), true);
  assert.deepEqual(instance.getDocument().nodes.map((node) => (node as { id: string }).id), ['b']);
  assert.deepEqual(instance.getDocument().edges, []);
  assert.equal(instance.getHistory().past.length, 1);
  assert.deepEqual(instance.getHistory().past[0]?.commands, commands);

  assert.equal(instance.undo(), true);
  assert.deepEqual(instance.getDocument(), before);
});

void test('F2 只读画布仍拒绝直接删除且不推进历史', () => {
  const instance = controller(true);
  const before = instance.getDocument();
  assert.equal(instance.execute(createRemoveNodeCommands(['a'])), false);
  assert.equal(instance.getDocument(), before);
  assert.equal(instance.getHistory().past.length, 0);
});
