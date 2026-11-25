/**
 * 2026-11-23：看板标题不得钻进顶栏；右侧重复的「回到画布」文本已移除（用户 #2）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = process.cwd();
const tsx = readFileSync(join(ROOT, 'src/features/board/BoardView.tsx'), 'utf8');
const css = readFileSync(join(ROOT, 'src/features/board/BoardView.module.css'), 'utf8');

void test('看板内容从顶栏下方开始，右侧不再渲染回到画布文本', () => {
  const inner = css.match(/\.inner\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(inner, /padding:\s*calc\(var\(--topbar-height\)/, '内容需让出顶栏');
  assert.doesNotMatch(tsx, /回到画布/, '顶栏已有画布图标，移除重复文本');
  assert.doesNotMatch(css, /\.backButton\s*\{/, '移除无用按钮样式');
});
