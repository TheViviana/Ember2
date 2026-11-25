/**
 * 2026-11-23：右键/拉线菜单「创建新文章」——在库根建空文章并挂到画布节点。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = process.cwd();
const view = readFileSync(join(ROOT, 'src/app/canvas/CanvasView.tsx'), 'utf8');
const menus = readFileSync(join(ROOT, 'src/app/canvas/CanvasMenus.tsx'), 'utf8');
const article = readFileSync(join(ROOT, 'src/app/canvas/use-create-empty-article.ts'), 'utf8');
const menuPosition = readFileSync(join(ROOT, 'src/app/canvas/menu-position.ts'), 'utf8');

void test('空白右键菜单有「创建新文章」动作', () => {
  assert.match(menus, /onAction\('createArticle'\)/);
  assert.match(menus, /创建新文章/);
});

void test('拉线落空菜单有「创建新文章」并自动连边', () => {
  assert.match(menus, /onChooseArticle/);
  assert.match(menus, /创建新文章/);
  assert.match(view, /chooseConnectionArticle/);
  assert.match(article, /createConnectNewNodeCommands\(/);
});

void test('空文章写到库根「未命名文章.md」，重名自动编号', () => {
  assert.match(article, /未命名文章\.md/);
  assert.match(article, /未命名文章-\$\{attempt \+ 1\}\.md/);
  assert.match(article, /store\.createDoc\(candidate\)/);
  assert.match(article, /result\.reason !== 'EXISTS'/);
});

void test('创建后挂载 document 节点；右键只加节点，拉线再加边', () => {
  assert.match(article, /type: 'document'/);
  assert.match(article, /docPath: rel/);
  assert.match(article, /from === null[\s\S]*createAddDocumentNodeCommand|createAddDocumentNodeCommand[\s\S]*from === null/);
});

void test('菜单靠近边缘时向内收，避免菜单跑出可视区', () => {
  assert.match(menuPosition, /export function clampMenuPoint/);
  assert.match(menuPosition, /width - menuWidth/);
  assert.match(menuPosition, /height - menuHeight/);
});

void test('画布菜单高于浮窗/侧栏层，拖线松手在浮窗下也能看到', () => {
  const css = readFileSync(join(ROOT, 'src/app/canvas/CanvasView.module.css'), 'utf8');
  assert.match(css, /z-index: calc\(var\(--layer-sidebar-overlay\) \+ 1\)/);
});

void test('拉线菜单外部关闭听 pointerdown 而非 click，避免同轮合成 click 闪关菜单', () => {
  // 菜单在 pointerup 里挂载；host 的 pointer capture 会把按下/抬起目标归一到画布，
  // 短距拖线松手时浏览器仍派发同轮 click 到 document——听 click 的话菜单刚弹出就被关。
  const start = view.indexOf('if (connectionMenu === null) return;');
  assert.notEqual(start, -1, '未找到拉线菜单的 document 关闭 effect');
  const end = view.indexOf('}, [connectionMenu, closeConnectionMenu]);', start);
  assert.notEqual(end, -1, 'effect 依赖数组不完整');
  const effect = view.slice(start, end);
  assert.match(effect, /addEventListener\('pointerdown', onDocPointerDown\)/);
  assert.doesNotMatch(effect, /addEventListener\('click'/);
  assert.match(effect, /closest\('ul\[role="menu"\]'\)/, '菜单内点击（含文档子菜单 portal）不得关闭');
});
