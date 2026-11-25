/**
 * 2026-11-23：顶栏变矮并只拦截右侧操作簇与顶部拖拽带，顶栏下方内容可交互。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = process.cwd();
const tokens = readFileSync(join(ROOT, 'src/styles/tokens.css'), 'utf8');
const topbar = readFileSync(join(ROOT, 'src/app/chrome/Topbar.module.css'), 'utf8');
const tsx = readFileSync(join(ROOT, 'src/app/chrome/Topbar.tsx'), 'utf8');

void test('顶栏高度收窄到 44px', () => {
  assert.match(tokens, /--topbar-height: 44px/);
});

void test('顶栏本体 pointer-events:none，中部模式、右侧操作簇与 24px 拖拽带恢复交互', () => {
  assert.match(topbar, /\.topbar \{[\s\S]*pointer-events: none;/);
  assert.match(topbar, /\.center \{[\s\S]*pointer-events: auto;/);
  assert.match(topbar, /\.trailing \{[\s\S]*pointer-events: auto;/);
  assert.match(topbar, /\.dragHandle \{[\s\S]*height: 24px;/);
  assert.match(tsx, /styles\.dragHandle/);
  assert.match(tsx, /data-tauri-drag-region/);
});
