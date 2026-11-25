import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mediaTargetForUrl, readMediaReferences } from '../../src/core/media-references.ts';
import { readDocumentId } from '../../src/core/document-source.ts';

void test('三种库内媒体引用按 raw offset 提取，标签取 alt 或链接文字', () => {
  const text = [
    '![海报](media/image/poster.png)',
    '[片头](media/audio/intro.mp3)',
    '[演示](media/video/demo.mp4)',
  ].join('\n\n');
  const refs = readMediaReferences(text);
  assert.deepEqual(refs.map(({ kind, path, label }) => ({ kind, path, label })), [
    { kind: 'image', path: 'media/image/poster.png', label: '海报' },
    { kind: 'audio', path: 'media/audio/intro.mp3', label: '片头' },
    { kind: 'video', path: 'media/video/demo.mp4', label: '演示' },
  ]);
  for (const ref of refs) {
    assert.equal(text.slice(ref.from, ref.to).includes(ref.path), true);
  }
});

void test('空标签回退文件名，offset 相对完整文档并随 frontmatter 位移', () => {
  const text = '---\nid: 01H\n---\n\n![](media/image/a.png)';
  const [ref] = readMediaReferences(text);
  assert.ok(ref);
  assert.equal(ref.label, 'a.png');
  assert.equal(text.slice(ref.from, ref.to), '![](media/image/a.png)');
  assert.equal(ref.from, text.indexOf('!['));
});

void test('拒绝外部、绝对、逃逸与非媒体路径', () => {
  for (const url of [
    'https://example.com/a.png',
    'file:///tmp/a.png',
    '/media/image/a.png',
    'media/image/../secret.png',
    'media/image/./a.png',
    'media\\image\\a.png',
    'media/other/a.png',
    'media/image/',
    'media/image/a.png?x=1',
    'a.png',
    '',
  ]) {
    assert.equal(mediaTargetForUrl(url), null, url);
  }
  assert.deepEqual(mediaTargetForUrl('media/video/a b.mp4'), {
    kind: 'video',
    path: 'media/video/a b.mp4',
  });
});

void test('代码块与行内代码中的引用不被渲染', () => {
  const text = [
    '```',
    '![x](media/image/a.png)',
    '```',
    '',
    '正文 `![y](media/image/b.png)` 结束',
    '',
    '[def]: media/image/c.png',
  ].join('\n');
  assert.deepEqual(readMediaReferences(text), []);
});

void test('图片嵌套在链接中只保留一个不重叠范围', () => {
  const text = '[![图](media/image/a.png)](https://example.com)';
  const refs = readMediaReferences(text);
  assert.equal(refs.length, 1);
  const [ref] = refs;
  assert.ok(ref);
  assert.equal(ref.kind, 'image');
  assert.equal(text.slice(ref.from, ref.to), '![图](media/image/a.png)');
});

void test('readDocumentId 只接受合法的字符串 frontmatter id', () => {
  assert.equal(readDocumentId('---\nid: 01H\n---\n正文'), '01H');
  assert.equal(readDocumentId('---\ntitle: 无 id\n---\n正文'), null);
  assert.equal(readDocumentId('---\nid: 123\n---\n正文'), null);
  assert.equal(readDocumentId('---\nid: [a]\n---\n正文'), null);
  assert.equal(readDocumentId('没有 frontmatter'), null);
});
