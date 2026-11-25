import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, dirChildrenNames, flattenVisible } from '../../src/app/tree/build-tree.ts';
import type { DocMeta } from '../../src/core/vault-index.ts';

function meta(path: string): DocMeta {
  return { path, bytes: 0, sha256: 'sha', modifiedMs: 0 };
}

function docsOf(...paths: readonly string[]): ReadonlyMap<string, DocMeta> {
  return new Map(paths.map((path) => [path, meta(path)]));
}

void test('buildTree：dirs 中的占位路径按目录节点处理（新建文件夹不变文件）', () => {
  const tree = buildTree(
    new Map([
      ['未命名文件夹', meta('未命名文件夹')],
      ['notes', meta('notes')],
      ['notes/a.md', meta('notes/a.md')],
    ]),
    { dirs: new Set(['未命名文件夹', 'notes']) },
  );

  assert.deepEqual(tree, [
    {
      kind: 'dir',
      name: 'notes',
      path: 'notes',
      children: [{ kind: 'file', name: 'a.md', path: 'notes/a.md' }],
    },
    { kind: 'dir', name: '未命名文件夹', path: '未命名文件夹', children: [] },
  ]);
});

void test('buildTree：空 Map 返回空树', () => {
  assert.deepEqual(buildTree(new Map()), []);
});

void test('buildTree：根目录文件按名称码点排序', () => {
  assert.deepEqual(buildTree(docsOf('b.md', 'a.md', 'c.md')), [
    { kind: 'file', name: 'a.md', path: 'a.md' },
    { kind: 'file', name: 'b.md', path: 'b.md' },
    { kind: 'file', name: 'c.md', path: 'c.md' },
  ]);
});

void test('buildTree：目录在前、文件在后，各自按名称排序', () => {
  const tree = buildTree(docsOf('z.md', 'notes/b.md', 'a.md', 'archive/x.md'));

  assert.deepEqual(tree, [
    {
      kind: 'dir',
      name: 'archive',
      path: 'archive',
      children: [{ kind: 'file', name: 'x.md', path: 'archive/x.md' }],
    },
    {
      kind: 'dir',
      name: 'notes',
      path: 'notes',
      children: [{ kind: 'file', name: 'b.md', path: 'notes/b.md' }],
    },
    { kind: 'file', name: 'a.md', path: 'a.md' },
    { kind: 'file', name: 'z.md', path: 'z.md' },
  ]);
});

void test('buildTree：多重嵌套目录生成完整层级路径', () => {
  const tree = buildTree(docsOf('a/b/c.md', 'a/d.md', 'a/b/e/f.md', 'top.md'));

  assert.deepEqual(tree, [
    {
      kind: 'dir',
      name: 'a',
      path: 'a',
      children: [
        {
          kind: 'dir',
          name: 'b',
          path: 'a/b',
          children: [
            {
              kind: 'dir',
              name: 'e',
              path: 'a/b/e',
              children: [{ kind: 'file', name: 'f.md', path: 'a/b/e/f.md' }],
            },
            { kind: 'file', name: 'c.md', path: 'a/b/c.md' },
          ],
        },
        { kind: 'file', name: 'd.md', path: 'a/d.md' },
      ],
    },
    { kind: 'file', name: 'top.md', path: 'top.md' },
  ]);
});

void test('buildTree：嵌套层内部同样目录优先并按名称排序', () => {
  const tree = buildTree(docsOf('n/2.md', 'n/1.md', 'n/folder/3.md'));

  assert.deepEqual(tree, [
    {
      kind: 'dir',
      name: 'n',
      path: 'n',
      children: [
        {
          kind: 'dir',
          name: 'folder',
          path: 'n/folder',
          children: [{ kind: 'file', name: '3.md', path: 'n/folder/3.md' }],
        },
        { kind: 'file', name: '1.md', path: 'n/1.md' },
        { kind: 'file', name: '2.md', path: 'n/2.md' },
      ],
    },
  ]);
});

void test('flattenVisible：折叠时只输出根层，展开后按深度优先追加子行', () => {
  const tree = buildTree(docsOf('a/b.md', 'a/c/d.md', 'z.md'));

  assert.deepEqual(flattenVisible(tree, new Set()), [
    { path: 'a', name: 'a', depth: 0, kind: 'dir', hasChildren: true },
    { path: 'z.md', name: 'z.md', depth: 0, kind: 'file', hasChildren: false },
  ]);

  assert.deepEqual(flattenVisible(tree, new Set(['a'])), [
    { path: 'a', name: 'a', depth: 0, kind: 'dir', hasChildren: true },
    { path: 'a/c', name: 'c', depth: 1, kind: 'dir', hasChildren: true },
    { path: 'a/b.md', name: 'b.md', depth: 1, kind: 'file', hasChildren: false },
    { path: 'z.md', name: 'z.md', depth: 0, kind: 'file', hasChildren: false },
  ]);

  assert.deepEqual(flattenVisible(tree, new Set(['a', 'a/c'])), [
    { path: 'a', name: 'a', depth: 0, kind: 'dir', hasChildren: true },
    { path: 'a/c', name: 'c', depth: 1, kind: 'dir', hasChildren: true },
    { path: 'a/c/d.md', name: 'd.md', depth: 2, kind: 'file', hasChildren: false },
    { path: 'a/b.md', name: 'b.md', depth: 1, kind: 'file', hasChildren: false },
    { path: 'z.md', name: 'z.md', depth: 0, kind: 'file', hasChildren: false },
  ]);
});

void test('buildTree：orderFor 登记目录按自定义顺序，未登记项默认追加', () => {
  const orderFor = (dir: string): readonly string[] | undefined => {
    if (dir === '') return ['z.md', 'notes', 'a.md'];
    return undefined;
  };
  const tree = buildTree(docsOf('z.md', 'a.md', 'notes/b.md', 'archive/x.md'), { orderFor });
  // 登记项 z.md / notes / a.md 按登记序在前；未登记的 archive 走默认（目录在前）追加末尾。
  assert.deepEqual(
    tree.map((n) => n.name),
    ['z.md', 'notes', 'a.md', 'archive'],
  );
});

void test('buildTree：orderFor 中不存在的名字被忽略，不破坏现存项', () => {
  const orderFor = (dir: string): readonly string[] | undefined =>
    dir === 'notes' ? ['missing.md', 'b.md'] : undefined;
  const tree = buildTree(docsOf('notes/b.md', 'notes/a.md'), { orderFor });
  const notes = tree.find((n) => n.name === 'notes');
  assert.ok(notes?.kind === 'dir');
  // 登记序现存项 b.md 在前；未登记的 a.md 走默认追加。
  assert.deepEqual(notes?.children?.map((c) => c.name), ['b.md', 'a.md']);
});

void test('buildTree：未登记顺序时保持默认（目录在前、码点排序）', () => {
  const tree = buildTree(docsOf('b.md', 'a.md', 'n/c.md'), { orderFor: () => undefined });
  assert.deepEqual(
    tree.map((n) => n.name),
    ['n', 'a.md', 'b.md'],
  );
});

void test('dirChildrenNames：取目录直接子节点名，找不到返回空', () => {
  const tree = buildTree(docsOf('a/b.md', 'a/c/d.md', 'z.md'));
  assert.deepEqual([...dirChildrenNames(tree, '')], ['a', 'z.md']);
  assert.deepEqual([...dirChildrenNames(tree, 'a')], ['c', 'b.md']);
  assert.deepEqual([...dirChildrenNames(tree, 'missing')], []);
});
