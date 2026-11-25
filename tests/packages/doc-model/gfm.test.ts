/**
 * A4：GFM fixture 断言——表格 / 任务列表 / 删除线 / 自动链接 / 脚注（CR-20261119-20 §5.1）。
 * 注：remark-gfm 4.0.1 支持 footnotes（autolink literals、footnotes、strikethrough、tables、
 * tasklists）——原草案「不含 footnotes」有误，2026-11-20 收口后事实更正并补 A4 断言。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseDocument, parseToMdast, type WikiLink } from '#doc-model';
import type { ListItem, Paragraph, RootContent, Table } from 'mdast';

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const findParagraph = (tree: { readonly children: readonly RootContent[] }): Paragraph | undefined =>
  tree.children.find((c): c is Paragraph => c.type === 'paragraph');

void test('GFM 表格（fixture）：table 节点 + 行列数 + 对齐', () => {
  const tree = parseToMdast(fixture('gfm-table.md'));
  const table = tree.children.find((c): c is Table => c.type === 'table');
  assert.notEqual(table, undefined);
  assert.equal(table?.children.length, 3); // 1 表头 + 2 数据行
  assert.equal(table?.children[0]?.children.length, 3);
  assert.deepEqual(table?.align, [null, 'right', null]);
});

void test('GFM 表格经 parseDocument 同样可见（pipeline 传播）', () => {
  const out = parseDocument(fixture('gfm-table.md'));
  assert.equal(out.tree.children.some((c) => c.type === 'table'), true);
});

void test('GFM 任务列表（fixture）：checked true / false / null', () => {
  const tree = parseToMdast(fixture('gfm-tasklist.md'));
  const list = tree.children.find((c): c is { type: 'list'; children: ListItem[] } => c.type === 'list');
  assert.notEqual(list, undefined);
  assert.deepEqual(
    list?.children.map((item) => item.checked),
    [true, false, null],
  );
});

void test('删除线：delete 节点包裹内容', () => {
  const tree = parseToMdast('~~被划掉~~');
  const child = findParagraph(tree)?.children[0];
  assert.equal(child?.type, 'delete');
});

void test('自动链接：<https://…> → link 节点', () => {
  const tree = parseToMdast('访问 <https://example.com> 了解。');
  const link = findParagraph(tree)?.children.find((c) => c.type === 'link');
  assert.notEqual(link, undefined);
  assert.equal(link?.url, 'https://example.com');
});

void test('GFM 脚注：footnoteReference 与 footnoteDefinition 成对出现', () => {
  const tree = parseToMdast('正文[^1]\n\n[^1]: 注释');
  const types = new Set<string>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    const record = node as { type?: string; children?: unknown[] };
    if (typeof record.type === 'string') types.add(record.type);
    for (const child of record.children ?? []) walk(child);
  };
  walk(tree);
  assert.equal(types.has('footnoteReference'), true, '正文脚注引用必须解析为 footnoteReference');
  assert.equal(types.has('footnoteDefinition'), true, '脚注定义必须解析为 footnoteDefinition');
});

void test('GFM 节点不在 parseDocument.warnings 中产生噪音', () => {
  const out = parseDocument(fixture('gfm-table.md'));
  assert.deepEqual([...out.warnings], []);
});

void test('类型出口：WikiLink 可从 #doc-model 导入（既有 aliases 断言不破坏）', () => {
  const link: WikiLink = { target: 't', label: 't', embedded: false };
  assert.equal(link.target, 't');
});
