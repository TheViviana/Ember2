/**
 * 2026-11-23：文档节点滚动条必须裁在圆角边框内（用户截图 #4）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = process.cwd();
const canvasCss = readFileSync(join(ROOT, 'src/app/canvas/canvas.module.css'), 'utf8');
const engine = readFileSync(join(ROOT, 'src/app/canvas/engine.ts'), 'utf8');

void test('文档内容有独立裁切壳：overflow hidden + 小一阶内表面圆角', () => {
  const rule = canvasCss.match(/\.docClip\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(rule, /overflow:\s*hidden/, '滚动条必须被裁切壳裁掉');
  assert.match(
    rule,
    /border-radius:\s*calc\(var\(--ember-node-radius\) - var\(--space-sm\)\)/,
    '内表面圆角比半透明外壳小一阶',
  );
  assert.match(rule, /background:\s*var\(--ember-doc-content-bg\)/, '正文表面独立适配主题');
  assert.match(engine, /clip:\s*classOf\('docClip'\)/, 'engine 注入哈希类名');
});
