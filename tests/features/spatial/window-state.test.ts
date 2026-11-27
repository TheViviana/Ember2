/**
 * 空间工作区窗口状态：默认布局、聚焦置顶、移动/缩放与不可变性。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SPATIAL_MAX_SIZE,
  SPATIAL_MIN_SIZE,
  clampSpatialSize,
  defaultSpatialWindows,
  focusSpatialWindow,
  moveSpatialWindow,
  resizeSpatialWindow,
} from '../../../src/features/spatial/window-state.ts';

void test('默认布局包含 markdown 与 ai-summary 两个窗口', () => {
  const windows = defaultSpatialWindows();
  assert.deepEqual(
    windows.map((item) => item.id),
    ['markdown', 'ai-summary'],
  );
  assert.deepEqual(
    windows.map((item) => item.contentType),
    ['markdown', 'ai-summary'],
  );
  assert.deepEqual(
    windows.map((item) => item.zIndex),
    [1, 2],
  );
});

void test('每次调用默认布局返回独立数组', () => {
  assert.notEqual(defaultSpatialWindows(), defaultSpatialWindows());
});

void test('聚焦把目标置顶并按 1..n 重排 zIndex', () => {
  const windows = defaultSpatialWindows();
  const next = focusSpatialWindow(windows, 'markdown');
  assert.deepEqual(
    next.map((item) => item.id),
    ['ai-summary', 'markdown'],
  );
  assert.deepEqual(
    next.map((item) => item.zIndex),
    [1, 2],
  );
  assert.equal(windows[0]?.zIndex, 1, '入参不得被修改');
});

void test('聚焦未知 id 原样返回', () => {
  const windows = defaultSpatialWindows();
  assert.equal(focusSpatialWindow(windows, 'missing'), windows);
});

void test('移动只更新目标窗口且不修改入参', () => {
  const windows = defaultSpatialWindows();
  const next = moveSpatialWindow(windows, 'ai-summary', [1.2, 0.3, -0.2]);
  assert.deepEqual(next[1]?.position, [1.2, 0.3, -0.2]);
  assert.deepEqual(windows[1]?.position, [0.95, 0.05, -0.15]);
});

void test('缩放按最小/最大尺寸夹取', () => {
  const windows = defaultSpatialWindows();
  const smaller = resizeSpatialWindow(windows, 'markdown', [0.1, 0.1]);
  assert.deepEqual(smaller[0]?.size, [SPATIAL_MIN_SIZE[0], SPATIAL_MIN_SIZE[1]]);
  const bigger = resizeSpatialWindow(windows, 'markdown', [9, 9]);
  assert.deepEqual(bigger[0]?.size, [SPATIAL_MAX_SIZE[0], SPATIAL_MAX_SIZE[1]]);
  assert.deepEqual(windows[0]?.size, [1.6, 1.05]);
});

void test('clampSpatialSize 保留区间内尺寸', () => {
  assert.deepEqual(clampSpatialSize([1.5, 1]), [1.5, 1]);
});