/**
 * CR-20261119-09：shouldSyncNodeLayer 纯函数单测（A3）。
 *
 * 纯函数、无 DOM 依赖，node --test 链可直接执行。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldSyncNodeLayer } from '../../../src/app/canvas/node-sync.ts';

// ---------------------------------------------------------------- 四组合边界

void test('(false, 0) → false：不脏也没 dirty id，跳过 setNodes', () => {
  assert.equal(shouldSyncNodeLayer(false, 0), false);
});

void test('(true, 0) → true：视图重建过，即便 dirty id 为空也必须 setNodes([]) 清 ghost', () => {
  assert.equal(shouldSyncNodeLayer(true, 0), true);
});

void test('(false, 3) → true：有 dirty id，正常 setNodes', () => {
  assert.equal(shouldSyncNodeLayer(false, 3), true);
});

void test('(true, 3) → true：两个条件都成立，同样 setNodes', () => {
  assert.equal(shouldSyncNodeLayer(true, 3), true);
});

// ---------------------------------------------------------------- 边界值

void test('dirtyCount 负数 → false：非法输入按未脏处理（防御性）', () => {
  assert.equal(shouldSyncNodeLayer(false, -1), false);
  assert.equal(shouldSyncNodeLayer(true, -1), true);
});

void test('dirtyCount 极大值 → true：超过合理范围的 dirty id 同样触发', () => {
  assert.equal(shouldSyncNodeLayer(false, 1000000), true);
});
