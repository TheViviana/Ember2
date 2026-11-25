import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanvasDocument } from '#canvas-format';
import { inspectConnectionCandidate } from '../../../src/app/canvas/canvas-interactions.ts';
import {
  createInteractionState,
  reduceInteraction,
  type CanvasHitTarget,
} from '../../../src/app/canvas/interaction.ts';

const ports = [
  { id: 'in', dir: 'in' },
  { id: 'out', dir: 'out' },
] as const;

const document: CanvasDocument = {
  schemaVersion: 2,
  nodes: [
    { id: 'a', x: 0, y: 0, type: 'text', ports },
    { id: 'b', x: 200, y: 0, type: 'text', ports },
    { id: 'c', x: 400, y: 0, type: 'text', ports },
    { id: 'group', x: 0, y: 200, type: 'group', ports },
  ],
  edges: [
    {
      id: 'e1',
      from: { nodeId: 'a', portId: 'out' },
      to: { nodeId: 'b', portId: 'in' },
    },
  ],
};

void test('I9 预检：组作为起点或终点均在 mutate 前拒绝', () => {
  const toGroup = inspectConnectionCandidate(document, {
    from: { nodeId: 'a', portId: 'out' },
    to: { nodeId: 'group', portId: 'in' },
  });
  const fromGroup = inspectConnectionCandidate(document, {
    from: { nodeId: 'group', portId: 'out' },
    to: { nodeId: 'b', portId: 'in' },
  });

  assert.ok(toGroup.some((issue) => issue.code === 'E_SCHEMA_GROUP'));
  assert.ok(fromGroup.some((issue) => issue.code === 'E_SCHEMA_GROUP'));
});

void test('I9 预检：仅完全相同的端口对重复，分叉与汇入仍允许', () => {
  const duplicate = inspectConnectionCandidate(document, {
    from: { nodeId: 'a', portId: 'out' },
    to: { nodeId: 'b', portId: 'in' },
  });
  const fork = inspectConnectionCandidate(document, {
    from: { nodeId: 'a', portId: 'out' },
    to: { nodeId: 'c', portId: 'in' },
  });
  const join = inspectConnectionCandidate(document, {
    from: { nodeId: 'c', portId: 'out' },
    to: { nodeId: 'b', portId: 'in' },
  });

  assert.ok(duplicate.some((issue) => issue.code === 'E_SCHEMA_EDGE_REF'));
  assert.deepEqual(fork, []);
  assert.deepEqual(join, []);
});

void test('I9 预检只读候选文档，不改写原节点或边', () => {
  const before = JSON.stringify(document);
  inspectConnectionCandidate(document, {
    from: { nodeId: 'a', portId: 'out' },
    to: { nodeId: 'b', portId: 'in' },
  });
  assert.equal(JSON.stringify(document), before);
});

function startConnection() {
  return reduceInteraction(createInteractionState(), {
    type: 'pointerDown',
    point: { x: 0, y: 0 },
    button: 0,
    shiftKey: false,
    toggleKey: false,
    altKey: false,
    pan: false,
    target: { kind: 'port', port: { nodeId: 'a', portId: 'out', dir: 'out' } },
    nodes: [],
  });
}

void test('源节点、已有连线与其他非直连落点取消，不弹建节点菜单', () => {
  const targets: readonly CanvasHitTarget[] = [
    { kind: 'node', id: 'a' },
    { kind: 'port', port: { nodeId: 'a', portId: 'in', dir: 'in' } },
    { kind: 'port', port: { nodeId: 'b', portId: 'out', dir: 'out' } },
    { kind: 'edge', id: 'e1' },
  ];

  for (const target of targets) {
    const result = reduceInteraction(startConnection().state, {
      type: 'pointerUp',
      point: { x: 20, y: 20 },
      scale: 1,
      target,
    });
    assert.equal(result.state.gesture, null);
    assert.deepEqual(result.effects, [{ type: 'connectionCancel' }]);
  }
});
