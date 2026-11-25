import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFormatChange } from '../../src/editor/format-actions.ts';

void test('行内加粗包裹选区，再次应用取消包裹', () => {
  const first = buildFormatChange('hello', { from: 0, to: 5 }, 'bold');
  assert.equal(first.insert, '**hello**');
  const text = first.insert;
  const second = buildFormatChange(text, { from: first.anchor, to: first.head }, 'bold');
  assert.equal(second.insert, 'hello');
});

void test('空选区插入成对标记并把光标放中间', () => {
  const change = buildFormatChange('ab', { from: 1, to: 1 }, 'italic');
  assert.equal(change.insert, '**');
  assert.equal(change.anchor, 2);
  assert.equal(change.head, 2);
});

void test('标题替换已有前缀，列表切换保持正文', () => {
  const heading = buildFormatChange('- 条目', { from: 2, to: 2 }, 'h2');
  assert.equal(heading.insert, '## 条目');
  const task = buildFormatChange('## 任务', { from: 0, to: 4 }, 'task');
  assert.equal(task.insert, '- [ ] 任务');
  const plain = buildFormatChange('- [ ] 任务', { from: 0, to: 9 }, 'task');
  assert.equal(plain.insert, '任务');
});

void test('表格插入固定模板，链接把选区作为文字', () => {
  const table = buildFormatChange('', { from: 0, to: 0 }, 'table');
  assert.match(table.insert, /\| --- \| --- \|/);
  const link = buildFormatChange('文字', { from: 0, to: 2 }, 'link');
  assert.equal(link.insert, '[文字](url)');
});
