/**
 * CR-20261119-02 P1-5：冲突面板两选与 keep-local 前置 R8 复查。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  resolveCanvasConflictAfterInspection,
  type CanvasInteractionController,
} from '../../../src/app/canvas/document-controller.ts';
import { createEmptyCanvasDocument, type CanvasDocument } from '../../../src/app/canvas/format.ts';

function conflictController(
  document: CanvasDocument,
  calls: string[],
  resolved = true,
): Pick<CanvasInteractionController, 'getDocument' | 'resolveConflict'> {
  return {
    getDocument: () => document,
    resolveConflict: (action) => {
      calls.push(action);
      return Promise.resolve(resolved);
    },
  };
}

function invalidLocalDocument(): CanvasDocument {
  return {
    ...createEmptyCanvasDocument(),
    nodes: [{ id: 'bad', label: '坏节点', x: 'not-a-number', y: 0 }],
  };
}

void test('保留本地：inspect 有 issues 即拒绝，不调用覆盖外部版本', async () => {
  const calls: string[] = [];
  const result = await resolveCanvasConflictAfterInspection(
    conflictController(invalidLocalDocument(), calls),
    'keep-local',
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /schema 问题/);
  assert.deepEqual(calls, []);
});

void test('保留本地：inspect 无 issues 才进入 keep-local 解决流程', async () => {
  const calls: string[] = [];
  const result = await resolveCanvasConflictAfterInspection(
    conflictController(createEmptyCanvasDocument(), calls),
    'keep-local',
  );
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, ['keep-local']);
});

void test('采用外部：不被本地 issues 阻塞，进入 accept-external 解决流程', async () => {
  const calls: string[] = [];
  const result = await resolveCanvasConflictAfterInspection(
    conflictController(invalidLocalDocument(), calls),
    'accept-external',
  );
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, ['accept-external']);
});

void test('底层拒绝解决时返回可见失败原因', async () => {
  const calls: string[] = [];
  const result = await resolveCanvasConflictAfterInspection(
    conflictController(createEmptyCanvasDocument(), calls, false),
    'keep-local',
  );
  assert.deepEqual(result, { ok: false, reason: '冲突处理未完成，请重试' });
  assert.deepEqual(calls, ['keep-local']);
});
