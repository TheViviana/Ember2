import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeTagList, normalizeTagPath, tagLeaf, tagRoot } from '../../src/core/tag-path.ts';

void test('normalizeTagPath 支持斜杠层级并折叠重复分隔符', () => {
  assert.equal(normalizeTagPath('项目/前端'), '项目/前端');
  assert.equal(normalizeTagPath(' /项目//前端/ '), '项目/前端');
  assert.equal(normalizeTagPath('#读书'), '读书');
  assert.equal(normalizeTagPath('   '), null);
  assert.equal(normalizeTagPath('///'), null);
  assert.equal(normalizeTagPath('a'.repeat(121)), null);
});

void test('normalizeTagList 去重并保持顺序，丢弃非法项', () => {
  assert.deepEqual(
    [...normalizeTagList(['项目/前端', '项目/前端', ' ', '读书'])],
    ['项目/前端', '读书'],
  );
});

void test('tagLeaf / tagRoot 拆分层级标签', () => {
  assert.equal(tagLeaf('项目/前端/编辑器'), '编辑器');
  assert.equal(tagLeaf('读书'), '读书');
  assert.equal(tagRoot('项目/前端/编辑器'), '项目');
  assert.equal(tagRoot('读书'), '读书');
});
