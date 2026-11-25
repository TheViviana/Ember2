import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * R9'（2026-11-18 用户追认）：收起态必须存在可聚焦的 sr-only 展开按钮。
 * 项目无 React/jsdom 基建，故对组件与样式源码做结构化断言（与 edge-layout 源码断言同一手法）。
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p: string): string => readFileSync(`${ROOT}${p}`, 'utf8');

const TSX = read('src/app/shell/EdgePanel.tsx');
const CSS = read('src/app/shell/AppShell.module.css');

void test('收起态渲染 sr-only 展开按钮且 aria 正确', () => {
  assert.match(TSX, /open\s*\?\s*null\s*:\s*\(/, '仅在收起态渲染展开入口');
  assert.match(TSX, /className=\{styles\.edgeSrOnly\}/);
  assert.match(TSX, /aria-expanded=\{false\}/);
  assert.match(TSX, /aria-controls=\{panelId\}/);
  assert.match(TSX, /aria-label=\{`展开\$\{label\}`\}/);
  assert.match(TSX, /onClick=\{onToggle\}/);
});

void test('sr-only 用 clip 隐藏而非 display:none / visibility:hidden', () => {
  assert.match(CSS, /\.edgeSrOnly\s*\{[^}]*clip:\s*rect\(0, 0, 0, 0\)/);
  const start = CSS.indexOf('.edgeSrOnly {');
  assert.notEqual(start, -1, '存在 .edgeSrOnly 规则');
  const rule = CSS.slice(start, CSS.indexOf('}', start) + 1);
  assert.doesNotMatch(rule, /display:\s*none/);
  assert.doesNotMatch(rule, /visibility:\s*hidden/);
});

void test('侧栏层级引用 token，不写裸 z-index', () => {
  assert.match(CSS, /z-index:\s*var\(--layer-sidebar-overlay\)/);
});
