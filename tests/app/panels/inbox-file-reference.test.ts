import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveInboxFileReference } from '../../../src/app/panels/inbox-file-reference.ts';

const docs = new Set(['notes/a.md']);
const hasDoc = (path: string): boolean => docs.has(path);

void test('绝对库内路径映射为已索引文档或安全媒体引用', () => {
  assert.deepEqual(
    resolveInboxFileReference('/vault/notes/a.md', '/vault', hasDoc),
    { kind: 'doc', path: 'notes/a.md' },
  );
  assert.deepEqual(
    resolveInboxFileReference('/vault/media/image/p.png', '/vault', hasDoc),
    { kind: 'media', path: 'media/image/p.png' },
  );
  assert.deepEqual(
    resolveInboxFileReference('media/audio/a.mp3', '/vault', hasDoc),
    { kind: 'media', path: 'media/audio/a.mp3' },
  );
});

void test('外部、未索引、路径逃逸与未知媒体均不生成引用', () => {
  for (const path of [
    '/outside/notes/a.md',
    '/vault/notes/missing.md',
    '/vault/../vault/notes/a.md',
    '/vault/documents/a.txt',
    'media/image/../secret.png',
  ]) {
    assert.equal(resolveInboxFileReference(path, '/vault', hasDoc), null, path);
  }
  assert.equal(resolveInboxFileReference('/vault/notes/a.md', null, hasDoc), null);
});
