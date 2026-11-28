/**
 * 反向连线手势：in 端口起手，落点提供源 out。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInteractionState, reduceInteraction } from '../../../src/app/canvas/interaction.ts';

function startReverse() {
  return reduceInteraction(createInteractionState(), {
    type: 'pointerDown',
    point: { x: 100, y: 40 },
    button: 0,
    shiftKey: false,
    toggleKey: false,
    altKey: false,
    pan: false,
    target: { kind: 'port', port: { nodeId: 'b', portId: 'in', dir: 'in' } },
    nodes: [],
  });
}

void test('in 端口按下：建立反向草稿，起点仍是 b.in', () => {
  const down = startReverse();
  assert.deepEqual(down.effects, [
    {
      type: 'connectionDraft',
      from: { nodeId: 'b', portId: 'in', dir: 'in' },
      current: { x: 100, y: 40 },
      reverse: true,
    },
  ]);
  assert.equal(down.state.gesture?.kind, 'connection');
  assert.equal(down.state.gesture?.kind === 'connection' ? down.state.gesture.reverse : null, true);
});

void test('落到其他节点 out 端口：from=落点 out，to=起点 in', () => {
  const up = reduceInteraction(startReverse().state, {
    type: 'pointerUp',
    point: { x: 0, y: 0 },
    scale: 1,
    target: { kind: 'port', port: { nodeId: 'a', portId: 'out', dir: 'out' } },
  });
  assert.deepEqual(up.effects, [
    {
      type: 'connectionCommit',
      fromNodeId: 'a',
      fromPortId: 'out',
      toNodeId: 'b',
      toPortId: 'in',
    },
  ]);
});

void test('落到其他节点主体：自动取该节点 out', () => {
  const up = reduceInteraction(startReverse().state, {
    type: 'pointerUp',
    point: { x: 0, y: 0 },
    scale: 1,
    target: { kind: 'node', id: 'a' },
  });
  assert.deepEqual(up.effects, [
    {
      type: 'connectionCommit',
      fromNodeId: 'a',
      fromPortId: 'out',
      toNodeId: 'b',
      toPortId: 'in',
    },
  ]);
});

void test('落到空白：弹新建菜单并标记 reverse', () => {
  const up = reduceInteraction(startReverse().state, {
    type: 'pointerUp',
    point: { x: 10, y: 20 },
    scale: 1,
    target: { kind: 'blank' },
  });
  assert.deepEqual(up.effects, [
    {
      type: 'connectionDropEmpty',
      from: { nodeId: 'b', portId: 'in' },
      point: { x: 10, y: 20 },
      reverse: true,
    },
  ]);
});

void test('落到自身节点或 in 端口：取消，不产生边', () => {
  const onSelf = reduceInteraction(startReverse().state, {
    type: 'pointerUp',
    point: { x: 100, y: 40 },
    scale: 1,
    target: { kind: 'node', id: 'b' },
  });
  assert.deepEqual(onSelf.effects, [{ type: 'connectionCancel' }]);

  const onInPort = reduceInteraction(startReverse().state, {
    type: 'pointerUp',
    point: { x: 0, y: 0 },
    scale: 1,
    target: { kind: 'port', port: { nodeId: 'a', portId: 'in', dir: 'in' } },
  });
  assert.deepEqual(onInPort.effects, [{ type: 'connectionCancel' }]);
});

void test('只读态：in 端口不起手势', () => {
  const down = reduceInteraction(createInteractionState(), {
    type: 'pointerDown',
    point: { x: 100, y: 40 },
    button: 0,
    shiftKey: false,
    toggleKey: false,
    altKey: false,
    pan: false,
    target: { kind: 'port', port: { nodeId: 'b', portId: 'in', dir: 'in' } },
    nodes: [],
    readOnly: true,
  });
  assert.equal(down.state.gesture, null);
  assert.deepEqual(down.effects, []);
});