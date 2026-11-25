import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveEditorDocumentPath } from '../../src/app/panels/editor-document-path.ts';

void test('EditorWindow 路径解析：未迁移时使用窗口 id', () => {
  assert.equal(resolveEditorDocumentPath('old.md', () => null), 'old.md');
});

void test('EditorWindow 路径解析：迁移后使用 core 别名终点，窗口 id 不变', () => {
  const aliases = new Map([['old.md', 'new.md']]);
  const windowId = 'old.md';
  const path = resolveEditorDocumentPath(windowId, (from) => aliases.get(from) ?? null);

  assert.equal(path, 'new.md');
  assert.equal(windowId, 'old.md');
});
