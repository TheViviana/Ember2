/**
 * 2026-11-23：正文字号增加「较小」档（0.9 倍）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = process.cwd();
const source = readFileSync(join(ROOT, 'src/core/article-font.ts'), 'utf8');
const panel = readFileSync(join(ROOT, 'src/features/settings/EditorSettingsBody.tsx'), 'utf8');

void test('ArticleFontSize 含 small，缩放 0.9，读取可识别', () => {
  assert.match(source, /'small' \| 'default'/);
  assert.match(source, /small: '0\.9'/);
  assert.match(source, /stored === 'small'/);
});

void test('外观设置显示「较小」选项', () => {
  assert.match(panel, /value: 'small', label: '较小'/);
});

void test('字号只改文字大小，文章宽度随浮窗自适应', () => {
  for (const file of [
    'src/editor/MarkdownPreview.module.css',
    'src/editor/EditorView.module.css',
  ]) {
    const css = readFileSync(join(ROOT, file), 'utf8');
    assert.doesNotMatch(css, /ember-read-column/);
    assert.match(css, /padding: var\(--space-xl\)/);
  }
  assert.doesNotMatch(
    readFileSync(join(ROOT, 'src/styles/tokens.css'), 'utf8'),
    /--ember-read-column/,
  );
});

void test('编辑态标题只用字号与字重分层，不带下划线', () => {
  const editor = readFileSync(join(ROOT, 'src/editor/EditorView.module.css'), 'utf8');
  const heading = editor.match(/\.tok-heading\)\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(heading, /text-decoration:\s*none/);
});

void test('编辑正文使用清晰字号与文章行高，阅读段落避免窄栏强制两端对齐', () => {
  const editor = readFileSync(join(ROOT, 'src/editor/EditorView.module.css'), 'utf8');
  const root = editor.match(/\.editor\s+:global\(\.cm-editor\)\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(root, /font-size: calc\(var\(--text-lg\) \* var\(--article-font-scale\)\)/);
  assert.match(root, /color: var\(--ember-article-body\)/);
  assert.match(editor, /line-height: var\(--leading-article-zh\)/);

  const preview = readFileSync(join(ROOT, 'src/editor/MarkdownPreview.module.css'), 'utf8');
  const paragraph = preview.match(/\.paragraph\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(paragraph, /text-align: left/);
  assert.match(paragraph, /text-wrap: pretty/);
  assert.match(paragraph, /overflow-wrap: break-word/);
});
