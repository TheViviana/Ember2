/**
 * A2：parseFrontmatter 字段收窄 / 类型降级 / 失败降级（CR-20261119-20 §5.1）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseFrontmatter } from '#doc-model';

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

void test('无 frontmatter：null + body 全文 + raw null + 无 error/warning', () => {
  const out = parseFrontmatter('# 只有正文');
  assert.equal(out.frontmatter, null);
  assert.equal(out.body, '# 只有正文');
  assert.equal(out.raw, null);
  assert.equal(out.error, null);
  assert.deepEqual([...out.warnings], []);
});

void test('标准 frontmatter（fixture）：已知字段全收窄 + 未知键进 extras', () => {
  const out = parseFrontmatter(fixture('frontmatter-full.md'));
  const fm = out.frontmatter;
  assert.notEqual(fm, null);
  assert.equal(fm?.id, '01ABCDEF');
  assert.equal(fm?.title, '全字段文档');
  assert.equal(fm?.summary, '两行简介。');
  assert.deepEqual([...(fm?.tags ?? [])], ['主线/调度', 'MCC/索引']);
  assert.deepEqual([...(fm?.aliases ?? [])], ['全字段', 'full-fm']);
  assert.equal(fm?.created, '2026-11-19T10:00:00Z');
  assert.equal(fm?.updated, '2026-11-19T11:00:00Z');
  assert.deepEqual(fm?.extras, { status: 'draft' });
  assert.equal(out.error, null);
  assert.deepEqual([...out.warnings], []);
});

void test('frontmatter 块被剥离：body 为正文、raw 为块内文本', () => {
  const out = parseFrontmatter('---\ntitle: T\n---\n\n正文第一行。');
  assert.equal(out.raw, 'title: T');
  assert.equal(out.body, '\n正文第一行。');
  assert.ok(!out.body.includes('---'));
});

void test('CRLF frontmatter 仍识别', () => {
  const out = parseFrontmatter('---\r\ntitle: CRLF\r\n---\r\n\r\n正文。');
  assert.equal(out.frontmatter?.title, 'CRLF');
  assert.equal(out.body, '\r\n正文。');
});

void test('空 frontmatter（---\\n---）：null 无 error', () => {
  const out = parseFrontmatter('---\n---\n正文。');
  assert.equal(out.frontmatter, null);
  assert.equal(out.error, null);
  assert.equal(out.body, '---\n---\n正文。');
});

void test('YAML 语法错：null + error + body 取全文 + warning', () => {
  const text = fixture('frontmatter-broken.md');
  const out = parseFrontmatter(text);
  assert.equal(out.frontmatter, null);
  assert.notEqual(out.error, null);
  assert.equal(out.body, text);
  assert.ok(out.warnings.length >= 1);
});

void test('tags 非数组：忽略 + warning，其余字段正常', () => {
  const out = parseFrontmatter('---\ntitle: T\ntags: 不是数组\n---\n正文。');
  assert.equal(out.frontmatter?.title, 'T');
  assert.equal(out.frontmatter?.tags, undefined);
  assert.ok(out.warnings.some((w) => w.includes('frontmatter.tags') && w.includes('非数组')));
});

void test('tags 数组含非字符串项：过滤 + warning', () => {
  const out = parseFrontmatter('---\ntags:\n  - ok\n  - 42\n  - 也能用\n---\n正文。');
  assert.deepEqual([...(out.frontmatter?.tags ?? [])], ['ok', '也能用']);
  assert.ok(out.warnings.some((w) => w.includes('frontmatter.tags') && w.includes('非字符串')));
});

void test('标量字段非字符串（数字 id）：忽略 + warning', () => {
  const out = parseFrontmatter('---\nid: 12345\n---\n正文。');
  assert.equal(out.frontmatter?.id, undefined);
  assert.ok(out.warnings.some((w) => w.includes('frontmatter.id')));
});

void test('顶层非映射（标量）：null + error + body 全文', () => {
  const out = parseFrontmatter('---\n只是一个字符串\n---\n正文。');
  assert.equal(out.frontmatter, null);
  assert.notEqual(out.error, null);
  assert.equal(out.body, '---\n只是一个字符串\n---\n正文。');
});

void test('未知键不丢：extras 原样保留任意值', () => {
  const out = parseFrontmatter('---\nstatus: draft\nweight: 3\nnested:\n  a: 1\n---\n正文。');
  assert.deepEqual(out.frontmatter?.extras, { status: 'draft', weight: 3, nested: { a: 1 } });
});
