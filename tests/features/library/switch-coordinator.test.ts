import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createSwitchCoordinator,
  type SwitchEffects,
  type SwitchStateSnapshot,
} from '../../../src/features/library/switch-coordinator.ts';

/** Effects mock：每次调用记录一个 step。不写 async —— ESLint require-await 禁止无 await 的 async。 */
function makeEffects(overrides: Partial<SwitchEffects> = {}): {
  effects: SwitchEffects;
  steps: string[];
} {
  const steps: string[] = [];
  let stateSnap: SwitchStateSnapshot | null = null;

  const base: SwitchEffects = {
    flushDocs() {
      steps.push('flushDocs');
      return Promise.resolve();
    },
    flushCanvases() {
      steps.push('flushCanvases');
      return Promise.resolve();
    },
    lockEditors() {
      steps.push('lockEditors');
    },
    resumeEditors() {
      steps.push('resumeEditors');
    },
    sealCanvases() {
      steps.push('sealCanvases');
    },
    unsealCanvases() {
      steps.push('unsealCanvases');
    },
    libraryCurrent(id: string) {
      steps.push(`libraryCurrent(${id})`);
      return Promise.resolve();
    },
    disposeCore() {
      steps.push('disposeCore');
      return Promise.resolve();
    },
    rebuildCore() {
      steps.push('rebuildCore');
      return Promise.resolve();
    },
    reloadLibraryList() {
      steps.push('reloadLibraryList');
      return Promise.resolve();
    },
    onStateChange(snap) {
      stateSnap = snap;
    },
  };

  const effects: SwitchEffects = { ...base, ...overrides };
  // 覆盖 onStateChange 时也要拿到 stateSnap —— overrides 不需要这功能
  void stateSnap;
  return { effects, steps };
}

function assertSteps(steps: string[], expected: readonly string[]): void {
  assert.deepEqual(steps, [...expected]);
}

// ── T1：全流程 happy path ────────────────────────────────────────────

void test('T1 happy path：CONFIRM → FLUSHING → LOCKING → CLOSING → SWITCHING → RELOADING → DONE', async () => {
  const { effects, steps } = makeEffects();
  const coord = createSwitchCoordinator({ effects });

  await coord.start('target-lib', "old-lib");

  assertSteps(steps, [
    'flushDocs',
    'flushCanvases',
    'lockEditors',
    'sealCanvases',
    'libraryCurrent(target-lib)',
    'disposeCore',
    'rebuildCore',
    'reloadLibraryList',
    'resumeEditors',
  ]);

  const snap = coord.getState();
  assert.equal(snap.state, 'done');
  assert.equal(snap.targetId, 'target-lib');
  assert.equal(snap.failurePhase, null);
  assert.equal(snap.failureMessage, null);
});

// ── T2：flushDocs 失败 → 不进入 LOCKING ─────────────────────────────

void test('T2 flushDocs 失败 → 不进入 LOCKING，直接 FAILED', async () => {
  const { effects, steps } = makeEffects({
    flushDocs() {
      steps.push('flushDocs');
      return Promise.reject(new Error('磁盘满'));
    },
  });
  const coord = createSwitchCoordinator({ effects });

  await coord.start('target-lib', "old-lib");

  assertSteps(steps, ['flushDocs']);
  assert.equal(coord.getState().state, 'failed');
  assert.equal(coord.getState().failurePhase, 'flushing');
  assert.match(coord.getState().failureMessage ?? '', /磁盘满/);
});

// ── T3：library_current 失败 → 恢复 seal + unlock + FAILED ──────────

void test('T3 library_current 失败 → 恢复 seal + resume + FAILED', async () => {
  const { effects, steps } = makeEffects({
    libraryCurrent(_id) {
      steps.push('libraryCurrent');
      return Promise.reject(new Error('E_NOT_FOUND'));
    },
  });
  const coord = createSwitchCoordinator({ effects });

  await coord.start('target-lib', "old-lib");

  assertSteps(steps, [
    'flushDocs',
    'flushCanvases',
    'lockEditors',
    'sealCanvases',
    'libraryCurrent',
    'unsealCanvases',
    'resumeEditors',
  ]);
  assert.equal(coord.getState().state, 'failed');
  assert.equal(coord.getState().failurePhase, 'switching');
});

// ── T4：rebuildCore 失败 + 二次 rollback 也失败 → FAILED ──────────

void test('T4 rebuildCore 失败 → 二次 libraryCurrent(oldId) + rebuildCore 也失败 → FAILED', async () => {
  let rebuildCallCount = 0;
  const { effects, steps } = makeEffects({
    rebuildCore() {
      rebuildCallCount++;
      steps.push(`rebuildCore#${rebuildCallCount}`);
      // 不管第几次都抛错：第一遍 reload + 第二遍 rollback 都失败
      return Promise.reject(new Error(`core.start 失败（第${rebuildCallCount}次）`));
    },
  });
  const coord = createSwitchCoordinator({ effects });

  await coord.start('new-lib', 'old-lib');

  assertSteps(steps, [
    'flushDocs',
    'flushCanvases',
    'lockEditors',
    'sealCanvases',
    'libraryCurrent(new-lib)',
    'disposeCore',
    'rebuildCore#1',
    'libraryCurrent(old-lib)',
    'rebuildCore#2',
    'resumeEditors',
  ]);
  assert.equal(coord.getState().state, 'failed');
  assert.match(coord.getState().failureMessage ?? '', /恢复旧库也失败/);
});

// ── T5：取消 idle 时无效 ─────────────────────────────────────────────

void test('T5 cancel 在 idle 时无效（state 仍 idle）', () => {
  const { effects } = makeEffects();
  const coord = createSwitchCoordinator({ effects });
  coord.cancel();
  assert.equal(coord.getState().state, 'idle');
});

// ── T6：只读标记 ─────────────────────────────────────────────────────

void test('T6 updateReadonly 在 DONE 后同步', async () => {
  const { effects } = makeEffects();
  const coord = createSwitchCoordinator({ effects });

  await coord.start('target', "old-lib");
  assert.equal(coord.getState().readonly, false);

  coord.updateReadonly(true);
  assert.equal(coord.getState().readonly, true);

  coord.updateReadonly(false);
  assert.equal(coord.getState().readonly, false);
});

// ── T7：初始状态 idle ────────────────────────────────────────────────

void test('T7 初始状态 idle', () => {
  const { effects } = makeEffects();
  const coord = createSwitchCoordinator({ effects });
  const snap = coord.getState();
  assert.equal(snap.state, 'idle');
  assert.equal(snap.targetId, null);
  assert.equal(snap.oldId, null);
  assert.equal(snap.failurePhase, null);
  assert.equal(snap.failureMessage, null);
  assert.equal(snap.cancellable, false);
  assert.equal(snap.readonly, false);
});
