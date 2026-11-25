/**
 * C0-C R9=D：边缘面板会话状态机（默认收起、热区唤出、延迟收起、pinned）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createEdgePanelController,
  EDGE_PANEL_COLLAPSE_MS,
} from '../../../src/app/shell/edge-panel-state.ts';

function fakeScheduler(): {
  scheduler: { schedule: (callback: () => void, delayMs: number) => unknown; cancel: (handle: unknown) => void };
  pending: () => number;
  runAll: () => void;
  delays: number[];
} {
  let next = 0;
  const tasks = new Map<number, () => void>();
  const delays: number[] = [];
  return {
    delays,
    scheduler: {
      schedule(callback, delayMs) {
        next += 1;
        tasks.set(next, callback);
        delays.push(delayMs);
        return next;
      },
      cancel(handle) {
        tasks.delete(handle as number);
      },
    },
    pending: () => tasks.size,
    runAll: () => {
      const callbacks = [...tasks.values()];
      tasks.clear();
      for (const callback of callbacks) callback();
    },
  };
}

void test('默认两侧收起', () => {
  const controller = createEdgePanelController(fakeScheduler().scheduler);
  assert.deepEqual(controller.getState().open, { left: false, right: false });
});

void test('离开热区延迟收起，延迟内重新进入则取消', () => {
  const fake = fakeScheduler();
  const controller = createEdgePanelController(fake.scheduler);

  controller.setHover('left', true);
  controller.setHover('left', false);
  assert.equal(fake.pending(), 1);
  assert.equal(fake.delays[0], EDGE_PANEL_COLLAPSE_MS);
  assert.equal(controller.getState().open.left, true, '延迟未到仍展开');

  controller.setHover('left', true);
  assert.equal(fake.pending(), 0, '重新进入取消收起');
  assert.equal(controller.getState().open.left, true);

  controller.setHover('left', false);
  fake.runAll();
  assert.equal(controller.getState().open.left, false);
  assert.equal(controller.getState().open.right, false, '两侧互不影响');
});

void test('pinned 时离开热区保持展开，取消 pin 后才允许收起', () => {
  const fake = fakeScheduler();
  const controller = createEdgePanelController(fake.scheduler);

  controller.setPinned('right', true);
  controller.setHover('right', true);
  controller.setHover('right', false);
  assert.equal(fake.pending(), 0);
  assert.equal(controller.getState().open.right, true);

  controller.setPinned('right', false);
  assert.equal(fake.pending(), 1);
  fake.runAll();
  assert.equal(controller.getState().open.right, false);
});

void test('键盘/按钮 toggle 不依赖 hover，且能重新展开', () => {
  const controller = createEdgePanelController(fakeScheduler().scheduler);
  controller.toggle('left');
  assert.equal(controller.getState().open.left, true);
  controller.toggle('left');
  assert.equal(controller.getState().open.left, false);
  controller.dispose();
  assert.equal(controller.getState().open.left, false);
});
