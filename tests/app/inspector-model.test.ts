import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countCharacters,
  formatModified,
  savePhase,
} from '../../src/app/panels/inspector-model.ts';

void test('savePhase：未打开文档返回 null', () => {
  assert.equal(savePhase(null), null);
});

void test('savePhase：error > saving > dirty > clean', () => {
  assert.equal(savePhase({ dirty: false, saving: false, error: null }), 'clean');
  assert.equal(savePhase({ dirty: true, saving: false, error: null }), 'dirty');
  assert.equal(savePhase({ dirty: true, saving: true, error: null }), 'saving');
  assert.equal(savePhase({ dirty: false, saving: true, error: null }), 'saving');
  assert.equal(savePhase({ dirty: false, saving: false, error: new Error('disk') }), 'error');
  assert.equal(savePhase({ dirty: true, saving: true, error: new Error('disk') }), 'error');
});

void test('countCharacters：忽略空白并按码点计数', () => {
  assert.equal(countCharacters(''), 0);
  assert.equal(countCharacters('  a b\n c\t'), 3);
  assert.equal(countCharacters('你好 世界'), 4);
  assert.equal(countCharacters('😀😀'), 2);
});

void test('formatModified：无效时间显示占位符，有效时间带年份', () => {
  assert.equal(formatModified(0), '—');
  assert.equal(formatModified(-1), '—');
  const stamp = formatModified(new Date(2026, 10, 16, 9, 5).getTime());
  assert.match(stamp, /2026/);
});
