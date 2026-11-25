import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createAddDocumentNodeCommand,
  resolveFinderDocumentPath,
} from '../../../src/app/canvas/canvas-interactions.ts';

const ROOT = '/Users/zero/Vault';
const DOCS = new Set(['Notes/a.md', 'nested/deep/b.md']);
const hasDoc = (path: string): boolean => DOCS.has(path);

void test('Finder 库内且已索引的 .md 映射为相对 docPath 并生成文档节点', () => {
  const resolved = resolveFinderDocumentPath(`${ROOT}/Notes/a.md`, ROOT, hasDoc);
  assert.deepEqual(resolved, { kind: 'library', path: 'Notes/a.md' });
  if (resolved.kind !== 'library') assert.fail('预期库内文档');
  const command = createAddDocumentNodeCommand(120, 160, resolved.path);
  if (command.kind !== 'addNode') assert.fail('预期 addNode');
  assert.equal(command.node.type, 'document');
  assert.equal(command.node.docPath, 'Notes/a.md');
  assert.equal(command.node.x, 120);
  assert.equal(command.node.y, 160);
});

void test('Finder 库内未索引 .md 不生成可用节点路径', () => {
  assert.deepEqual(resolveFinderDocumentPath(`${ROOT}/Notes/new.md`, ROOT, hasDoc), {
    kind: 'unindexed',
    path: 'Notes/new.md',
  });
});

void test('Finder 库外与同前缀兄弟目录 .md 均显式拒绝', () => {
  for (const path of ['/tmp/a.md', `${ROOT}-other/Notes/a.md`]) {
    assert.deepEqual(resolveFinderDocumentPath(path, ROOT, hasDoc), { kind: 'external' });
  }
  assert.deepEqual(resolveFinderDocumentPath(`${ROOT}/Notes/a.md`, null, hasDoc), {
    kind: 'external',
  });
});

void test('Finder 路径越界段与库根本身不映射为文档', () => {
  for (const path of [`${ROOT}/../Notes/a.md`, `${ROOT}/./Notes/a.md`, `${ROOT}/`]) {
    assert.deepEqual(resolveFinderDocumentPath(path, ROOT, hasDoc), { kind: 'external' });
  }
});

void test('Windows 反斜杠根目录与文件路径映射为正斜杠相对路径', () => {
  const resolved = resolveFinderDocumentPath(
    'C:\\Vault\\nested\\deep\\b.md',
    'C:\\Vault',
    hasDoc,
  );
  assert.deepEqual(resolved, { kind: 'library', path: 'nested/deep/b.md' });
});
