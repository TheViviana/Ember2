import test from 'node:test';
import assert from 'node:assert/strict';
import { nextMenuIndex } from '../../../src/app/canvas/menu-keyboard.ts';

void test('向下从末项环绕到首项', () => {
  assert.equal(nextMenuIndex([true, true, true], 2, 1), 0);
});

void test('向上从首项环绕到末项', () => {
  assert.equal(nextMenuIndex([true, true, true], 0, -1), 2);
});

void test('跳过禁用项', () => {
  assert.equal(nextMenuIndex([true, false, true], 0, 1), 2);
  assert.equal(nextMenuIndex([true, false, true], 2, 1), 0);
  assert.equal(nextMenuIndex([true, false, true], 2, -1), 0);
});

void test('全部禁用返回 -1', () => {
  assert.equal(nextMenuIndex([false, false], 0, 1), -1);
  assert.equal(nextMenuIndex([false, false], 0, -1), -1);
});

void test('空数组返回 -1', () => {
  assert.equal(nextMenuIndex([], -1, 1), -1);
  assert.equal(nextMenuIndex([], 0, -1), -1);
});

void test('没有有效焦点时向下取首项、向上取末项', () => {
  assert.equal(nextMenuIndex([false, true], -1, 1), 1);
  assert.equal(nextMenuIndex([true, false], -1, -1), 0);
});
