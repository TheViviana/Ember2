import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withDocumentTags } from '../../src/core/frontmatter-edit.ts';

const DOC = [
  '---',
  'id: doc-1',
  'title: 计划',
  'tags:',
  '  - 旧标签',
  '---',
  '',
  '# 正文',
  '',
  '内容保持不动。',
].join('\n');

void test('增删标签只改 frontmatter.tags，正文与其余键不变', () => {
  const added = withDocumentTags(DOC, ['项目/前端', '读书']);
  assert.equal(added.error, null);
  assert.match(added.text, /id: doc-1/);
  assert.match(added.text, /title: 计划/);
  assert.match(added.text, /内容保持不动。/);
  const back = withDocumentTags(added.text, ['读书']);
  assert.equal(back.error, null);
  assert.match(back.text, /- 读书/);
  assert.doesNotMatch(back.text, /项目\/前端/);
});

void test('清空标签时移除 tags 字段但保留其余 frontmatter', () => {
  const result = withDocumentTags(DOC, []);
  assert.equal(result.error, null);
  assert.doesNotMatch(result.text, /tags:/);
  assert.match(result.text, /id: doc-1/);
  assert.match(result.text, /内容保持不动。/);
});

void test('无 frontmatter 时插入新块；非法标签被规范化或忽略', () => {
  const result = withDocumentTags('正文', ['  项目//前端 ', '   ']);
  assert.equal(result.error, null);
  assert.match(result.text, /^---\n/);
  assert.match(result.text, /- 项目\/前端/);
  assert.match(result.text, /正文$/);
});

void test('frontmatter 非映射时拒绝写入，原文不改', () => {
  const text = '---\n- 数组项\n---\n正文';
  const result = withDocumentTags(text, ['a']);
  assert.notEqual(result.error, null);
  assert.equal(result.text, text);
});
