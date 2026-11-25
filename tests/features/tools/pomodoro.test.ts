import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createPomodoroController,
  type PomodoroClock,
  type PomodoroScheduler,
} from '../../../src/features/tools/pomodoro.ts';

class FakeClock implements PomodoroClock {
  private timeMs = 0;

  now(): number {
    return this.timeMs;
  }

  advance(ms: number): void {
    this.timeMs += ms;
  }
}

class FakeScheduler implements PomodoroScheduler {
  private nextHandle = 1;
  private readonly callbacks = new Map<number, () => void>();
  intervalMs: number | null = null;

  setInterval(callback: () => void, intervalMs: number): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.callbacks.set(handle, callback);
    this.intervalMs = intervalMs;
    return handle;
  }

  clearInterval(handle: unknown): void {
    assert.equal(typeof handle, 'number');
    this.callbacks.delete(handle as number);
  }

  tick(): void {
    for (const callback of [...this.callbacks.values()]) callback();
  }

  get activeCount(): number {
    return this.callbacks.size;
  }
}

function createHarness(focusMinutes = 25, shortBreakMinutes = 5) {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler();
  const controller = createPomodoroController({
    clock,
    scheduler,
    focusMinutes,
    shortBreakMinutes,
  });
  return {
    clock,
    scheduler,
    controller,
    tick: (ms = 0): void => {
      clock.advance(ms);
      scheduler.tick();
    },
  };
}

void test('默认 25/5 分钟，开始建立绝对 deadline，暂停保存剩余并释放 interval', () => {
  const { controller, scheduler, clock } = createHarness();
  assert.equal(controller.getSnapshot().remainingMs, 25 * 60_000);
  assert.equal(controller.getSnapshot().shortBreakMinutes, 5);
  assert.equal(scheduler.activeCount, 0);

  controller.start();
  assert.equal(controller.getSnapshot().status, 'running');
  assert.equal(scheduler.activeCount, 1);
  clock.advance(60_000);
  scheduler.tick();
  assert.equal(controller.getSnapshot().remainingMs, 24 * 60_000);

  controller.pause();
  assert.equal(controller.getSnapshot().status, 'paused');
  assert.equal(controller.getSnapshot().remainingMs, 24 * 60_000);
  assert.equal(scheduler.activeCount, 0);
  clock.advance(10 * 60_000);
  scheduler.tick();
  assert.equal(controller.getSnapshot().remainingMs, 24 * 60_000);
});

void test('继续按当前 clock 重建 deadline，不补算暂停期间时间', () => {
  const { controller, clock, scheduler, tick } = createHarness(1, 1);
  controller.start();
  tick(40_000);
  controller.pause();
  clock.advance(5 * 60_000);

  controller.resume();
  assert.equal(scheduler.activeCount, 1);
  tick(19_999);
  assert.equal(controller.getSnapshot().phase, 'focus');
  assert.equal(controller.getSnapshot().remainingMs, 1);
  tick(1);
  assert.equal(controller.getSnapshot().phase, 'short-break');
  assert.equal(controller.getSnapshot().remainingMs, 60_000);
  assert.equal(controller.getSnapshot().completedRounds, 1);
});

void test('专注与短休在 deadline 自动切换，完成专注累计轮次', () => {
  const { controller, tick } = createHarness(1, 1);
  controller.start();
  tick(60_000);
  assert.equal(controller.getSnapshot().phase, 'short-break');
  assert.equal(controller.getSnapshot().completedRounds, 1);
  assert.equal(controller.getSnapshot().remainingMs, 60_000);
  tick(60_000);
  assert.equal(controller.getSnapshot().phase, 'focus');
  assert.equal(controller.getSnapshot().completedRounds, 1);
  tick(60_000);
  assert.equal(controller.getSnapshot().phase, 'short-break');
  assert.equal(controller.getSnapshot().completedRounds, 2);
});

void test('后台跨周期长 tick 从旧 deadline 接续，不累计调度漂移', () => {
  const { controller, tick } = createHarness(1, 1);
  controller.start();
  tick(5 * 60_000 + 10_000);
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.phase, 'short-break');
  assert.equal(snapshot.completedRounds, 3);
  assert.equal(snapshot.remainingMs, 50_000);
});

void test('暂停前未 tick 也按 clock.now 校准，长 tick 不按次数扣时', () => {
  const { controller, clock, scheduler } = createHarness(2, 1);
  controller.start();
  clock.advance(45_000);
  controller.pause();
  assert.equal(controller.getSnapshot().remainingMs, 75_000);
  controller.resume();
  for (let index = 0; index < 100; index += 1) scheduler.tick();
  assert.equal(controller.getSnapshot().remainingMs, 75_000);
  clock.advance(75_000);
  scheduler.tick();
  assert.equal(controller.getSnapshot().phase, 'short-break');
  assert.equal(controller.getSnapshot().remainingMs, 60_000);
});

void test('重置停止当前周期并应用最新配置，保留已完成轮次', () => {
  const { controller, scheduler, tick } = createHarness(1, 1);
  controller.start();
  tick(60_000);
  controller.setDurations({ shortBreakMinutes: 2 });
  tick(30_000);
  controller.reset();
  assert.equal(controller.getSnapshot().status, 'idle');
  assert.equal(controller.getSnapshot().phase, 'short-break');
  assert.equal(controller.getSnapshot().remainingMs, 120_000);
  assert.equal(controller.getSnapshot().completedRounds, 1);
  assert.equal(scheduler.activeCount, 0);
});

void test('时长仅立即更新未开始周期，运行中 deadline 不变且后续周期用新值', () => {
  const { controller, tick } = createHarness(30, 5);
  controller.setDurations({ focusMinutes: 30, shortBreakMinutes: 10 });
  assert.equal(controller.getSnapshot().remainingMs, 30 * 60_000);
  controller.start();
  tick(60_000);
  controller.setDurations({ focusMinutes: 40, shortBreakMinutes: 20 });
  assert.equal(controller.getSnapshot().remainingMs, 29 * 60_000);

  tick(29 * 60_000);
  assert.equal(controller.getSnapshot().phase, 'short-break');
  assert.equal(controller.getSnapshot().remainingMs, 20 * 60_000);
  tick(20 * 60_000);
  assert.equal(controller.getSnapshot().phase, 'focus');
  assert.equal(controller.getSnapshot().remainingMs, 40 * 60_000);
});

void test('时长校验、订阅退订与 dispose 释放显示调度器', () => {
  const { controller, scheduler, tick } = createHarness();
  assert.throws(() => controller.setDurations({ focusMinutes: 0 }), /1–180/);
  assert.throws(() => controller.setDurations({ shortBreakMinutes: 181 }), /1–180/);
  assert.throws(() => controller.setDurations({ focusMinutes: Number.NaN }), /1–180/);

  let notifications = 0;
  const unsubscribe = controller.subscribe(() => { notifications += 1; });
  controller.start();
  tick(1000);
  assert.equal(notifications, 2);
  unsubscribe();
  tick(1000);
  assert.equal(notifications, 2);
  controller.dispose();
  assert.equal(scheduler.activeCount, 0);
  tick(25 * 60_000);
  assert.equal(controller.getSnapshot().phase, 'focus');
});
