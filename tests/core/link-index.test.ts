import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backlinksOf, buildLinkIndex, type LinkSource } from '../../src/core/link-index.ts';

function source(path: string, text: string): LinkSource {
  return { path, sha256: `${path}-sha`, text };
}

const SOURCES: readonly LinkSource[] = [
  source('a.md', '---\nid: a\ntitle: 甲\n---\n链接 [[b]] 与 [[子目录/c|见丙]]'),
  source('b.md', '---\nid: b\ntitle: 乙文\n---\n没有链接'),
  source('子目录/c.md', '---\nid: c\ntitle: 丙\naliases:\n  - 丙别名\n---\n指向 [[a]]'),
  source('d.md', '引用 [[丙别名]] 与 [[乙文]]'),
];

void test('按文件名 / 相对路径 / 标题 / 别名解析入链', () => {
  const index = buildLinkIndex(SOURCES);
  assert.equal(index.sourceCount, 4);
  const a = backlinksOf(index, 'a.md').map((entry) => entry.path).sort();
  assert.deepEqual(a, ['子目录/c.md']);
  const b = backlinksOf(index, 'b.md').map((entry) => entry.path).sort();
  assert.deepEqual(b, ['a.md', 'd.md']);
  const c = backlinksOf(index, '子目录/c.md').map((entry) => entry.path).sort();
  assert.deepEqual(c, ['a.md', 'd.md']);
});

void test('没有入链的文档返回空数组', () => {
  const index = buildLinkIndex([source('only.md', '无链接')]);
  assert.deepEqual([...backlinksOf(index, 'only.md')], []);
});
