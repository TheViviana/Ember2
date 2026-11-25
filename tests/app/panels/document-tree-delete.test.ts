import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = process.cwd();
const list = readFileSync(join(ROOT, 'src/app/panels/DocumentList.tsx'), 'utf8');
const actions = readFileSync(join(ROOT, 'src/app/panels/doc-tree-actions.ts'), 'utf8');
const treeRow = readFileSync(join(ROOT, 'src/app/panels/TreeRow.tsx'), 'utf8');

void test('无效画布不可打开，但保留右键删除入口', () => {
  assert.match(list, /aria-disabled=\{entry\.valid \? undefined : true\}/);
  assert.match(list, /if \(!entry\.valid\) return;/);
  // 右键不再按 valid 分流；无效行也进入同一个菜单。
  assert.match(list, /onContextMenu=\{\(event\) => \{/);
  assert.match(list, /valid: entry\.valid/);
});

void test('画布菜单只对有效行显示改名，对有路径的条目开放删除', () => {
  assert.match(list, /\{!canvasMenu\.target\.row\.valid \? null : \(/);
  assert.match(list, /\{canvasMenu\.target\.row\.path === '' \? null : \(/);
});

void test('文档库右键菜单按文件/文件夹给出删除，空白区不显示', () => {
  assert.match(list, /\{treeMenu\.target\.kind === 'blank' \? null : \(/);
  assert.match(list, /treeMenu\.target\.kind === 'dir' \? '删除文件夹' : '删除文章'/);
  assert.match(list, /path: info\.path/, '右键目标必须携带真实路径');
});

void test('删除先经受控确认框，确认后才调用一次 vaultApi.remove', () => {
  // CR-R4-3：落地逻辑移到 DI 动作，确认框守卫仍在组件侧。
  assert.match(list, /async function confirmTreeDelete/);
  assert.match(list, /if \(deleteTarget === null \|\| deleting\) return;/);
  assert.match(list, /await actions\.confirmTreeDelete\(deleteTarget\)/);
  assert.ok(
    list.indexOf('setDeleting(true)') < list.indexOf('actions.confirmTreeDelete'),
    '确认后才发 IPC',
  );
  const start = actions.indexOf('async function confirmTreeDelete');
  const body = actions.slice(start, actions.indexOf('async function commitCanvasRename', start));
  assert.match(body, /await vaultApi\.remove\(target\.path\);/);
  assert.match(body, /removePendingDirs/);
  assert.match(body, /isWithinPath\(treeState\.activePath, target\.path\)/);
  assert.match(body, /isWithinPath\(treeState\.editingPath, target\.path\)/);
  // CR-20261122-66：删除成功后必须主动对账索引，否则被自写日志压掉事件的行会残留。
  assert.match(body, /await syncRemoved\(target\.path\);/);
  assert.match(actions, /removedDocPaths\(docs\(\)\.map\.keys\(\), target\)/);
  assert.match(list, /<DeleteConfirmDialog/);
  assert.match(list, /onCancel=\{\(\) => \{\n\s+if \(!deleting\) setDeleteTarget\(null\);/);
});

void test('空目录行移除原生 disabled，右键才能触发删除', () => {
  assert.doesNotMatch(treeRow, /disabled=\{isDir && !hasChildren\}/);
  assert.match(treeRow, /aria-disabled=\{isDir && !hasChildren \? true : undefined\}/);
});
