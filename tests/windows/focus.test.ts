/**
 * P5-C1：焦点判定纯函数测试（与 z 序解耦，独立可测）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextFocusableId, prevFocusableId } from '../../src/windows/focus.ts';
import type { WindowRecord } from '../../src/windows/manager.ts';

function rec(id: string, minimized = false): WindowRecord {
  return { id, contentType: 'editor', geometry: { x: 0, y: 0, width: 720, height: 480 }, minimized };
}

void test('空集合：无候选返回 null', () => {
  assert.equal(nextFocusableId([], null), null);
  assert.equal(prevFocusableId([], null), null);
});

void test('单窗口：next/prev 都回到自己', () => {
  const records = [rec('a')];
  assert.equal(nextFocusableId(records, null), 'a');
  assert.equal(nextFocusableId(records, 'a'), 'a');
  assert.equal(prevFocusableId(records, 'a'), 'a');
});

void test('多窗口：next 向后循环', () => {
  const records = [rec('a'), rec('b'), rec('c')];
  assert.equal(nextFocusableId(records, null), 'a');
  assert.equal(nextFocusableId(records, 'a'), 'b');
  assert.equal(nextFocusableId(records, 'b'), 'c');
  assert.equal(nextFocusableId(records, 'c'), 'a');
});

void test('多窗口：prev 向前循环', () => {
  const records = [rec('a'), rec('b'), rec('c')];
  assert.equal(prevFocusableId(records, null), 'c');
  assert.equal(prevFocusableId(records, 'c'), 'b');
  assert.equal(prevFocusableId(records, 'b'), 'a');
  assert.equal(prevFocusableId(records, 'a'), 'c');
});

void test('跳最小化：next/prev 都跳过 minimized 窗口', () => {
  const records = [rec('a'), rec('b', true), rec('c')];
  assert.equal(nextFocusableId(records, 'a'), 'c');
  assert.equal(nextFocusableId(records, 'c'), 'a');
  assert.equal(prevFocusableId(records, 'a'), 'c');
  assert.equal(prevFocusableId(records, 'c'), 'a');
});

void test('全部最小化：无候选返回 null', () => {
  const records = [rec('a', true), rec('b', true)];
  assert.equal(nextFocusableId(records, 'a'), null);
  assert.equal(prevFocusableId(records, 'b'), null);
});

void test('currentId 不在记录中：视为无当前，从头/尾开始', () => {
  const records = [rec('a'), rec('b')];
  assert.equal(nextFocusableId(records, 'ghost'), 'a');
  assert.equal(prevFocusableId(records, 'ghost'), 'b');
});
