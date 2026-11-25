/**
 * A1：parseDocument / parseToMdast 主路径与降级（CR-20261119-20 §5.1）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDocument, parseToMdast } from '#doc-model';

void test('parseDocument("")：最小 outcome 不抛', () => {
  const out = parseDocument('');
  assert.equal(out.tree.type, 'root');
  assert.equal(out.tree.children.length, 0);
  assert.equal(out.frontmatter, null);
  assert.equal(out.body, '');
  assert.deepEqual([...out.links], []);
  assert.deepEqual([...out.warnings], []);
});

void test('parseToMdast：返回 Root 且含 heading', () => {
  const tree = parseToMdast('# 标题\n\n段落。');
  assert.equal(tree.type, 'root');
  assert.equal(tree.children[0]?.type, 'heading');
});

void test('parseDocument：正常 md → tree/body/links，无 frontmatter', () => {
  const out = parseDocument('# 笔记\n\n见 [[别的笔记]]。');
  assert.equal(out.frontmatter, null);
  assert.equal(out.body, '# 笔记\n\n见 [[别的笔记]]。');
  assert.equal(out.tree.children[0]?.type, 'heading');
  assert.deepEqual([...out.links], [{ target: '别的笔记', label: '别的笔记', embedded: false }]);
  assert.deepEqual([...out.warnings], []);
});

void test('parseDocument：frontmatter 被剥离且字段可达', () => {
  const out = parseDocument('---\ntitle: 测试\n---\n\n正文。');
  assert.equal(out.frontmatter?.title, '测试');
  assert.equal(out.body, '\n正文。');
  assert.equal(out.tree.children[0]?.type, 'paragraph');
});

void test('parseDocument：YAML 语法错 → frontmatter null + warnings 聚合 + body 全文', () => {
  const out = parseDocument('---\ntitle: [unclosed\n---\n\n正文。');
  assert.equal(out.frontmatter, null);
  assert.equal(out.body, '---\ntitle: [unclosed\n---\n\n正文。');
  assert.ok(out.warnings.length >= 1);
  assert.ok(out.warnings[0]?.includes('frontmatter'));
});

void test('parseDocument：frontmatter 字段类型不符的 warning 传播到 outcome', () => {
  const out = parseDocument('---\ntags: 非数组\n---\n\n正文。');
  assert.equal(out.frontmatter?.tags, undefined);
  assert.ok(out.warnings.some((w) => w.includes('frontmatter.tags')));
});

void test('parseDocument：极端输入不抛（超长文本）', () => {
  const big = `${'很长的段落。\n\n'.repeat(20000)}[[末尾链接]]`;
  const out = parseDocument(big);
  assert.equal(out.tree.type, 'root');
  assert.equal(out.links.length, 1);
});

void test('parseDocument 幂等：两次调用结果一致', () => {
  const text = '---\ntitle: T\n---\n\n[[a]] 与 ![[b]]。';
  const first = parseDocument(text);
  const second = parseDocument(text);
  assert.deepEqual([...first.warnings], [...second.warnings]);
  assert.deepEqual([...first.links], [...second.links]);
  assert.deepEqual(first.frontmatter, second.frontmatter);
  assert.equal(first.tree.type, second.tree.type);
});
