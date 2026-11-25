/**
 * 2026-11-23：AI 模型原位下拉的定位规则。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODEL_MENU_MAX_HEIGHT, modelMenuLayout } from '../../../src/app/canvas/model-menu.ts';

void test('模型框下方有空间时在下方展开，并保持模型框宽度（至少 220）', () => {
  const layout = modelMenuLayout({ left: 280, top: 100, width: 160, height: 32 }, 800, 600);
  assert.equal(layout.left, 280);
  assert.equal(layout.width, 220);
  assert.equal(layout.top, 136);
  assert.equal(layout.maxHeight, MODEL_MENU_MAX_HEIGHT);
});

void test('模型框靠近画布底部时翻到上方，不超出画布', () => {
  const layout = modelMenuLayout({ left: 40, top: 520, width: 220, height: 32 }, 800, 600);
  assert.ok(layout.top < 520);
  assert.ok(layout.top >= 8);
});

void test('靠近右边缘时横向钳制，菜单不超出画布', () => {
  const layout = modelMenuLayout({ left: 780, top: 40, width: 220, height: 32 }, 800, 600);
  assert.ok(layout.left + layout.width <= 792);
});
