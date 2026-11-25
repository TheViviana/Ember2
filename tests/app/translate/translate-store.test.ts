/**
 * CR-20261120-40 B：translate-store 的同步失败路径必须回调 onFailure，
 * 让宿主在点击处 pushNotice（译文块在长文档视口外也能感知）。
 * 空文本与 AI 未配置两条路径都不触达 IPC，可在纯 node 环境验证。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  useTranslateStore,
  type TranslateFailure,
} from '../../../src/app/translate/translate-store.ts';

void test('空文本：start 落 error 态并回调 onFailure(kind=empty)', () => {
  const failures: TranslateFailure[] = [];
  useTranslateStore.getState().start({
    text: '   ',
    sourcePath: null,
    sourceLabel: 'x',
    onFailure: (failure) => failures.push(failure),
  });
  const state = useTranslateStore.getState();
  assert.equal(state.status, 'error');
  assert.equal(state.error, '没有可翻译的内容');
  assert.equal(state.progress, null);
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0], { kind: 'empty', message: '没有可翻译的内容' });
  useTranslateStore.getState().close();
});

void test('AI 未选模型（默认 config）：start 落 error 态并回调 onFailure(kind=unconfigured)', () => {
  const failures: TranslateFailure[] = [];
  useTranslateStore.getState().start({
    text: '你好',
    sourcePath: null,
    sourceLabel: 'x',
    onFailure: (failure) => failures.push(failure),
  });
  const state = useTranslateStore.getState();
  assert.equal(state.status, 'error');
  assert.match(state.error ?? '', /模型/);
  assert.equal(failures.length, 1);
  const failure = failures[0];
  assert.ok(failure);
  assert.equal(failure.kind, 'unconfigured');
  assert.match(failure.message, /模型/);
  useTranslateStore.getState().close();
});

void test('start 落 error 后 progress 为 null（进度条只属于联网模式）', () => {
  useTranslateStore.getState().start({ text: '   ', sourcePath: null, sourceLabel: 'x' });
  assert.equal(useTranslateStore.getState().progress, null);
  useTranslateStore.getState().close();
  assert.equal(useTranslateStore.getState().open, false);
});
