import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitTextByBudget } from '../../src/core/chunk-text.ts';

function sliceAll(text: string, limit: number): readonly string[] {
  return splitTextByBudget(text, limit).map((chunk) => text.slice(chunk.start, chunk.end));
}

void test('空文本与纯空白不产生块', () => {
  assert.deepEqual(splitTextByBudget('', 10), []);
  assert.deepEqual(splitTextByBudget('   \n\t\r\n', 10), []);
});

void test('短文本单块并裁掉首尾空白', () => {
  const chunks = splitTextByBudget('  hello  ', 100);
  assert.deepEqual(chunks, [{ start: 2, end: 7 }]);
});

void test('每块不超过预算且覆盖全部非空白内容', () => {
  const text = 'a'.repeat(95);
  const chunks = splitTextByBudget(text, 10);
  assert.equal(chunks.length, 10);
  for (const chunk of chunks) {
    assert.ok(chunk.end - chunk.start > 0);
    assert.ok(chunk.end - chunk.start <= 10);
  }
  assert.equal(sliceAll(text, 10).join(''), text);
});

void test('优先在段落边界切分', () => {
  const text = `${'A'.repeat(10)}\n\n${'B'.repeat(10)}\n${'C'.repeat(20)}`;
  const chunks = splitTextByBudget(text, 25);
  assert.equal(text.slice(chunks[0]?.start ?? 0, chunks[0]?.end ?? 0), 'A'.repeat(10));
});

void test('没有段落时优先在 Markdown 标题前切分', () => {
  const text = `${'A'.repeat(10)}\n# 标题\n${'B'.repeat(20)}`;
  const chunks = splitTextByBudget(text, 20);
  assert.equal(text.slice(chunks[0]?.start ?? 0, chunks[0]?.end ?? 0), 'A'.repeat(10));
});

void test('没有段落和标题时退回换行边界', () => {
  const text = `${'A'.repeat(10)}\n${'B'.repeat(30)}`;
  const chunks = splitTextByBudget(text, 20);
  assert.equal(text.slice(chunks[0]?.start ?? 0, chunks[0]?.end ?? 0), 'A'.repeat(10));
});

void test('无任何边界时硬切，但不切开代理对', () => {
  const text = `${'a'.repeat(9)}😀${'b'.repeat(9)}`;
  const chunks = splitTextByBudget(text, 10);
  for (const chunk of chunks) {
    const slice = text.slice(chunk.start, chunk.end);
    const first = slice.charCodeAt(0);
    const last = slice.charCodeAt(slice.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), '块不能以高代理项结尾');
    assert.ok(!(first >= 0xdc00 && first <= 0xdfff), '块不能以低代理项开头');
    assert.ok(chunk.end - chunk.start <= 10);
  }
  assert.equal(sliceAll(text, 10).join(''), text);
});

void test('围栏短于预算时不切进代码围栏', () => {
  const prefix = `${'前'.repeat(20)}\n\n`;
  const fence = '```\nconst a = 1;\nconst b = 2;\n```\n\n';
  const suffix = '后'.repeat(40);
  const text = prefix + fence + suffix;
  const limit = 40;
  const fenceStart = text.indexOf('```');
  const fenceEnd = text.indexOf('```', fenceStart + 3) + 3;

  for (const chunk of splitTextByBudget(text, limit)) {
    assert.ok(chunk.end - chunk.start <= limit);
    assert.ok(
      !(chunk.end > fenceStart && chunk.end < fenceEnd),
      `切点落在代码围栏内：${chunk.end}`,
    );
  }
});

void test('恰好等于预算单块，超 1 字符两块', () => {
  assert.equal(splitTextByBudget('a'.repeat(10), 10).length, 1);
  assert.equal(splitTextByBudget('a'.repeat(11), 10).length, 2);
});

void test('非法预算按 1 处理且不会死循环', () => {
  assert.equal(splitTextByBudget('abc', 0).length, 3);
  assert.equal(splitTextByBudget('abc', Number.NaN).length, 3);
});