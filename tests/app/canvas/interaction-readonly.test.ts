/**
 * C0-B B2：冲突只读态在预览前阻断节点拖拽，但保留选中与 pan/zoom。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createInteractionState,
  reduceInteraction,
  type CanvasHitTarget,
} from '../../../src/app/canvas/interaction.ts';

const nodes = [{ id: 'a', label: 'A', x: 0, y: 0 }];

function pointerDown(target: CanvasHitTarget, readOnly: boolean) {
  return reduceInteraction(createInteractionState(), {
    type: 'pointerDown',
    point: { x: 10, y: 10 },
    button: 0,
    shiftKey: false,
    toggleKey: false,
    altKey: false,
    pan: false,
    target,
    nodes,
    readOnly,
  });
}

void test('readOnly：节点按下只选中，不创建拖拽手势', () => {
  const result = pointerDown({ kind: 'node', id: 'a' }, true);
  assert.equal(result.state.gesture, null);
  assert.deepEqual([...result.state.selection.nodes], ['a']);
  assert.equal(result.effects.some((effect) => effect.type === 'preview'), false);
  assert.equal(result.effects.some((effect) => effect.type === 'commit'), false);

  const moved = reduceInteraction(result.state, {
    type: 'pointerMove',
    point: { x: 90, y: 90 },
    scale: 1,
  });
  assert.equal(moved.state.gesture, null);
  assert.deepEqual(moved.effects, []);
});

void test('非只读：节点按下创建拖拽手势并可提交 move', () => {
  const result = pointerDown({ kind: 'node', id: 'a' }, false);
  assert.equal(result.state.gesture?.kind, 'node');

  const up = reduceInteraction(result.state, {
    type: 'pointerUp',
    point: { x: 40, y: 10 },
    scale: 1,
    marqueeNodeIds: [],
  });
  const commit = up.effects.find((effect) => effect.type === 'commit');
  assert.ok(commit?.type === 'commit' && commit.command.kind === 'move');
});

void test('readOnly：空白拖拽仍可框选，纯视图操作不受影响', () => {
  const result = pointerDown({ kind: 'blank' }, true);
  assert.equal(result.state.gesture?.kind, 'marquee');
});
