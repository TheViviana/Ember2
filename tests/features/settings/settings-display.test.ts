/**
 * P0 设置显示优化：统一分组标签、设置项卡片、两行描述与侧栏容器断点。
 * 这里锁定结构契约，避免后续页面又各写一套间距与标签样式。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const shellCss = read('src/app/shell/SettingsShell.module.css');
const sharedCss = read('src/features/settings/settings-shared.module.css');
const appearance = read('src/features/settings/AppearancePanel.tsx');
const editor = read('src/features/settings/EditorSettingsBody.tsx');
const shortcutCss = read('src/features/settings/shortcut-settings.module.css');

void test('分组标签统一为短竖线 + 弱化色，首页与详情页共用同一识别符号', () => {
  const shellLabel = shellCss.match(/\.groupLabel\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(shellLabel, /color:\s*var\(--settings-text-muted\)/);
  assert.match(shellLabel, /font-size:\s*var\(--text-2xs\)/);
  assert.match(shellCss, /\.groupLabel::before\s*\{[^}]*background:\s*var\(--settings-active-text\)/);
  const sharedLabel = sharedCss.match(/\.groupLabel\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(sharedLabel, /font-size:\s*var\(--text-2xs\)/);
  assert.match(sharedCss, /\.groupLabel::before\s*\{[^}]*background:\s*var\(--settings-active-text\)/);
});

void test('外观与编辑器详情页使用统一的设置项卡片', () => {
  assert.match(sharedCss, /\.card\s*\{[^}]*border:\s*1px solid var\(--settings-border\)/);
  assert.match(sharedCss, /\.card\s*\{[^}]*border-radius:\s*var\(--radius-md\)/);
  for (const source of [appearance, editor]) {
    assert.match(source, /import shared from '\.\/settings-shared\.module\.css'/);
    assert.match(source, /className=\{shared\.card\}/);
    assert.match(source, /className=\{shared\.groupLabel\}/);
  }
  assert.doesNotMatch(appearance, /styles\.groupLabel/);
  assert.doesNotMatch(editor, /styles\.groupLabel/);
});

void test('首页描述最多两行，不再单行截断', () => {
  const description = shellCss.match(/\.rowDescription\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(description, /-webkit-line-clamp:\s*2/);
  assert.match(description, /-webkit-box-orient:\s*vertical/);
  assert.doesNotMatch(description, /white-space:\s*nowrap/);
});

void test('首页提供搜索、最近使用与当前值徽标', () => {
  const shell = read('src/app/shell/SettingsShell.tsx');
  assert.match(shell, /搜索设置项/);
  assert.match(shell, /最近使用/);
  assert.match(shell, /filterSettingsSections/);
  assert.match(shell, /recordRecentSetting/);
  assert.match(shell, /className=\{styles\.rowBadge\}/);
  assert.match(read('src/app/shell/SettingsShellHost.tsx'), /badges=\{badges\}/);
});

void test('主题使用缩略卡，字号提供 Aa 预览', () => {
  const appearanceTsx = read('src/features/settings/AppearancePanel.tsx');
  const appearanceCss = read('src/features/settings/appearance-panel.module.css');
  assert.match(appearanceTsx, /data-theme-preview=\{option\.value\}/);
  assert.match(appearanceCss, /\.themeGrid\s*\{/);
  assert.match(appearanceCss, /\[data-theme-preview='dark'\]/);

  const editorTsx = read('src/features/settings/EditorSettingsBody.tsx');
  const editorCss = read('src/features/settings/editor-settings.module.css');
  assert.match(editorTsx, /data-size=\{articleFont\}/);
  assert.match(editorCss, /\.preview\[data-size='xlarge'\]/);
});

void test('即时保存反馈与危险区使用共享骨架', () => {
  assert.match(sharedCss, /\.saved\s*\{[^}]*min-height:\s*1em/);
  assert.match(sharedCss, /\.dangerZone\s*\{[^}]*border:\s*1px solid var\(--ember-danger-border\)/);
  assert.match(appearance, /useSavedFlash/);
  assert.match(editor, /useSavedFlash/);
  const health = read('src/features/health/HealthPanel.tsx');
  assert.match(health, /shared\.dangerZone/);
  assert.match(health, /shared\.dangerTitle/);
});

void test('快捷键页有录制徽标与搜索空态', () => {
  const shortcutTsx = read('src/features/settings/ShortcutSettings.tsx');
  assert.match(shortcutTsx, /styles\.recording/);
  assert.match(shortcutTsx, /没有匹配的快捷键/);
  assert.match(shortcutCss, /\.recording\s*\{/);
  assert.match(shortcutCss, /\.empty\s*\{/);
});

void test('侧栏按自身宽度重排，快捷键表格使用容器断点', () => {
  const content = shellCss.match(/\.contentBody\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(content, /container-type:\s*inline-size/);
  assert.match(content, /container-name:\s*settings-body/);
  assert.match(shortcutCss, /@container settings-body \(max-width: 380px\)/);
  assert.doesNotMatch(shortcutCss, /@media \(max-width: 680px\)/);
});
