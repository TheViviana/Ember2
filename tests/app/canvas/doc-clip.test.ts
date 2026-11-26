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

void test('快照正文、标题、代码与表格使用可读字号和自然换行', () => {
  const body = canvasCss.match(/\.docText\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(body, /font-size:\s*var\(--text-base\)/);
  assert.match(body, /line-height:\s*var\(--leading-article-zh\)/);
  assert.match(body, /overflow-wrap:\s*break-word/);
  assert.match(body, /word-break:\s*normal/);

  const h1 = canvasCss.match(/\.docText h1\s*\{[^}]*\}/)?.[0] ?? '';
  const h2 = canvasCss.match(/\.docText h2\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(h1, /font-size:\s*var\(--text-xl\)/);
  assert.match(h2, /font-size:\s*var\(--text-lg\)/);

  for (const [selector, size] of [['pre', '--text-sm'], ['table', '--text-sm'], ['th', '--text-xs']] as const) {
    const rule = canvasCss.match(new RegExp(`\\.docText ${selector}\\s*\\{[^}]*\\}`))?.[0] ?? '';
    assert.match(rule, new RegExp(`font-size:\\s*var\\(\\${size}\\)`), `${selector} 字号不得过小`);
  }
});
