/**
 * 2026-11-23：提示词编辑改为可缩放浮窗（用户 #7）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = process.cwd();
const css = readFileSync(
  join(ROOT, 'src/app/canvas/PromptEditorWindow.module.css'),
  'utf8',
);
const source = readFileSync(
  join(ROOT, 'src/app/canvas/PromptEditorWindow.tsx'),
  'utf8',
);

void test('提示词浮窗可自由缩放，关闭按钮在右下角', () => {
  const rule = css.match(/\.window\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(rule, /resize:\s*both/, '浮窗可调整大小');
  assert.match(rule, /min-width:\s*320px/, '保留最小可编辑尺寸');
  assert.match(rule, /max-width:\s*calc\(100%/, '不超出画布');
  const footer = css.match(/\.footer\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(footer, /justify-content:\s*flex-end/, '关闭按钮在右侧');
  assert.match(source, /className=\{styles\.close\}/, '右下角关闭按钮');
  assert.match(source, />\s*关闭\s*</, '按钮文案');
});

void test('关闭会回传当前文本（空文本也可关闭），Esc / ⌘Enter 同关', () => {
  assert.match(source, /onClose\(textareaRef\.current\?\.value \?\? ''\)/, '空内容也提交关闭');
  assert.match(source, /event\.key === 'Escape'/, 'Esc 关闭');
  assert.match(source, /event\.key === 'Enter'/, '⌘/Ctrl+Enter 关闭');
});
