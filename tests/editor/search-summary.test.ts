import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorSelection, EditorState } from '@codemirror/state';
import { SearchQuery } from '@codemirror/search';
import { summarizeSearch } from '../../src/editor/search-summary.ts';

function stateOf(text: string, cursor = 0): EditorState {
  return EditorState.create({ doc: text, selection: EditorSelection.cursor(cursor) });
}

void test('统计大小写不敏感匹配并给当前命中序号', () => {
  const text = 'Alpha alpha ALPHA';
  const state = stateOf(text, text.indexOf('alpha'));
  const summary = summarizeSearch(state, new SearchQuery({ search: 'alpha' }));
  assert.deepEqual(summary, { total: 3, index: 2, valid: true });
});

void test('区分大小写与整词只影响匹配口径', () => {
  const text = 'cat cat3 CAT';
  const sensitive = new SearchQuery({ search: 'cat', caseSensitive: true });
  assert.equal(summarizeSearch(stateOf(text), sensitive).total, 2);
  const whole = new SearchQuery({ search: 'cat', wholeWord: true, caseSensitive: true });
  assert.equal(summarizeSearch(stateOf(text), whole).total, 1);
});

void test('正则匹配与无效正则分别给出数量与无效标记', () => {
  const state = stateOf('a1 b22 c333');
  const valid = new SearchQuery({ search: '\\d+', regexp: true });
  assert.equal(summarizeSearch(state, valid).total, 3);
  const invalid = new SearchQuery({ search: '(', regexp: true });
  assert.deepEqual(summarizeSearch(state, invalid), { total: 0, index: 0, valid: false });
});

void test('空查询不枚举匹配，未落在命中内时序号为 0', () => {
  const text = 'one two one';
  assert.equal(summarizeSearch(stateOf(text), new SearchQuery({ search: '' })).total, 0);
  const summary = summarizeSearch(stateOf(text, 4), new SearchQuery({ search: 'one' }));
  assert.deepEqual(summary, { total: 2, index: 0, valid: true });
});
