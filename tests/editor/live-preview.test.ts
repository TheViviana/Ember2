import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdown } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import {
  buildLivePreviewDecorations,
  selectionIntersectsStructure,
} from '../../src/editor/live-preview.ts';

interface Span {
  readonly from: number;
  readonly to: number;
  readonly className: string;
  readonly widget: boolean;
}

function collectSpans(text: string, cursor: number, focused = true): Span[] {
  const state = EditorState.create({
    doc: text,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown()],
  });
  const decorations = buildLivePreviewDecorations(state, focused);
  const spans: Span[] = [];
  decorations.between(0, state.doc.length, (from, to, value) => {
    const spec = value.spec as { readonly class?: unknown; readonly widget?: unknown };
    spans.push({
      from,
      to,
      className: typeof spec.class === 'string' ? spec.class : '',
      widget: spec.widget !== undefined,
    });
  });
  assert.equal(state.doc.toString(), text, '生成装饰不得改写文档');
  return spans;
}

function concealedText(text: string, spans: readonly Span[]): string[] {
  return spans
    .filter((span) => span.className === '' && !span.widget && span.to > span.from)
    .map((span) => text.slice(span.from, span.to));
}

function hasClass(spans: readonly Span[], className: string): boolean {
  return spans.some((span) => span.className.split(' ').includes(className));
}

void test('光标外隐藏标题/强调/代码/链接/引用标记并保留排版类', () => {
  const text = '# 标题\n\n**粗体** *斜体* `代码` [链接](https://example.com)\n\n> 引用';
  const spans = collectSpans(text, text.length, false);
  const hidden = concealedText(text, spans);
  assert.ok(hidden.includes('# '));
  assert.equal(hidden.filter((marker) => marker === '**').length, 2);
  assert.equal(hidden.filter((marker) => marker === '*').length, 2);
  assert.equal(hidden.filter((marker) => marker === '`').length, 2);
  assert.ok(hidden.includes('https://example.com'));
  assert.ok(hidden.includes('> '));
  assert.ok(hasClass(spans, 'ember-live-heading-1'));
  assert.ok(hasClass(spans, 'ember-live-strong'));
  assert.ok(hasClass(spans, 'ember-live-emphasis'));
  assert.ok(hasClass(spans, 'ember-live-inline-code'));
  assert.ok(hasClass(spans, 'ember-live-link'));
  assert.ok(hasClass(spans, 'ember-live-quote'));
});

void test('光标进入标题/强调/链接后仅当前结构恢复源码', () => {
  const text = '# 标题\n\n**粗体** [链接](https://example.com)';
  const headingSpans = collectSpans(text, text.indexOf('标题'));
  assert.equal(concealedText(text, headingSpans).includes('# '), false);
  assert.equal(concealedText(text, headingSpans).filter((item) => item === '**').length, 2);

  const emphasisSpans = collectSpans(text, text.indexOf('粗体'));
  assert.equal(concealedText(text, emphasisSpans).filter((item) => item === '**').length, 0);
  assert.equal(concealedText(text, emphasisSpans).includes('https://example.com'), true);

  const linkSpans = collectSpans(text, text.indexOf('链接'));
  const linkHidden = concealedText(text, linkSpans);
  assert.equal(linkHidden.includes('https://example.com'), false);
  assert.equal(linkHidden.includes('['), false);
  assert.equal(linkHidden.filter((item) => item === '**').length, 2);
});

void test('列表在光标外显示项目符号，进入行后恢复原始标记', () => {
  const text = '- 第一项\n1. 第二项';
  const inactive = collectSpans(text, text.length);
  const bullet = inactive.find((span) => span.widget);
  assert.deepEqual(bullet, {
    from: 0,
    to: 1,
    className: '',
    widget: true,
  });
  assert.ok(hasClass(inactive, 'ember-live-ordered-list-mark'));

  const active = collectSpans(text, 3);
  assert.equal(active.some((span) => span.widget), false);
});

void test('失焦时即使保留选区也显示排版，非空选区相交时显示源码', () => {
  const text = '前文 **粗体** 后文';
  const boldFrom = text.indexOf('**');
  const blurred = collectSpans(text, text.indexOf('粗体'), false);
  assert.equal(concealedText(text, blurred).filter((item) => item === '**').length, 2);
  assert.equal(selectionIntersectsStructure(
    { from: boldFrom - 2, to: boldFrom + 1 },
    { from: boldFrom, to: boldFrom + 6 },
  ), true);
  assert.equal(selectionIntersectsStructure(
    { from: boldFrom + 6, to: boldFrom + 7 },
    { from: boldFrom, to: boldFrom + 6 },
  ), false);
});

void test('frontmatter 不生成 live-preview 装饰，正文正常工作', () => {
  const text = '---\ntags: [test]\nsummary: 摘要\n---\n# 正文标题';
  const bodyFrom = text.indexOf('# 正文标题');
  const spans = collectSpans(text, 0);
  assert.equal(spans.every((span) => span.from >= bodyFrom), true);
  assert.ok(concealedText(text, spans).includes('# '));
});

void test('装饰集合为空文档安全且可迭代', () => {
  const state = EditorState.create({ doc: '', extensions: [markdown()] });
  const decorations: DecorationSet = buildLivePreviewDecorations(state);
  assert.equal(decorations.size, 0);
});
