/**
 * CR-20261121-42：AI 模式段落级分段规划测试（与 Rust plan_segments 同口径）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_AI_TRANSLATE_CHUNK_CHARS,
  MAX_TRANSLATE_SEGMENTS,
  planAiSegments,
  planAiTranslateChunks,
  splitLongTranslateText,
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
    assert.match(overResult.reason, /1000 段/);
  }
});

void test('超长段落按软边界切块，每块不超过上限且不丢内容', () => {
  const sentence = '这是一句用于测试超长段落切块的句子。';
  const long = sentence.repeat(300);
  const chunks = splitLongTranslateText(long);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= MAX_AI_TRANSLATE_CHUNK_CHARS);
    assert.notEqual(chunk.trim(), '');
  }
  assert.equal(chunks.join('').replace(/\s+/g, ''), long.replace(/\s+/g, ''));
});

void test('长段落切块保留原段落序号，供对照译文回填', () => {
  const short = '短段落。';
  const long = '长段落。'.repeat(700);
  const chunks = planAiTranslateChunks([short, long]);
  assert.equal(chunks[0]?.index, 0);
  assert.equal(chunks[0]?.text, short);
  assert.ok(chunks.filter((chunk) => chunk.index === 1).length > 1);
  assert.deepEqual(
    chunks.map((chunk) => chunk.index),
    [...new Set(chunks.map((chunk) => chunk.index))].flatMap((index) =>
      chunks.filter((chunk) => chunk.index === index).map(() => index),
    ),
  );
});

void test('无空格的长串也按硬上限切分，不会死循环', () => {
  const chunks = splitLongTranslateText('A'.repeat(5000), 1000);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [1000, 1000, 1000, 1000, 1000]);
});
