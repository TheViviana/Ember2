import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lockAllEditors,
  registerEditorLocker,
  resumeAllEditors,
} from '../../src/app/editor-lock-registry.ts';

void test('锁定/解锁：按窗口登记，只锁一次', () => {
  const calls: string[] = [];
  const offA = registerEditorLocker('a', (locked) => calls.push(`a:${locked}`));
  const offB = registerEditorLocker('b', (locked) => calls.push(`b:${locked}`));

  lockAllEditors();
  lockAllEditors();
  assert.deepEqual(calls, ['a:true', 'b:true']);

  resumeAllEditors();
  resumeAllEditors();
  assert.deepEqual(calls, ['a:true', 'b:true', 'a:false', 'b:false']);

  offA();
  offB();
});

void test('注销：同一窗口重新登记后只保留最新锁', () => {
  const calls: string[] = [];
  const offOld = registerEditorLocker('a', (locked) => calls.push(`old:${locked}`));
  const offNew = registerEditorLocker('a', (locked) => calls.push(`new:${locked}`));

  offOld();
  lockAllEditors();
  assert.deepEqual(calls, ['new:true']);

  resumeAllEditors();
  assert.deepEqual(calls, ['new:true', 'new:false']);
  offNew();
});

void test('注销：解锁前移除的锁不再被恢复', () => {
  const calls: string[] = [];
  const off = registerEditorLocker('a', (locked) => calls.push(`a:${locked}`));
  lockAllEditors();
  off();
  resumeAllEditors();
  assert.deepEqual(calls, ['a:true'], '已注销的编辑器不再收到解锁回调');
});

void test('单个锁抛错不阻塞其他编辑器，也不阻塞关窗', () => {
  const calls: string[] = [];
  const offBroken = registerEditorLocker('broken', () => {
    throw new Error('boom');
  });
  const offOk = registerEditorLocker('ok', (locked) => calls.push(`ok:${locked}`));

  assert.doesNotThrow(() => lockAllEditors());
  assert.deepEqual(calls, ['ok:true']);

  assert.doesNotThrow(() => resumeAllEditors());
  assert.deepEqual(calls, ['ok:true', 'ok:false']);
  offBroken();
  offOk();
});
