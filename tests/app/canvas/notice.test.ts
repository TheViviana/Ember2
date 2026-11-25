import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dispatchCanvasNotice,
  type CanvasNotice,
  type CanvasNoticeCode,
} from '../../../src/app/canvas/notice.ts';

function collect(code: CanvasNoticeCode, count: number): {
  readonly received: readonly CanvasNotice[];
  readonly onceNotices: Set<CanvasNoticeCode>;
} {
  const received: CanvasNotice[] = [];
  const onceNotices = new Set<CanvasNoticeCode>();
  const listeners = new Set<(notice: CanvasNotice) => void>([
    (notice) => {
      received.push(notice);
    },
  ]);
  for (let index = 0; index < count; index += 1) {
    dispatchCanvasNotice(
      { code, message: `${code}:${index}`, persistent: false },
      onceNotices,
      listeners,
    );
  }
  return { received, onceNotices };
}

void test('错误类同码连续发生仍逐次必达，且不进入 once 状态', () => {
  for (const code of ['E_COMMAND', 'E_RESIZE_FAILED', 'E_SAVE_FAILED'] as const) {
    const result = collect(code, 2);
    assert.deepEqual(
      result.received.map((notice) => notice.message),
      [`${code}:0`, `${code}:1`],
    );
    assert.equal(result.onceNotices.size, 0);
  }
});

void test('仅精度与冲突按码去重，清理精度 once 后可再次送达', () => {
  for (const code of ['E_PRECISION', 'E_CONFLICT'] as const) {
    const result = collect(code, 2);
    assert.equal(result.received.length, 1);
    assert.equal(result.onceNotices.has(code), true);
  }

  const precision = collect('E_PRECISION', 1);
  const received: CanvasNotice[] = [...precision.received];
  const listeners = new Set<(notice: CanvasNotice) => void>([
    (notice) => {
      received.push(notice);
    },
  ]);
  precision.onceNotices.delete('E_PRECISION');
  dispatchCanvasNotice(
    { code: 'E_PRECISION', message: '重置后再次触发', persistent: true },
    precision.onceNotices,
    listeners,
  );
  assert.equal(received.length, 2);
});
