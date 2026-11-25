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
