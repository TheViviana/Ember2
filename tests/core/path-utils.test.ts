import assert from 'node:assert/strict';
import { test } from 'node:test';
import { posixBaseName, posixParentDir } from '../../src/core/path-utils.ts';

// 迁移前的两份既有实现，作为逐条对照的基准。
function legacyBasename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

function legacyParentDir(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

const CASES = ['', 'a', 'a/b', '/a', 'a/', 'a//b', 'a\\b'];

void test('posixBaseName 与 doc-tree 既有实现逐条一致', () => {
  for (const path of CASES) {
    assert.equal(posixBaseName(path), legacyBasename(path), path);
  }
});

void test('posixParentDir 与 doc-store 既有实现逐条一致', () => {
  for (const path of CASES) {
    assert.equal(posixParentDir(path), legacyParentDir(path), path);
  }
});

void test('反斜杠在 macOS 是合法文件名字符，不得按分隔符处理', () => {
  assert.equal(posixBaseName('a\\b'), 'a\\b');
  assert.equal(posixBaseName('dir/sub/name\\x.md'), 'name\\x.md');
  assert.equal(posixParentDir('a\\b'), '');
  assert.equal(posixParentDir('dir/sub/name\\x.md'), 'dir/sub');
});
