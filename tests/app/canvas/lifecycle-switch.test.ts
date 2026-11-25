/**
 * C0-B B5：普通切换 disposer 必须 lock → beforeFlush → flush → dispose，
 * 失败恢复交互且绝不 beginClosing（本模块根本不接触该钩子）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CanvasFlushError,
  createCanvasSwitchDisposer,
  type CanvasFlushReportLike,
} from '../../../src/app/canvas/lifecycle.ts';

function report(ok: boolean, timedOut = false): CanvasFlushReportLike {
  return {
    ok,
    timedOut,
    error: ok ? null : { message: timedOut ? '画布保存超时' : '画布保存失败' },
  };
}

void test('成功：lock → beforeFlush → flush → dispose，不恢复交互', async () => {
  const calls: string[] = [];
  const disposeSwitch = createCanvasSwitchDisposer({
    lockInteraction: () => calls.push('lock'),
    resumeInteraction: () => calls.push('resume'),
    beforeFlush: () => {
      calls.push('beforeFlush');
      return Promise.resolve();
    },
    flush: () => {
      calls.push('flush');
      return Promise.resolve(report(true));
    },
    dispose: () => {
      calls.push('dispose');
    },
  });

  await disposeSwitch();
  assert.deepEqual(calls, ['lock', 'beforeFlush', 'flush', 'dispose']);
});

void test('beforeFlush 失败：resume，不 flush、不 dispose', async () => {
  const calls: string[] = [];
  const disposeSwitch = createCanvasSwitchDisposer({
    lockInteraction: () => calls.push('lock'),
    resumeInteraction: () => calls.push('resume'),
    beforeFlush: () => Promise.reject(new Error('save failed')),
    flush: () => {
      calls.push('flush');
      return Promise.resolve(report(true));
    },
    dispose: () => {
      calls.push('dispose');
    },
  });

  await assert.rejects(disposeSwitch(), /save failed/);
  assert.deepEqual(calls, ['lock', 'resume']);
});

void test('flush 失败/超时：resume，不 dispose', async () => {
  for (const [timedOut, code] of [
    [false, 'E_FLUSH_FAILED'],
    [true, 'E_FLUSH_TIMEOUT'],
  ] as const) {
    const calls: string[] = [];
    const disposeSwitch = createCanvasSwitchDisposer({
      lockInteraction: () => calls.push('lock'),
      resumeInteraction: () => calls.push('resume'),
      flush: () => Promise.resolve(report(false, timedOut)),
      dispose: () => {
        calls.push('dispose');
      },
    });

    await assert.rejects(disposeSwitch(), (error: unknown) => {
      assert.ok(error instanceof CanvasFlushError);
      assert.equal(error.code, code);
      return true;
    });
    assert.deepEqual(calls, ['lock', 'resume']);
  }
});

void test('幂等：重复调用复用同一 Promise，仅执行一次切换', async () => {
  let locks = 0;
  let disposes = 0;
  const disposeSwitch = createCanvasSwitchDisposer({
    lockInteraction: () => {
      locks += 1;
    },
    resumeInteraction: () => undefined,
    flush: () => Promise.resolve(report(true)),
    dispose: () => {
      disposes += 1;
    },
  });

  const first = disposeSwitch();
  const second = disposeSwitch();
  assert.equal(first, second);
  await first;
  await disposeSwitch();
  assert.equal(locks, 1);
  assert.equal(disposes, 1);
});
