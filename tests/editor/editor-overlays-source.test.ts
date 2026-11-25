/**
 * CR-R4-5：覆盖层/预览面板抽离的源码断言（EditorView 只留装配与转发）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

function lineCount(source: string): number {
  return source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
}

const editorView = (): string => read('src/editor/EditorView.tsx');
const overlays = (): string => read('src/editor/EditorOverlays.tsx');
const previewPane = (): string => read('src/editor/EditorPreviewPane.tsx');

void test('EditorView 行数不超过 800，且不再出现 MarkdownPreview / AiSelectionMenu 的 JSX 细节', () => {
  const source = editorView();
  assert.ok(lineCount(source) <= 800, `EditorView.tsx 实际 ${lineCount(source)} 行`);
  assert.doesNotMatch(source, /<MarkdownPreview\b/);
  assert.doesNotMatch(source, /<AiSelectionMenu\b/);
  assert.doesNotMatch(source, /lazy\(/);
});

void test('EditorView 把覆盖层与预览装配转发给抽离组件', () => {
  const source = editorView();
  assert.match(source, /<EditorTopbar\b/);
  assert.match(source, /<EditorConflictBanner\b/);
  assert.match(source, /<EditorPlaceholder\b/);
  assert.match(source, /<EditorPreviewPane\b/);
  assert.match(source, /<EditorCloseOverlaySlot\b/);
  assert.match(source, /<EditorAiOverlay\b/);
});

void test('关窗 overlay 插槽仍在 AI 浮层之前（顺序不变）', () => {
  const source = editorView();
  const slot = source.indexOf('<EditorCloseOverlaySlot');
  const ai = source.indexOf('<EditorAiOverlay');
  assert.ok(slot >= 0 && ai > slot, '插槽顺序应为：关窗 overlay → AI 浮层');
});

void test('预览面板负责 MarkdownPreview 装配与译文块透传', () => {
  const source = previewPane();
  assert.match(source, /<MarkdownPreview\b/);
  assert.match(source, /translation=\{translation\}/);
  assert.match(source, /articleSerif=\{serif\}/);
  assert.match(source, /styles\.readSerif/);
});

void test('覆盖层负责 AI 浮层、冲突横幅、错误横幅与 overlay 插槽', () => {
  const source = overlays();
  assert.match(source, /<AiSelectionMenu\b/);
  assert.match(source, /styles\.overlay/);
  assert.match(source, /磁盘上的文件已被删除/);
  assert.match(source, /打开失败/);
  assert.match(source, /正在载入文档…/);
});

void test('limits.json 中 EditorView target 同步为 800', () => {
  const limits = JSON.parse(read('tests/architecture/limits.json')) as Record<
    string,
    { readonly target: number }
  >;
  assert.equal(limits['src/editor/EditorView.tsx']?.target, 800);
});

void test('翻译失败后顶栏提供「继续翻译」入口', () => {
  const source = overlays();
  assert.match(source, /onResumeTranslation/);
  assert.match(source, /继续翻译/);
});
