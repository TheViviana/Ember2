/**
 * 图标 P0 规格：12/14/16 三档，任意 viewBox 下有效描边恒为 1.25px；
 * 关键交互图标不再使用字符，也不再出现 18px 等断档尺寸。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ICON_STROKE_PX, iconStrokeWidth } from '../../src/ui/icon-metrics.ts';

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

void test('任意尺寸与 viewBox 下有效描边一致', () => {
  const cases: ReadonlyArray<readonly [12 | 14 | 16, string]> = [
    [12, '0 0 24 24'],
    [14, '0 0 24 24'],
    [16, '0 0 24 24'],
    [12, '0 0 12 12'],
    [12, '0 0 8 8'],
    [16, '0 0 16 16'],
  ];
  for (const [size, viewBox] of cases) {
    const base = Number.parseFloat(viewBox.split(/\s+/)[2] ?? '24');
    const effective = (iconStrokeWidth(size, viewBox) * size) / base;
    assert.ok(
      Math.abs(effective - ICON_STROKE_PX) < 1e-9,
      `${size}px / ${viewBox} 有效描边为 ${effective}`,
    );
  }
});

void test('AI 按钮两态尺寸一致，不再出现 18px 断档', () => {
  const source = read('src/app/shell/AiChatButton.tsx');
  assert.equal(source.match(/<Icon size=\{16\}/g)?.length, 2);
  assert.doesNotMatch(source, /width="18"/);
});

void test('窗口控制与树箭头改为统一 SVG 图标', () => {
  const frame = read('src/windows/WindowFrame.tsx');
  assert.doesNotMatch(frame, /<svg/);
  assert.match(frame, /<Icon size=\{12\} viewBox="0 0 12 12">/);
  assert.doesNotMatch(frame, />−</);
  assert.doesNotMatch(frame, />×</);
  assert.match(frame, /aria-label="最小化窗口"/);
  assert.match(frame, /aria-label="关闭窗口"/);

  const tree = read('src/app/panels/TreeRow.tsx');
  assert.doesNotMatch(tree, /<svg/);
  assert.match(tree, /data-expanded=/);
  assert.match(tree, /styles\.markerIcon/);
  assert.doesNotMatch(tree, /[▾▸]/);
});

void test('已迁移文件不再直接写裸 svg', () => {
  const files = [
    'src/app/chrome/Topbar.tsx',
    'src/app/canvas/CanvasMenus.tsx',
    'src/app/canvas/DocSubmenu.tsx',
    'src/app/shell/AiChatButton.tsx',
    'src/app/panels/TreeRow.tsx',
    'src/windows/WindowFrame.tsx',
    'src/features/notice/NoticeIcon.tsx',
    'src/features/ai/AiPanel.tsx',
  ];
  for (const file of files) {
    assert.doesNotMatch(read(file), /<svg/, `${file} 仍有裸 svg`);
  }
});
