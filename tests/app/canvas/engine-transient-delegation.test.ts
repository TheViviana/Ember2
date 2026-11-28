import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CanvasEngine } from '../../../src/app/canvas/engine.ts';
import { createCanvasTransientStore } from '../../../src/app/canvas/canvas-transient-store.ts';

interface EngineInternals {
  transient: ReturnType<typeof createCanvasTransientStore>;
  mounted: boolean;
  dirtyNodeIds: Set<string>;
  scheduleFrame(): void;
}

function internals(): { engine: CanvasEngine; state: EngineInternals & { frames: number } } {
  const state = {
    transient: createCanvasTransientStore(),
    mounted: true,
    dirtyNodeIds: new Set<string>(),
    frames: 0,
    scheduleFrame() {
      state.frames += 1;
    },
  };
  return { engine: state as unknown as CanvasEngine, state };
}

void test('engine 委托：失败标记透传并调度重绘，重复标记不重复调度', () => {
  const { engine, state } = internals();
  CanvasEngine.prototype.setStepFailed.call(engine, 'b1', true);

  assert.equal(state.transient.readStepFailed('b1'), true, '透传到瞬态存储');
  assert.equal(state.dirtyNodeIds.has('b1'), true, '对应节点进入 dirty');
  assert.equal(state.frames, 1, '调度一次重绘');

  CanvasEngine.prototype.setStepFailed.call(engine, 'b1', true);
  assert.equal(state.frames, 1, '值未变化不重复调度');
});

void test('engine 委托：进度写入/清除都透传并重绘新旧节点', () => {
  const { engine, state } = internals();
  CanvasEngine.prototype.setStepProgress.call(engine, { nodeId: 's1', done: 3, total: 13 });

  assert.deepEqual(state.transient.readStepProgress('s1'), { done: 3, total: 13 });
  assert.equal(state.dirtyNodeIds.has('s1'), true);
  assert.equal(state.frames, 1);

  CanvasEngine.prototype.setStepProgress.call(engine, null);
  assert.equal(state.transient.readStepProgress('s1'), null);
  assert.equal(state.frames, 2, '清除进度也调度重绘');
});