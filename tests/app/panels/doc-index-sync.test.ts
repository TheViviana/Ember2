import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isWithinPath,
  removedDocPaths,
  renamedDocPaths,
} from '../../../src/app/panels/doc-index-sync.ts';

void test('isWithinPath 只匹配自身与真正的后代', () => {
  assert.equal(isWithinPath('notes', 'notes'), true);
  assert.equal(isWithinPath('notes/a.md', 'notes'), true);
  assert.equal(isWithinPath('notes2/a.md', 'notes'), false);
  assert.equal(isWithinPath('other/a.md', 'notes'), false);
});

void test('删除对账覆盖文章自身与目录全部后代', () => {
  const docs = ['a.md', 'notes/b.md', 'notes/sub/c.md', 'notes2/d.md', 'notes.md'];
  assert.deepEqual(removedDocPaths(docs, 'a.md'), ['a.md']);
  assert.deepEqual(removedDocPaths(docs, 'notes'), ['notes/b.md', 'notes/sub/c.md']);
});

void test('改名对账按前缀迁移目录下全部文档路径', () => {
  const docs = ['notes/b.md', 'notes/sub/c.md', 'other.md'];
  assert.deepEqual(renamedDocPaths(docs, 'notes', 'journal'), {
    stale: ['notes/b.md', 'notes/sub/c.md'],
    fresh: ['journal/b.md', 'journal/sub/c.md'],
  });
  assert.deepEqual(renamedDocPaths(docs, 'notes/b.md', 'notes/x.md'), {
    stale: ['notes/b.md'],
    fresh: ['notes/x.md'],
  });
});
