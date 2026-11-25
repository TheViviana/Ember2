/**
 * P5-C4：保存相位、排空轮次与关窗时限（纯逻辑）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOSE_TIMEOUTS,
  INITIAL_DRAIN_STATE,
  awaitWithBudget,
  countUnsaved,
  createCloseDeadline,
  deriveSavePhase,
  planDrainRound,
  type BudgetClock,
} from '../../src/editor/save-phases.ts';

interface FakeTimer {
  readonly at: number;
  readonly callback: () => void;
}

interface FakeClock extends BudgetClock {
  advanceTo(target: number): void;
  pending(): number;
}

function createFakeClock(start = 0): FakeClock {
  const holder = { now: start, timers: [] as FakeTimer[] };
  return {
    now: () => holder.now,
    setTimer: (ms: number, callback: () => void) => {
      const timer: FakeTimer = { at: holder.now + ms, callback };
      holder.timers.push(timer);
      return () => {
        holder.timers = holder.timers.filter((candidate) => candidate !== timer);
      };
    },
    advanceTo: (target: number) => {
      holder.now = target;
      const due = holder.timers.filter((timer) => timer.at <= target);
      holder.timers = holder.timers.filter((timer) => timer.at > target);
      for (const timer of due) timer.callback();
    },
    pending: () => holder.timers.length,
  };
}

const clean = { dirty: false, saving: false, externalKind: null, errorMessage: null };
const dirty = { ...clean, dirty: true };
const saving = { ...clean, saving: true };

void test('deriveSavePhase：冲突 > 失败 > 保存中 > 未保存 > 已保存', () => {
  assert.equal(deriveSavePhase(null), 'saved');
  assert.equal(deriveSavePhase(clean), 'saved');
  assert.equal(deriveSavePhase(dirty), 'dirty');
  assert.equal(deriveSavePhase(saving), 'saving');
  assert.equal(deriveSavePhase({ ...saving, externalKind: 'updated' }), 'conflict');
  assert.equal(deriveSavePhase({ ...clean, errorMessage: '磁盘只读' }), 'error');
  // error 必须压过 dirty / saving，避免写盘失败被“未保存”掩盖。
  assert.equal(deriveSavePhase({ ...dirty, errorMessage: '磁盘只读' }), 'error');
  assert.equal(deriveSavePhase({ ...saving, errorMessage: '磁盘只读' }), 'error');
  assert.equal(
    deriveSavePhase({ ...dirty, saving: true, externalKind: 'removed' }),
    'conflict',
  );
});

void test('countUnsaved：只统计 dirty 文档', () => {
  assert.equal(countUnsaved([]), 0);
  assert.equal(countUnsaved([clean, dirty, saving]), 1);
  assert.equal(countUnsaved([dirty, { ...dirty }]), 2);
});

void test('planDrainRound：干净/文档消失即完成，dirty 发起保存，saving 只等待', () => {
  const done = planDrainRound(INITIAL_DRAIN_STATE, null);
  assert.deepEqual(done.action, { kind: 'done' });
  assert.equal(planDrainRound(INITIAL_DRAIN_STATE, clean).action.kind, 'done');

  const save = planDrainRound(INITIAL_DRAIN_STATE, dirty);
  assert.deepEqual(save.action, { kind: 'save' });
  assert.equal(save.state.round, 1);

  const wait = planDrainRound(INITIAL_DRAIN_STATE, saving);
  assert.deepEqual(wait.action, { kind: 'wait-saving' });
});

void test('planDrainRound：removed / updated 冲突直接失败（不重试保存）', () => {
  const removed = planDrainRound(INITIAL_DRAIN_STATE, {
    ...dirty,
    externalKind: 'removed',
  });
  assert.deepEqual(removed.action, { kind: 'fail', reason: 'conflict-removed' });

  const updated = planDrainRound(INITIAL_DRAIN_STATE, {
    ...dirty,
    externalKind: 'updated',
  });
  assert.deepEqual(updated.action, { kind: 'fail', reason: 'conflict-updated' });
});

void test('planDrainRound：连续两轮无进展 → no-progress', () => {
  let decision = planDrainRound(INITIAL_DRAIN_STATE, dirty);
  assert.equal(decision.action.kind, 'save');
  assert.equal(decision.state.stalled, 0);

  decision = planDrainRound(decision.state, dirty);
  assert.equal(decision.action.kind, 'save');
  assert.equal(decision.state.stalled, 1);

  decision = planDrainRound(decision.state, dirty);
  assert.deepEqual(decision.action, { kind: 'fail', reason: 'no-progress' });
  assert.equal(decision.state.stalled, 2);
});

void test('awaitWithBudget：任务先完成时返回 value，并取消遗留计时器', async () => {
  const clock = createFakeClock(0);
  const result = await awaitWithBudget(
    Promise.resolve(42),
    CLOSE_TIMEOUTS.roundMs,
    createCloseDeadline(0),
    clock,
  );
  assert.deepEqual(result, { kind: 'value', value: 42 });
  assert.equal(clock.pending(), 0, '任务胜出后不得遗留定时器');
});

void test('awaitWithBudget：阶段计时器先到 → phase-timeout（预算仍有余量）', async () => {
  const clock = createFakeClock(0);
  const pending = awaitWithBudget(
    new Promise<number>(() => undefined),
    CLOSE_TIMEOUTS.roundMs,
    createCloseDeadline(0, CLOSE_TIMEOUTS.endToEndMs),
    clock,
  );
  clock.advanceTo(CLOSE_TIMEOUTS.roundMs);
  assert.deepEqual(await pending, { kind: 'phase-timeout' });
});

void test('awaitWithBudget：阶段计时器与 T_CLOSE 同刻触发 → 端到端优先', async () => {
  const clock = createFakeClock(0);
  // 预算恰好等于阶段上限：计时器在 deadline 同刻胜出，必须归因端到端超时。
  const pending = awaitWithBudget(
    new Promise<number>(() => undefined),
    CLOSE_TIMEOUTS.roundMs,
    createCloseDeadline(0, CLOSE_TIMEOUTS.roundMs),
    clock,
  );
  clock.advanceTo(CLOSE_TIMEOUTS.roundMs);
  assert.deepEqual(await pending, { kind: 'budget-timeout' });
});

void test('awaitWithBudget：预算已耗尽时不再注册阶段计时器', async () => {
  const clock = createFakeClock(CLOSE_TIMEOUTS.endToEndMs);
  const result = await awaitWithBudget(
    new Promise<number>(() => undefined),
    CLOSE_TIMEOUTS.roundMs,
    createCloseDeadline(0),
    clock,
  );
  assert.deepEqual(result, { kind: 'budget-timeout' });
  assert.equal(clock.pending(), 0);
});

void test('awaitWithBudget：任务 rejection → error，并取消遗留计时器', async () => {
  const clock = createFakeClock(0);
  const result = await awaitWithBudget(
    Promise.reject(new Error('锁定失败')),
    CLOSE_TIMEOUTS.lockMs,
    createCloseDeadline(0),
    clock,
  );
  assert.equal(result.kind, 'error');
  assert.equal(result.kind === 'error' ? (result.error as Error).message : '', '锁定失败');
  assert.equal(clock.pending(), 0, '任务结束时不得遗留定时器');
});
