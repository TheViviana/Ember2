import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyDocumentReplacements,
  readDocumentSource,
  type DocumentSourceRange,
} from '../../src/core/document-source.ts';

void test('core 适配器输出全文 raw ranges，合法 frontmatter 不进入 body', () => {
  const text = '---\r\nid: doc\r\ntitle: "Title"\r\ntags: [one, 2]\r\n---\r\n# Heading\r\nBody';
  const source = readDocumentSource(text);
  const byKind = (kind: 'title' | 'tags' | 'body'): readonly DocumentSourceRange[] =>
    source.ranges.filter((range) => range.kind === kind);
  assert.deepEqual(byKind('title').map((range) => text.slice(range.start, range.end)), ['Title']);
  assert.deepEqual(byKind('tags').map((range) => text.slice(range.start, range.end)), ['one']);
  const body = byKind('body')[0];
  assert.ok(body);
  assert.equal(text.slice(body.start, body.end), '# Heading\r\nBody');
});

void test('core 替换接受乱序 ranges，始终按全文 offset 降序切片', () => {
  const text = '---\ntitle: old\n---\nold 😀 old';
  const source = readDocumentSource(text);
  const replacements = source.ranges
    .filter((range) => range.kind === 'title' || range.kind === 'body')
    .flatMap((range) => {
      if (range.kind === 'title') return [{ range, replacement: 'new' }];
      const body = text.slice(range.start, range.end);
      const first = body.indexOf('old');
      const last = body.lastIndexOf('old');
      return [
        { range: { ...range, start: range.start + first, end: range.start + first + 3 }, replacement: 'A' },
        { range: { ...range, start: range.start + last, end: range.start + last + 3 }, replacement: 'B' },
      ];
    });
  const result = applyDocumentReplacements(source, replacements.reverse());
  assert.equal(result.error, null);
  assert.equal(result.text, '---\ntitle: new\n---\nA 😀 B');
});
