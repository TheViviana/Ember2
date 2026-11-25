import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { useTreeStore } from '../../../src/app/stores/tree-store.ts';

const ROOT = process.cwd();
const list = readFileSync(join(ROOT, 'src/app/panels/DocumentList.tsx'), 'utf8');
const row = readFileSync(join(ROOT, 'src/app/panels/TreeRow.tsx'), 'utf8');

void test('文档与画布右键菜单对文章和文件夹都提供改名', () => {
  assert.match(list, /onClick=\{requestTreeRename\}/);
  assert.match(list, /function requestTreeRename/);
  // 改名入口与删除一样，不区分 kind，仅排除空白区。
  assert.match(
    list,
    /\{treeMenu\.target\.kind === 'blank' \? null : \(\s*<>\s*<li>[\s\S]*?onClick=\{requestTreeRename\}/,
  );
  assert.match(list, /treeState\.setEditingPath\(target\.path\);/);
});

void test('行内改名输入对文件夹同样渲染，且文件夹不改写后缀', () => {
  assert.doesNotMatch(row, /if \(editingPath === path && !isDir\)/);
  assert.match(row, /if \(editingPath === path\) \{/);
  assert.match(row, /aria-label=\{isDir \? '命名文件夹' : '命名文章'\}/);
  assert.match(row, /const nextName = isDir \? trimmed : `\$\{trimmed\}\.md`;/);
  assert.match(row, /trimmed\.startsWith\('\.'\)/);
});

void test('改名成功后主动对账索引，覆盖文章与目录后代', () => {
  assert.match(row, /renamedDocPaths\(emberState\.index\.docs\.keys\(\), path, to\)/);
  assert.match(row, /await emberState\.reconcilePaths\(\[\.\.\.stale, \.\.\.fresh\]\)/);
});

void test('改名成功后本地状态按前缀迁移', () => {
  useTreeStore.setState({
    expanded: new Set(['notes', 'notes/child', 'other']),
    activePath: 'notes/child/a.md',
    pendingDirs: new Set(['notes/empty']),
    editingPath: null,
  });
  useTreeStore.getState().renamePath('notes', 'journal');
  const state = useTreeStore.getState();
  assert.deepEqual([...state.expanded].sort(), ['journal', 'journal/child', 'other']);
  assert.equal(state.activePath, 'journal/child/a.md');
  assert.deepEqual([...state.pendingDirs], ['journal/empty']);
  assert.equal(state.editingPath, null);

  useTreeStore.getState().renamePath('journal/child/a.md', 'journal/child/b.md');
  assert.equal(useTreeStore.getState().activePath, 'journal/child/b.md');
});
