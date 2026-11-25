import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDescendantOf,
  nextChildOrder,
  parentDirOf,
  resolveTreeDrop,
  type RowHit,
  type TreeDropTarget,
} from '../../../src/app/panels/doc-tree-drop.ts';

function row(path: string, kind: 'dir' | 'file', top: number, height = 26): RowHit {
  return { path, name: path.slice(path.lastIndexOf('/') + 1), kind, top, bottom: top + height };
}

function place(target: TreeDropTarget): { dir: string; anchor: string; position: string } | null {
  return target.kind === 'place'
    ? { dir: target.dir, anchor: target.anchor, position: target.position }
    : null;
}

void test('parentDirOf / isDescendantOf 边界', () => {
  assert.equal(parentDirOf('a/b.md'), 'a');
  assert.equal(parentDirOf('b.md'), '');
  assert.equal(isDescendantOf('a/b.md', 'a'), true);
  assert.equal(isDescendantOf('a/b/c.md', 'a'), true);
  assert.equal(isDescendantOf('a.md', 'a'), false);
  assert.equal(isDescendantOf('ab.md', 'a'), false);
  assert.equal(isDescendantOf('a/b', ''), true);
  assert.equal(isDescendantOf('a', ''), false);
});

void test('空列表 → append 到根', () => {
  const r = resolveTreeDrop([], 10, 'x.md');
  assert.equal(r.target.kind, 'append');
  assert.equal(r.nearest, null);
});

void test('首行上沿 → place before 首行', () => {
  const rows = [row('a.md', 'file', 0), row('b.md', 'file', 26)];
  const p = place(resolveTreeDrop(rows, 1, 'c.md').target);
  assert.ok(p);
  assert.deepEqual(p, { dir: '', anchor: 'a.md', position: 'before' });
});

void test('末行下沿 → place after 末行', () => {
  const rows = [row('a.md', 'file', 0), row('b.md', 'file', 26)];
  const p = place(resolveTreeDrop(rows, 50, 'c.md').target);
  assert.ok(p);
  assert.deepEqual(p, { dir: '', anchor: 'b.md', position: 'after' });
});

void test('行中间（文件）→ place before（y < 中线）', () => {
  const rows = [row('a.md', 'file', 0), row('b.md', 'file', 26)];
  // b 行 top=26, midY=39；y=30 < 39 → before b
  const p = place(resolveTreeDrop(rows, 30, 'c.md').target);
  assert.ok(p);
  assert.deepEqual(p, { dir: '', anchor: 'b.md', position: 'before' });
});

void test('文件夹中间带 → into 该文件夹', () => {
  // h=26, band = [top+6.5, bottom-6.5] = [6.5, 19.5]
  const rows = [row('notes', 'dir', 0)];
  const r = resolveTreeDrop(rows, 13, 'a.md');
  assert.equal(r.target.kind, 'into');
  if (r.target.kind === 'into') assert.equal(r.target.folder, 'notes');
});

void test('文件夹上沿（带外）→ place before 该文件夹', () => {
  const rows = [row('notes', 'dir', 0)];
  const p = place(resolveTreeDrop(rows, 2, 'a.md').target);
  assert.ok(p);
  assert.deepEqual(p, { dir: '', anchor: 'notes', position: 'before' });
});

void test('排除被拖拽行自身', () => {
  const rows = [row('a.md', 'file', 0), row('b.md', 'file', 26)];
  const p = place(resolveTreeDrop(rows, 1, 'a.md').target); // 拖 a，命中参照应落到 b
  assert.ok(p);
  assert.equal(p.anchor, 'b.md');
});

void test('拖目录时排除其后代，避免移入自身子树', () => {
  const rows = [row('a', 'dir', 0), row('a/x.md', 'file', 26), row('b.md', 'file', 52)];
  const p = place(resolveTreeDrop(rows, 1, 'a').target); // 候选排除 a 与 a/x.md → 最近为 b
  assert.ok(p);
  assert.equal(p.anchor, 'b.md');
});

void test('place 落点携带正确的父目录（跨层）', () => {
  const rows = [row('n/a.md', 'file', 0), row('n/b.md', 'file', 26)];
  const p = place(resolveTreeDrop(rows, 1, 'n/c.md').target);
  assert.ok(p);
  assert.deepEqual(p, { dir: 'n', anchor: 'a.md', position: 'before' });
});

void test('nextChildOrder: into / append 追加末尾', () => {
  assert.deepEqual(
    [...nextChildOrder(['a', 'b'], 'c', { kind: 'into', folder: 'd' })],
    ['a', 'b', 'c'],
  );
  assert.deepEqual(
    [...nextChildOrder(['a', 'b'], 'c', { kind: 'append', dir: '' })],
    ['a', 'b', 'c'],
  );
});

void test('nextChildOrder: place before / after 锚点', () => {
  assert.deepEqual(
    [...nextChildOrder(['a', 'b', 'd'], 'c', { kind: 'place', dir: '', anchor: 'd', position: 'before' })],
    ['a', 'b', 'c', 'd'],
  );
  assert.deepEqual(
    [...nextChildOrder(['a', 'b'], 'c', { kind: 'place', dir: '', anchor: 'a', position: 'after' })],
    ['a', 'c', 'b'],
  );
});

void test('nextChildOrder: 同目录调序——先移除再插入', () => {
  assert.deepEqual(
    [...nextChildOrder(['a', 'b'], 'b', { kind: 'place', dir: '', anchor: 'a', position: 'before' })],
    ['b', 'a'],
  );
});

void test('nextChildOrder: 锚点不在列表时追加末尾', () => {
  assert.deepEqual(
    [...nextChildOrder(['a'], 'b', { kind: 'place', dir: '', anchor: 'z', position: 'before' })],
    ['a', 'b'],
  );
});

void test('nextChildOrder: none 返回原序', () => {
  assert.deepEqual([...nextChildOrder(['a'], 'b', { kind: 'none' })], ['a']);
});
