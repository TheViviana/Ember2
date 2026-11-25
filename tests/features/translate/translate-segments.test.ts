/**
 * CR-20261121-42：AI 模式段落级分段规划测试（与 Rust plan_segments 同口径）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_TRANSLATE_SEGMENTS,
  planAiSegments,
  splitTranslateParagraphs,
} from '../../../src/features/translate/translate-segments.ts';

void test('按空行分段，段内保留单换行，丢弃空白段', () => {
  const result = planAiSegments('第一段第一行\n第一段第二行。\n\n第二段！\n\n\n\n第三段；');
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(result.segments, ['第一段第一行\n第一段第二行。', '第二段！', '第三段；']);
  }
});

void test('围栏感知：代码/公式围栏内部的空行不切断段落（与 Rust 同向量钉住）', () => {
  assert.deepEqual(splitTranslateParagraphs('```py\ncode1\n\ncode2\n```\n\n围栏后段落。'), [
    '```py\ncode1\n\ncode2\n```',
    '围栏后段落。',
  ]);
  assert.deepEqual(splitTranslateParagraphs('$$\nG\n\nH\n$$\n\n公式后段落。'), [
    '$$\nG\n\nH\n$$',
    '公式后段落。',
  ]);
});

void test('CRLF 归一为 LF 后分段', () => {
  const result = planAiSegments('段落一。\r\n\r\n段落二。');
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(result.segments, ['段落一。', '段落二。']);
  }
});

void test('纯空白文本返回空段列表', () => {
  const result = planAiSegments(' \n \n\n  ');
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(result.segments, []);
  }
});

void test('段数恰好在限额内通过，超限返回明确原因', () => {
  const within = Array.from({ length: MAX_TRANSLATE_SEGMENTS }, (_, i) => `段${i}。`);
  const over = Array.from({ length: MAX_TRANSLATE_SEGMENTS + 1 }, (_, i) => `段${i}。`);
  const okResult = planAiSegments(within.join('\n\n'));
  assert.ok(okResult.ok);
  const overResult = planAiSegments(over.join('\n\n'));
  assert.ok(!overResult.ok);
  if (!overResult.ok) {
    assert.match(overResult.reason, /500 段/);
  }
});
