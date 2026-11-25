import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DIFF_MAX_BYTES,
  DIFF_MAX_LINES,
  diffLines,
  type LineDiffOperation,
} from '../../../src/features/history/line-diff.ts';

function compact(operations: readonly LineDiffOperation[]): Array<readonly [string, string]> {
  return operations.map((operation) => [operation.type, operation.text] as const);
}

void test('共同前缀与后缀裁剪，插入行保留行号', () => {
  const result = diffLines('a\nc', 'a\nb\nc');
  assert.equal(result.simplified, false);
  assert.deepEqual(compact(result.operations), [
    ['equal', 'a'],
    ['insert', 'b'],
    ['equal', 'c'],
  ]);
  assert.deepEqual(result.operations.map((item) => [item.oldLine, item.newLine]), [
    [1, 1],
    [null, 2],
    [2, 3],
  ]);
});

void test('删除行与尾部共同行', () => {
  assert.deepEqual(compact(diffLines('a\nb\nc', 'a\nc').operations), [
    ['equal', 'a'],
    ['delete', 'b'],
    ['equal', 'c'],
  ]);
});

void test('替换稳定输出删除后新增', () => {
  assert.deepEqual(compact(diffLines('start\nold\nend', 'start\nnew\nend').operations), [
    ['equal', 'start'],
    ['delete', 'old'],
    ['insert', 'new'],
    ['equal', 'end'],
  ]);
});

void test('Myers 对移动行给出最短的两步编辑', () => {
  const operations = diffLines('a\nb\nc', 'a\nc\nb').operations;
  assert.deepEqual(compact(operations), [
    ['equal', 'a'],
    ['delete', 'b'],
    ['equal', 'c'],
    ['insert', 'b'],
  ]);
  assert.equal(operations.filter((item) => item.type !== 'equal').length, 2);
});

void test('CRLF 与 lone CR 统一按行比较', () => {
  assert.deepEqual(compact(diffLines('a\r\nb\r\n', 'a\nb\n').operations), [
    ['equal', 'a'],
    ['equal', 'b'],
    ['equal', ''],
  ]);
  assert.deepEqual(compact(diffLines('a\rb', 'a\nb').operations), [
    ['equal', 'a'],
    ['equal', 'b'],
  ]);
});

void test('空文件与末尾换行均保留语义', () => {
  assert.deepEqual(diffLines('', ''), { operations: [], simplified: false });
  assert.deepEqual(compact(diffLines('', 'a\n').operations), [
    ['insert', 'a'],
    ['insert', ''],
  ]);
  assert.deepEqual(compact(diffLines('a\n', '').operations), [
    ['delete', 'a'],
    ['delete', ''],
  ]);
});

void test('超过 2000 行退化为整段删除与新增，不做共同行裁剪', () => {
  const before = Array.from({ length: DIFF_MAX_LINES + 1 }, (_, index) => `old-${index}`).join('\n');
  const after = Array.from({ length: DIFF_MAX_LINES + 1 }, (_, index) => `new-${index}`).join('\n');
  const result = diffLines(before, after);
  assert.equal(result.simplified, true);
  assert.equal(result.operations.length, (DIFF_MAX_LINES + 1) * 2);
  assert.ok(result.operations.slice(0, DIFF_MAX_LINES + 1).every((item) => item.type === 'delete'));
  assert.ok(result.operations.slice(DIFF_MAX_LINES + 1).every((item) => item.type === 'insert'));
});

void test('2000 行边界仍使用普通 diff', () => {
  const text = Array.from({ length: DIFF_MAX_LINES }, (_, index) => String(index)).join('\n');
  const result = diffLines(text, text);
  assert.equal(result.simplified, false);
  assert.equal(result.operations.length, DIFF_MAX_LINES);
  assert.ok(result.operations.every((item) => item.type === 'equal'));
});

void test('任一版本超过 1 MiB 即整段降级', () => {
  const result = diffLines('a'.repeat(DIFF_MAX_BYTES + 1), 'small');
  assert.equal(result.simplified, true);
  assert.deepEqual(compact(result.operations), [
    ['delete', 'a'.repeat(DIFF_MAX_BYTES + 1)],
    ['insert', 'small'],
  ]);
  assert.equal(diffLines('small', 'b'.repeat(DIFF_MAX_BYTES + 1)).simplified, true);
});

void test('字节阈值按 UTF-8 计算，1 MiB 边界不降级', () => {
  assert.equal(diffLines('é'.repeat(DIFF_MAX_BYTES / 2 + 1), '').simplified, true);
  const exact = 'a'.repeat(DIFF_MAX_BYTES);
  assert.equal(diffLines(exact, exact).simplified, false);
});
