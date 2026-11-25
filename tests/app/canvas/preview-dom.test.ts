/**
 * 画布节点阅读模式渲染测试：语义标签、任务列表、表格、公式降级与 raw HTML 纯文本。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  previewTextToDomNodes,
  type PreviewDomNode,
} from '../../../src/app/canvas/preview-dom.ts';

function first(nodes: readonly PreviewDomNode[], tag: string): PreviewDomNode | null {
  return nodes.find((node) => node.tag === tag) ?? null;
}

function textOf(node: PreviewDomNode | null): string {
  if (node === null) return '';
  if (node.tag === '#text') return node.text ?? '';
  return (node.children ?? []).map(textOf).join('');
}

void test('标题与段落渲染为语义标签，强调保留嵌套', () => {
  const nodes = previewTextToDomNodes('# 标题\n\n正文 **加粗**');
  const heading = first(nodes, 'h1');
  assert.notEqual(heading, null);
  assert.equal(textOf(heading), '标题');

  const paragraph = first(nodes, 'p');
  assert.notEqual(paragraph, null);
  const strong = first(paragraph?.children ?? [], 'strong');
  assert.equal(textOf(strong), '加粗');
});

void test('任务列表渲染 checkbox 与 task-item 标记', () => {
  const nodes = previewTextToDomNodes('- [x] 完成\n- [ ] 未完成');
  const list = first(nodes, 'ul');
  assert.notEqual(list, null);
  const items = list?.children ?? [];
  assert.equal(items.length, 2);
  const input = first(items[0]?.children ?? [], 'input');
  assert.notEqual(input, null);
  assert.equal(input?.attrs?.type, 'checkbox');
  assert.equal(input?.attrs?.['checked'], '');
  assert.equal(items[0]?.attrs?.['data-md'], 'task-item');
  assert.equal(items[1]?.attrs?.['data-md'], 'task-item');
});

void test('GFM 表格渲染 thead/tbody', () => {
  const nodes = previewTextToDomNodes('| A | B |\n| --- | --- |\n| 1 | 2 |');
  const table = first(nodes, 'table');
  assert.notEqual(table, null);
  const thead = first(table?.children ?? [], 'thead');
  const tbody = first(table?.children ?? [], 'tbody');
  assert.notEqual(thead, null);
  assert.notEqual(tbody, null);
  assert.equal(textOf(thead), 'AB');
  assert.equal(textOf(tbody), '12');
});

void test('公式降级为字面文本，不引入 KaTeX DOM', () => {
  const nodes = previewTextToDomNodes('行内 $x^2$ 与\n\n$$\n\\int_0^1 x dx\n$$');
  const paragraph = first(nodes, 'p');
  const mathInline = first(paragraph?.children ?? [], 'span');
  assert.equal(mathInline?.attrs?.['data-md'], 'math-inline');
  assert.equal(textOf(mathInline), '$x^2$');

  const mathBlock = first(nodes, 'div');
  assert.equal(mathBlock?.attrs?.['data-md'], 'math-block');
  assert.match(textOf(mathBlock), /\\int_0\^1/);
});

void test('raw HTML 只作为文本节点输出，不生成可执行标签', () => {
  const nodes = previewTextToDomNodes('<script>alert(1)</script>');
  assert.equal(first(nodes, 'script'), null);
  const pre = first(nodes, 'pre');
  assert.equal(pre?.attrs?.['data-md'], 'raw-html-block');
  assert.match(textOf(pre), /<script>alert\(1\)<\/script>/);
});

void test('双链渲染为带目标的只读 span', () => {
  const nodes = previewTextToDomNodes('参见 [[项目/计划]]');
  const paragraph = first(nodes, 'p');
  const span = (paragraph?.children ?? []).find(
    (node) => node.attrs?.['data-md'] === 'wikilink',
  );
  assert.notEqual(span, undefined);
  assert.equal(span?.attrs?.['data-wikilink-target'], '项目/计划');
  assert.equal(textOf(span ?? null), '项目/计划');
});
