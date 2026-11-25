/**
 * doc-viewer-reducer：文档查看器状态机不变式（CR-20261120-27 C2-fix）。
 * 不变式：DOC_TIMEOUT 在 viewer === null 时 no-op（绝不写出无 path 的状态）；
 * token 隔离——打开 A 再打开 B，A 的超时不得改写 B。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createDocViewerState,
  docViewerReducer,
  type DocViewerAction,
  type DocViewerState,
} from '../../../src/features/media/doc-viewer-reducer.ts';

function run(state: DocViewerState, action: DocViewerAction): DocViewerState {
  return docViewerReducer(state, action);
}

const openA = (state: DocViewerState): DocViewerState =>
  run(state, { type: 'OPEN_DOC', path: 'media/doc/ab/a.pdf', kind: 'pdf' });

void test('OPEN_DOC：viewer/failed/loaded 成对复位，token 自增', () => {
  const s0 = createDocViewerState();
  assert.equal(s0.viewer, null);
  assert.equal(s0.token, 0);
  const s1 = openA(s0);
  assert.deepEqual(s1.viewer, { path: 'media/doc/ab/a.pdf', kind: 'pdf' });
  assert.equal(s1.failed, false);
  assert.equal(s1.loaded, false);
  assert.equal(s1.token, 1);
  const s2 = openA(s1);
  assert.equal(s2.token, 2, '每次打开自增');
});

void test('关闭后 DOC_TIMEOUT：仍为 null（黑屏根因的回归钉）', () => {
  const closed = run(openA(createDocViewerState()), { type: 'CLOSE_DOC' });
  assert.equal(closed.viewer, null);
  const timedOut = run(closed, { type: 'DOC_TIMEOUT', token: 1 });
  assert.equal(timedOut.viewer, null, '绝不写出无 path 的状态');
  assert.equal(timedOut.failed, false);
});

void test('打开后 DOC_TIMEOUT：置 failed；DOC_LOADED 后超时不再置 failed', () => {
  const opened = openA(createDocViewerState());
  const failed = run(opened, { type: 'DOC_TIMEOUT', token: opened.token });
  assert.equal(failed.failed, true);
  assert.notEqual(failed.viewer, null, 'viewer 保持打开以便展示失败文案');

  const loaded = run(opened, { type: 'DOC_LOADED', token: opened.token });
  assert.equal(loaded.loaded, true);
  const staleTimeout = run(loaded, { type: 'DOC_TIMEOUT', token: loaded.token });
  assert.equal(staleTimeout.failed, false, '已加载的条目不受超时影响');
});

void test('token 隔离：打开 A 再打开 B，A 的超时不改写 B', () => {
  const a = openA(createDocViewerState()); // token=1，viewer=A
  const b = run(a, { type: 'OPEN_DOC', path: 'media/doc/ab/b.html', kind: 'html' }); // token=2
  assert.equal(b.viewer?.path, 'media/doc/ab/b.html');

  const staleTimeout = run(b, { type: 'DOC_TIMEOUT', token: 1 });
  assert.equal(staleTimeout.failed, false, 'A 的旧代次超时不得改写 B');
  assert.equal(staleTimeout.viewer?.path, 'media/doc/ab/b.html');

  const staleLoaded = run(b, { type: 'DOC_LOADED', token: 1 });
  assert.equal(staleLoaded.loaded, false, '不匹配代次的 loaded 无效');

  const ownLoaded = run(b, { type: 'DOC_LOADED', token: b.token });
  assert.equal(ownLoaded.loaded, true);
  const ownTimeout = run(ownLoaded, { type: 'DOC_TIMEOUT', token: b.token });
  assert.equal(ownTimeout.failed, false, '已加载不受超时影响');
});
