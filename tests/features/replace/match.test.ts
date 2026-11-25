import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyDocumentReplacements,
  readDocumentSource,
} from '../../../src/core/document-source.ts';
import {
  findDocumentMatches,
  previewDocumentMatch,
  type MatchScopes,
} from '../../../src/features/replace/match.ts';

const ALL: MatchScopes = { title: true, body: true, tags: true };

void test('字面量区分大小写且非重叠，offset 使用 UTF-16', () => {
  const text = '😀 aaaa AA aa';
  const matches = findDocumentMatches(text, 'aa', { title: false, body: true, tags: false });
  assert.deepEqual(matches.map((match) => [match.range.start, match.range.end]), [[3, 5], [5, 7], [11, 13]]);
  assert.equal(text.slice(matches[0]?.range.start, matches[0]?.range.end), 'aa');
  assert.equal(findDocumentMatches(text, '', ALL).length, 0);
  assert.equal(findDocumentMatches(text, 'aa', { title: false, body: false, tags: false }).length, 0);
});

void test('CRLF frontmatter 的 title、块 tags 与正文范围均映射到全文', () => {
  const text = '---\r\nid: doc\r\ntitle: "Hello"\r\ntags:\r\n  - Hello\r\n  - other\r\n---\r\n# Hello\r\nBody Hello';
  const matches = findDocumentMatches(text, 'Hello', ALL);
  assert.deepEqual(matches.map((match) => match.kind), ['title', 'tags', 'body', 'body']);
  for (const match of matches) assert.equal(text.slice(match.range.start, match.range.end), 'Hello');
  assert.equal(matches[0]?.range.start, text.indexOf('Hello'));
  assert.equal(matches[1]?.range.start, text.indexOf('Hello', text.indexOf('tags:')));
});

void test('流式 tags 只接受字符串标量，引号不进入替换范围', () => {
  const text = '---\ntags: [one, "two", 42, true]\n---\nbody';
  const source = readDocumentSource(text);
  const tags = source.ranges.filter((range) => range.kind === 'tags');
  assert.deepEqual(tags.map((range) => text.slice(range.start, range.end)), ['one', 'two']);
  assert.equal(findDocumentMatches(text, '42', ALL).length, 0);
});

void test('合法 title 缺失时仅回退正文第一个 H1，同 offset 由 title 去重', () => {
  const text = '---\nid: doc\n---\n# Hello\n## Hello\n# Hello\nHello';
  const matches = findDocumentMatches(text, 'Hello', ALL);
  assert.deepEqual(matches.map((match) => match.kind), ['title', 'body', 'body', 'body']);
  assert.equal(matches[0]?.range.start, text.indexOf('Hello'));
  const bodyOnly = findDocumentMatches(text, 'Hello', { title: false, body: true, tags: false });
  assert.equal(bodyOnly.length, 4);
});

void test('坏 frontmatter 按 doc-model 规则作为正文搜索', () => {
  const text = '---\ntitle: [broken\n---\nbody title';
  const matches = findDocumentMatches(text, 'title', { title: false, body: true, tags: false });
  assert.deepEqual(matches.map((match) => match.range.start), [4, text.lastIndexOf('title')]);
});

void test('多处替换按 offset 降序执行且不重排 YAML/Markdown', () => {
  const text = '---\r\ntitle: "😀 old"\r\ntags: [old, keep]\r\n---\r\nold and old\r\n';
  const source = readDocumentSource(text);
  const matches = findDocumentMatches(text, 'old', ALL);
  const result = applyDocumentReplacements(source, matches.map((match) => ({
    range: match.range,
    replacement: '新',
  })));
  assert.equal(result.error, null);
  assert.equal(result.text, '---\r\ntitle: "😀 新"\r\ntags: [新, keep]\r\n---\r\n新 and 新\r\n');
});

void test('替换导致 YAML 非法、字段类型改变或 id 变化时拒绝', () => {
  const invalid = '---\ntitle: "old"\n---\nbody';
  const invalidMatch = findDocumentMatches(invalid, 'old', ALL)[0];
  assert.ok(invalidMatch);
  assert.match(applyDocumentReplacements(readDocumentSource(invalid), [{
    range: invalidMatch.range,
    replacement: 'bad"value',
  }]).error ?? '', /frontmatter|YAML/);

  const wrongType = '---\ntitle: old\ntags: [old]\n---\nbody';
  for (const match of findDocumentMatches(wrongType, 'old', { title: true, body: false, tags: true })) {
    assert.match(applyDocumentReplacements(readDocumentSource(wrongType), [{
      range: match.range,
      replacement: '123',
    }]).error ?? '', /类型/);
  }

  const aliased = '---\ntitle: &shared old\nid: *shared\n---\nbody';
  const aliasMatch = findDocumentMatches(aliased, 'old', ALL)[0];
  assert.ok(aliasMatch);
  assert.match(applyDocumentReplacements(readDocumentSource(aliased), [{
    range: aliasMatch.range,
    replacement: 'new',
  }]).error ?? '', /id/);
});

void test('原始上下文和替换预览共享同一 raw range', () => {
  const text = 'before old after';
  const match = findDocumentMatches(text, 'old', ALL)[0];
  assert.ok(match);
  assert.deepEqual(match.context, { before: 'before ', match: 'old', after: ' after' });
  assert.deepEqual(previewDocumentMatch(match, 'new'), {
    before: 'before ',
    replacement: 'new',
    after: ' after',
  });
});
