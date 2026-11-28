import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanvasTransientStore } from '../../../src/app/canvas/canvas-transient-store.ts';

void test('瞬态预览：写入/读取/移除都返回需要重绘的节点', () => {
  const store = createCanvasTransientStore();
  const previews = new Map([['s1', { kind: 'count' as const, count: 3 }]]);
  assert.deepEqual(store.setSplitPreviews(previews), ['s1']);
  assert.deepEqual(store.readSplitPreview('s1'), { kind: 'count', count: 3 });

  assert.deepEqual(store.setSplitPreviews(new Map()), ['s1']);
  assert.equal(store.readSplitPreview('s1'), null);
});

void test('瞬态进度：k/N 只存当前节点，切换与清除都返回旧/新 id', () => {
  const store = createCanvasTransientStore();
  assert.deepEqual(store.setStepProgress({ nodeId: 's1', done: 3, total: 13 }), ['s1']);
  assert.deepEqual(store.readStepProgress('s1'), { done: 3, total: 13 });
  assert.equal(store.readStepProgress('s2'), null);

  assert.deepEqual(store.setStepProgress({ nodeId: 's2', done: 1, total: 5 }), ['s1', 's2']);
  assert.equal(store.readStepProgress('s1'), null);

  assert.deepEqual(store.setStepProgress(null), ['s2']);
  assert.equal(store.readStepProgress('s2'), null);
});

void test('瞬态失败标记：按现存节点裁剪，保留仍存在的块', () => {
  const store = createCanvasTransientStore();
  assert.equal(store.setStepFailed('b1', true), true);
  assert.equal(store.setStepFailed('b1', true), false, '重复标记不再触发重绘');
  assert.equal(store.setStepFailed('b2', true), true);

  store.pruneFailedBlocks(new Set(['b2']));
  assert.equal(store.readStepFailed('b1'), false, '已删除块被裁剪');
  assert.equal(store.readStepFailed('b2'), true, '现存块保留');

  assert.equal(store.setStepFailed('b2', false), true);
  assert.equal(store.readStepFailed('b2'), false);
});

void test('clear 释放全部瞬态状态', () => {
  const store = createCanvasTransientStore();
  store.setSplitPreviews(new Map([['s1', { kind: 'pending' as const }]]));
  store.setStepProgress({ nodeId: 's1', done: 1, total: 2 });
  store.setStepFailed('b1', true);

  store.clear();
  assert.equal(store.readSplitPreview('s1'), null);
  assert.equal(store.readStepProgress('s1'), null);
  assert.equal(store.readStepFailed('b1'), false);
});