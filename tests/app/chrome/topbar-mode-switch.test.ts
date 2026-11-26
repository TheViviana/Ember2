/**
 * 顶栏模式开关：胶囊轨道 + 单块滑动指示，而不是两个各自带底的方形按钮。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = process.cwd();
const css = readFileSync(join(ROOT, 'src/app/chrome/Topbar.module.css'), 'utf8');
const tokens = readFileSync(join(ROOT, 'src/styles/tokens.css'), 'utf8');
const tsx = readFileSync(join(ROOT, 'src/app/chrome/Topbar.tsx'), 'utf8');

void test('模式开关是扁长胶囊，每段比高度更宽', () => {
  assert.match(tokens, /--mode-switch-width:\s*76px/);
  assert.match(tokens, /--mode-switch-height:\s*26px/);
  const track = css.match(/\.modeSwitch\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(track, /border-radius:\s*var\(--radius-full\)/);
  assert.match(track, /background:\s*var\(--ember-bg-input\)/);
  assert.match(track, /padding:\s*2px/);
  assert.doesNotMatch(track, /gap:/);

  const segment = css.match(/\.modeSwitch \.iconButton\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(segment, /width:\s*var\(--mode-switch-width\)/);
  assert.match(segment, /height:\s*var\(--mode-switch-height\)/);
  assert.match(segment, /border-radius:\s*var\(--radius-full\)/);
});

void test('滑块连续平移一个分段宽度，并尊重减少动态效果', () => {
  const indicator = css.match(/\.modeIndicator\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(indicator, /width:\s*var\(--mode-switch-width\)/);
  assert.match(indicator, /border-radius:\s*var\(--radius-full\)/);
  assert.match(indicator, /box-shadow:\s*var\(--shadow-sm\)/);
  assert.match(css, /\.modeSwitch\[data-active='docs'\] \.modeIndicator\s*\{[^}]*translateX\(var\(--mode-switch-width\)\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.modeIndicator\s*\{\s*transition:\s*none/);
});

void test('分段内显示当前界面名称，并保留可访问的按下状态', () => {
  assert.match(tsx, /role="group"/);
  assert.match(tsx, /aria-label="主区模式"/);
  assert.match(tsx, /aria-pressed=\{active === 'canvas'\}/);
  assert.match(tsx, /aria-pressed=\{active === 'docs'\}/);
  assert.match(tsx, /className=\{styles\.modeLabel\}>画布</);
  assert.match(tsx, /className=\{styles\.modeLabel\}>看板</);
  assert.match(css, /\.modeLabel\s*\{[^}]*font-size:\s*var\(--text-xs\)/);
});
