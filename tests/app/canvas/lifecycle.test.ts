/**
 * C1 dispose 编排：顺序、失败不 beginClosing、成功仅一次与幂等。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CanvasFlushError,
  createCanvasDisposer,
  type CanvasFlushReportLike,
} from '../../../src/app/canvas/lifecycle.ts';

function report(ok: boolean, timedOut = false): CanvasFlushReportLike {
  return {
    ok,
    timedOut,
    error: ok ? null : { message: timedOut ? '画布保存超时' : '画布保存失败' },
  };
}

void test('flush 成功：stop → flush(5000) → beginClosing，各一次', async () => {
  const calls: string[] = [];
  let timeoutMs: number | undefined;

  const dispose = createCanvasDisposer({
    store: {
      flush(options): Promise<CanvasFlushReportLike> {
        calls.push('flush');
        timeoutMs = options?.timeoutMs;
        return Promise.resolve(report(true));
      },
      beginClosing(): void {
        calls.push('beginClosing');
      },
    },
    stop: () => {
      calls.push('stop');
    },
  });

  await dispose();

  assert.deepEqual(calls, ['stop', 'flush', 'beginClosing']);
  assert.equal(timeoutMs, 5000);
});

void test('C4：stop 后先等待未发保存，再 flush；beforeFlush 失败时不 flush/close', async () => {
  const calls: string[] = [];
  const dispose = createCanvasDisposer({
    store: {
      flush: () => {
        calls.push('flush');
        return Promise.resolve(report(true));
      },
      beginClosing: () => {
        calls.push('beginClosing');
      },
    },
    stop: () => {
      calls.push('stop');
    },
    beforeFlush: () => {
      calls.push('beforeFlush');
      return Promise.resolve();
    },
  });
  await dispose();
  assert.deepEqual(calls, ['stop', 'beforeFlush', 'flush', 'beginClosing']);

  const failed = createCanvasDisposer({
    store: {
      flush: () => {
        calls.push('unexpected-flush');
        return Promise.resolve(report(true));
      },
      beginClosing: () => {
        calls.push('unexpected-close');
      },
    },
    stop: () => {},
    beforeFlush: () => Promise.reject(new Error('save failed')),
  });
  await assert.rejects(failed(), /save failed/);
  assert.equal(calls.includes('unexpected-flush'), false);
  assert.equal(calls.includes('unexpected-close'), false);
});

void test('自定义 timeoutMs 透传给 flush', async () => {
  let timeoutMs: number | undefined;

  const dispose = createCanvasDisposer({
    store: {
      flush(options): Promise<CanvasFlushReportLike> {
        timeoutMs = options?.timeoutMs;
        return Promise.resolve(report(true));
      },
      beginClosing(): void {},
    },
    stop: () => {},
    timeoutMs: 250,
  });

  await dispose();

  assert.equal(timeoutMs, 250);
});

void test('flush 失败：抛 E_FLUSH_FAILED，不调用 beginClosing', async () => {
  let closed = false;

  const dispose = createCanvasDisposer({
    store: {
      flush: () => Promise.resolve(report(false)),
      beginClosing(): void {
        closed = true;
      },
    },
    stop: () => {},
  });

  await assert.rejects(dispose(), (error: unknown) => {
    assert.ok(error instanceof CanvasFlushError);
    assert.equal(error.code, 'E_FLUSH_FAILED');
    assert.equal(error.message, '画布保存失败');
    return true;
  });
  assert.equal(closed, false);
});

void test('flush 超时：抛 E_FLUSH_TIMEOUT，不调用 beginClosing', async () => {
  let closed = false;

  const dispose = createCanvasDisposer({
    store: {
      flush: () => Promise.resolve(report(false, true)),
      beginClosing(): void {
        closed = true;
      },
    },
    stop: () => {},
  });

  await assert.rejects(dispose(), (error: unknown) => {
    assert.ok(error instanceof CanvasFlushError);
    assert.equal(error.code, 'E_FLUSH_TIMEOUT');
    return true;
  });
  assert.equal(closed, false);
});

void test('幂等：重复调用返回同一个 Promise，beginClosing 只执行一次', async () => {
  let flushed = 0;
  let closed = 0;

  const dispose = createCanvasDisposer({
    store: {
      flush(): Promise<CanvasFlushReportLike> {
        flushed += 1;
        return Promise.resolve(report(true));
      },
      beginClosing(): void {
        closed += 1;
      },
    },
    stop: () => {},
  });

  const first = dispose();
  const second = dispose();

  assert.equal(first, second);
  await first;
  await dispose();

  assert.equal(flushed, 1);
  assert.equal(closed, 1);
});

void test('失败后再次调用返回同一个已拒绝的 Promise，不重复 flush', async () => {
  let flushed = 0;

  const dispose = createCanvasDisposer({
    store: {
      flush(): Promise<CanvasFlushReportLike> {
        flushed += 1;
        return Promise.resolve(report(false));
      },
      beginClosing(): void {},
    },
    stop: () => {},
  });

  const first = dispose();
  const second = dispose();

  assert.equal(first, second);
  await assert.rejects(first);
  await assert.rejects(second);
  assert.equal(flushed, 1);
});
