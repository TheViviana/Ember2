/**
 * 2026-11-24：拉线菜单关闭与重新拉线共存——回归防御。
 *
 * 根因：closeConnectionMenu 曾调用 engine.cancelConnection()。菜单开着时用户
 * 从端口拉起新手势，pointerdown 先于菜单关闭到达 document 监听，新手势在起点
 * 被取消——线条卡死不动、松手无响应。引擎因 CSS Modules 无法在 node 下导入，
 * 按仓库惯例做源码断言（同 article-create.test.ts）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = process.cwd();
const view = readFileSync(join(ROOT, 'src/app/canvas/CanvasView.tsx'), 'utf8');
const engine = readFileSync(join(ROOT, 'src/app/canvas/engine.ts'), 'utf8');
const interaction = readFileSync(join(ROOT, 'src/app/canvas/interaction.ts'), 'utf8');

function closeConnectionMenuBody(): string {
  const start = view.indexOf('const closeConnectionMenu');
  assert.notEqual(start, -1, '未找到 closeConnectionMenu');
  const end = view.indexOf('}, []);', start);
  assert.notEqual(end, -1, 'closeConnectionMenu 依赖数组不完整');
  return view.slice(start, end);
}

void test('关闭拉线菜单只收菜单，不得取消进行中的连线手势', () => {
  const body = closeConnectionMenuBody();
  assert.match(body, /setConnectionMenu\(null\)/);
  assert.doesNotMatch(body, /cancelConnection/, '关闭菜单不得调用 cancelConnection');
});

void test('engine 不再暴露 cancelConnection（唯一调用方已移除）', () => {
  assert.doesNotMatch(engine, /cancelConnection/);
});

void test('有效目标直连与空白弹菜单两个出口均保留', () => {
  assert.match(interaction, /type: 'connectionCommit'/);
  assert.match(engine, /case 'connectionCommit'/);
  assert.match(interaction, /type: 'connectionDropEmpty'/);
});

void test('连线手势收尾（直连/落空/取消）都复位拖拽端口高亮', () => {
  assert.match(engine, /private resetDragPortHighlight\(\): void/);
  const commitStart = engine.indexOf("case 'connectionCommit'");
  const commitEnd = engine.indexOf("case 'connectionDropEmpty'", commitStart);
  assert.notEqual(commitStart, -1);
  assert.notEqual(commitEnd, -1);
  const commitCase = engine.slice(commitStart, commitEnd);
  assert.match(
    commitCase,
    /clearDraftLine\(\);\s*\n\s*this\.resetDragPortHighlight\(\);/,
    '直连成功或预检拒绝前都必须复位端口高亮',
  );
  const dropStart = engine.indexOf("case 'connectionDropEmpty'");
  const dropEnd = engine.indexOf("case 'connectionDraft'");
  assert.notEqual(dropStart, -1);
  assert.notEqual(dropEnd, -1);
  const dropCase = engine.slice(dropStart, dropEnd);
  assert.match(
    dropCase,
    /clearDraftLine\(\);[\s\S]*?resetDragPortHighlight\(\);/,
    '落空弹菜单前必须复位端口高亮',
  );
  assert.match(
    engine,
    /case 'connectionCancel':\s*\n\s*this\.clearDraftLine\(\);\s*\n\s*this\.resetDragPortHighlight\(\);/,
    '取消路径同样复位端口高亮',
  );
});

void test('复位实现强制重发，不依赖 key 去重', () => {
  const start = engine.indexOf('private resetDragPortHighlight');
  assert.notEqual(start, -1);
  const end = engine.indexOf('\n  }\n', start);
  const body = engine.slice(start, end);
  assert.match(body, /lastPortHighlightKey =/, '必须回写 key 与 DOM 状态一致');
  assert.match(body, /setPortHighlight\(ids\)/, '无条件重发，空选区即清空');
});

void test('指针离开画布时补清 hover，端口不再常亮', () => {
  const leaveStart = engine.indexOf('private readonly onPointerLeave');
  assert.notEqual(leaveStart, -1);
  const leaveEnd = engine.indexOf('\n  };', leaveStart);
  const body = engine.slice(leaveStart, leaveEnd);
  assert.match(body, /setHoverNode\(null\)/);
});
