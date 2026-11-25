/**
 * CR-20261121-56：卡片字数格式与预览语种判定纯函数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatWordCount } from '../../../src/app/canvas/doc-preview.ts';
import { detectPreviewLang } from '../../../src/app/canvas/preview-dom.ts';

void test('formatWordCount：k 折算与空值口径', () => {
  assert.equal(formatWordCount(0), '');
  assert.equal(formatWordCount(-5), '');
  assert.equal(formatWordCount(999), '999 字');
  assert.equal(formatWordCount(1000), '1.0k 字');
  assert.equal(formatWordCount(2400), '2.4k 字');
  assert.equal(formatWordCount(123456), '123k 字');
});

void test('detectPreviewLang：CJK 多数=zh、拉丁多数=en、空文本=zh', () => {
  assert.equal(detectPreviewLang('这是一段中文文章，包含足够的汉字数量。'), 'zh');
  assert.equal(detectPreviewLang('The quick brown fox jumps over the lazy dog.'), 'en');
  assert.equal(detectPreviewLang('English text with 一点点中文'), 'en');
  assert.equal(detectPreviewLang('中文为主，附带少量 English'), 'zh');
  assert.equal(detectPreviewLang(''), 'zh');
});
