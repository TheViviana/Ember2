/**
 * C0-C R9=D：边缘面板会话状态机（默认收起、热区唤出、延迟收起、pinned）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  collapsePinnedLeftPanel,
  createEdgePanelController,
  EDGE_PANEL_COLLAPSE_MS,
  EDGE_PANEL_HOVER_OPEN_MS,
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

void test('悬停 120ms 才展开，离开热区延迟收起，延迟内重新进入则取消', () => {
  const fake = fakeScheduler();
  const controller = createEdgePanelController(fake.scheduler);

  controller.setHover('left', true);
  assert.equal(controller.getState().open.left, false, '未到 120ms 仍收起');
  assert.equal(fake.delays[0], EDGE_PANEL_HOVER_OPEN_MS);
  fake.runAll();
  assert.equal(controller.getState().open.left, true);

  controller.setHover('left', false);
  assert.equal(fake.pending(), 1);
  assert.equal(fake.delays.at(-1), EDGE_PANEL_COLLAPSE_MS);
  assert.equal(controller.getState().open.left, true, '延迟未到仍展开');

  controller.setHover('left', true);
  assert.equal(fake.pending(), 0, '重新进入取消收起');
  assert.equal(controller.getState().open.left, true);

  controller.setHover('left', false);
  fake.runAll();
  assert.equal(controller.getState().open.left, false);
  assert.equal(controller.getState().open.right, false, '两侧互不影响');
});

void test('悬停未满 120ms 就离开：取消展开，不残留计时器', () => {
  const fake = fakeScheduler();
  const controller = createEdgePanelController(fake.scheduler);

  controller.setHover('left', true);
  controller.setHover('left', false);
  assert.equal(controller.getState().open.left, false);
  fake.runAll();
  assert.equal(controller.getState().open.left, false, '已取消的展开计时器不得再生效');
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

void test('切看板：只收起已钉住的左浮窗，临时展开与右浮窗不动', () => {
  const fake = fakeScheduler();
  const controller = createEdgePanelController(fake.scheduler);
  controller.setPinned('left', true);
  controller.setPinned('right', true);
  controller.setHover('left', true);
  controller.setHover('right', true);

  collapsePinnedLeftPanel(controller);

  assert.equal(controller.getState().pinned.left, false);
  assert.equal(controller.getState().open.left, false);
  assert.equal(controller.getState().pinned.right, true, '右浮窗与左浮窗无关');
  assert.equal(controller.getState().open.right, true);

  // 回画布恢复钉住展开；右浮窗全程不动。
  controller.resumeLeftFromBoard();
  assert.equal(controller.getState().pinned.left, true);
  assert.equal(controller.getState().open.left, true);
  assert.equal(controller.getState().open.right, true);

  // 未钉住（仅临时展开）时 suspend 不做任何事，避免打断当前使用。
  controller.setPinned('left', false);
  controller.setHover('left', true);
  const before = controller.getState();
  collapsePinnedLeftPanel(controller);
  assert.deepEqual(controller.getState(), before);
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
