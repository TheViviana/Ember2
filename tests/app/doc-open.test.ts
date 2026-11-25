/**
 * CR-R2-3：库内文档打开闸门单源（纯逻辑，无 DOM / IPC）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openLibraryDocument } from '../../src/app/doc-open.ts';

function makeDeps(options: {
  hasDoc: (path: string) => boolean;
  resolveDocPath?: (from: string) => string | null;
}) {
  const opened: string[] = [];
  const missing: string[] = [];
  return {
    opened,
    missing,
    deps: {
      hasDoc: options.hasDoc,
      resolveDocPath: options.resolveDocPath ?? (() => null),
      open: (path: string) => {
        opened.push(path);
      },
      onMissing: (path: string) => {
        missing.push(path);
      },
    },
  };
}

void test('命中：open 收到有效路径，返回 opened', () => {
  const { deps, opened, missing } = makeDeps({ hasDoc: (path) => path === 'notes/a.md' });
  assert.equal(openLibraryDocument('notes/a.md', deps), 'opened');
  assert.deepEqual(opened, ['notes/a.md']);
  assert.deepEqual(missing, []);
});

void test('未命中：只调 onMissing，open 不得被调用', () => {
  const { deps, opened, missing } = makeDeps({ hasDoc: () => false });
  assert.equal(openLibraryDocument('notes/gone.md', deps), 'missing');
  assert.deepEqual(opened, []);
  assert.deepEqual(missing, ['notes/gone.md']);
});

void test('别名：resolveDocPath 返回新路径时按新路径打开', () => {
  const { deps, opened, missing } = makeDeps({
    hasDoc: (path) => path === 'notes/new.md',
    resolveDocPath: (from) => (from === 'notes/old.md' ? 'notes/new.md' : null),
  });
  assert.equal(openLibraryDocument('notes/old.md', deps), 'opened');
  assert.deepEqual(opened, ['notes/new.md']);
  assert.deepEqual(missing, []);
});

void test('别名未命中：onMissing 收到解析后的有效路径', () => {
  const { deps, opened, missing } = makeDeps({
    hasDoc: () => false,
    resolveDocPath: () => 'notes/new.md',
  });
  assert.equal(openLibraryDocument('notes/old.md', deps), 'missing');
  assert.deepEqual(opened, []);
  assert.deepEqual(missing, ['notes/new.md']);
});
