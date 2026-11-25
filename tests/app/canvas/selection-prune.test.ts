import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createDeleteSelectionCommands,
  createRemoveNodeCommands,
  pruneInteraction,
  pruneSelection,
} from '../../../src/app/canvas/canvas-interactions.ts';
import { CanvasInteractionController } from '../../../src/app/canvas/document-controller.ts';
import { createInteractionState, type CanvasSelection } from '../../../src/app/canvas/interaction.ts';
import type { CanvasDocument } from '../../../src/app/canvas/format.ts';

function documentWith(nodes: readonly string[], edges: readonly string[]): CanvasDocument {
  return {
    schemaVersion: 2,
    nodes: nodes.map((id, index) => ({ id, x: index * 160, y: 0 })),
    edges: edges.map((id, index) => ({
      id,
      from: { nodeId: nodes[0] ?? 'a' },
      to: { nodeId: nodes[Math.min(index + 1, nodes.length - 1)] ?? 'a' },
    })),
  };
}

function controller(document: CanvasDocument): CanvasInteractionController {
  return new CanvasInteractionController({
    canvasId: 'selection-prune',
    document,
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

void test('pruneSelection 按投影剔除死节点与死边 id', () => {
  const document = documentWith(['a', 'b'], ['e1']);
  const selection = {
    nodes: new Set(['a', 'gone']),
    edges: new Set(['e1', 'gone-edge']),
  };

  const pruned = pruneSelection(selection, document);
  assert.deepEqual([...pruned.nodes], ['a']);
  assert.deepEqual([...pruned.edges], ['e1']);
});

void test('pruneSelection 无变化时返回原引用，坏条目同样被剔除', () => {
  const selection = { nodes: new Set(['a']), edges: new Set<string>() };
  assert.equal(pruneSelection(selection, documentWith(['a'], [])), selection);

  const withBadEntry: CanvasDocument = {
    schemaVersion: 2,
    nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'no-coordinates' }],
    edges: [],
  };
  assert.deepEqual([...pruneSelection({ nodes: new Set(['a', 'no-coordinates']), edges: new Set() }, withBadEntry).nodes], ['a']);
});

void test('pruneInteraction 只剔 id，保留 gesture', () => {
  const state = {
    ...createInteractionState(),
    selection: { nodes: new Set(['a', 'gone']), edges: new Set<string>() },
    gesture: { kind: 'marquee' as const, start: { x: 0, y: 0 }, current: { x: 1, y: 1 }, active: true, additive: false, before: { nodes: new Set<string>(), edges: new Set<string>() } },
  };

  const pruned = pruneInteraction(state, documentWith(['a'], []));
  assert.deepEqual([...pruned.selection.nodes], ['a']);
  assert.equal(pruned.gesture, state.gesture);
});

void test('回归：框选多选→右键删一个→Delete 只删其余且一次成功', () => {
  const instance = controller(documentWith(['a', 'b', 'c'], []));
  let selection: CanvasSelection = { nodes: new Set(['a', 'b', 'c']), edges: new Set<string>() };

  assert.equal(instance.execute(createRemoveNodeCommands(['b'])), true);
  selection = pruneSelection(selection, instance.getDocument());
  assert.deepEqual([...selection.nodes], ['a', 'c']);

  const commands = createDeleteSelectionCommands(
    instance.getDocument(),
    [...selection.nodes],
    [...selection.edges],
  );
  assert.deepEqual(commands, [
    { kind: 'removeNode', id: 'a' },
    { kind: 'removeNode', id: 'c' },
  ]);
  assert.equal(instance.execute(commands), true);
  assert.equal(instance.getDocument().nodes.length, 0);
});

void test('删除命令生成时过滤死 id，只保留文档内目标', () => {
  const document = documentWith(['a', 'b'], ['e1']);
  assert.deepEqual(createDeleteSelectionCommands(document, ['a', 'dead-node'], ['dead-edge']), [
    { kind: 'removeNode', id: 'a' },
  ]);
  assert.deepEqual(createDeleteSelectionCommands(document, ['dead-node'], ['e1', 'dead-edge']), [
    { kind: 'removeEdge', id: 'e1' },
  ]);
  assert.deepEqual(createDeleteSelectionCommands(document, ['dead-node'], ['dead-edge']), []);
});
