import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createFrameState,
  createGridInvalidation,
} from '../../../src/app/canvas/frame-state.ts';

void test('四档计时单独可读，world/nodes 的输入耗时归入下一帧', () => {
  const times = [0, 1.25, 10, 10.5];
  const state = createFrameState(() => times.shift() ?? 10.5);

  state.measureWorld(() => undefined);
  state.measureNodes(() => undefined);
  state.completeFrame(0.75, 2, true);
  assert.deepEqual(state.getStats(), {
    grid: 0.75,
    world: 1.25,
    edges: 2,
    nodes: 0.5,
    gridDraws: 1,
    degenerateFrames: 0,
  });

  state.completeFrame(0, 1, false, true);
  assert.deepEqual(state.getStats(), {
    grid: 0,
    world: 0,
    edges: 1,
    nodes: 0,
    gridDraws: 1,
    degenerateFrames: 1,
  });
});

void test('Q2 盲区 B：拖拽/选中帧 grid 不重绘，transform/size 失效后恢复', () => {
  const grid = createGridInvalidation();

  assert.equal(grid.consume(), true, '初次挂载必须绘制');
  assert.equal(grid.consume(), false, '节点拖拽不改变 grid 输入');
  assert.equal(grid.consume(), false, '选中/undo/redo 同样不改变 grid 输入');

  grid.invalidate();
  assert.equal(grid.consume(), true, 'transform 或 size 改变后立即重绘');
  assert.equal(grid.consume(), false, '恢复静态缓存');
});
