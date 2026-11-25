/**
 * 窗口内容类型常量测试：字面值固定 + 可直接传给 registerWindowContent。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EDITOR_WINDOW_CONTENT,
  MEDIA_LIBRARY_WINDOW_CONTENT,
  type WindowContentType,
} from '../../src/windows/content-types.ts';
import {
  getWindowContent,
  registerWindowContent,
  type WindowContentProps,
} from '../../src/windows/use-window-manager.ts';

const NoopRenderer = (_props: WindowContentProps): null => null;

void test('窗口内容类型常量：字面值保持不变', () => {
  assert.equal(EDITOR_WINDOW_CONTENT, 'editor');
  assert.equal(MEDIA_LIBRARY_WINDOW_CONTENT, 'media-library');
});

void test('窗口内容类型常量：可直接传给 registerWindowContent（类型通过且注册生效）', () => {
  const editorType: WindowContentType = EDITOR_WINDOW_CONTENT;
  const mediaType: WindowContentType = MEDIA_LIBRARY_WINDOW_CONTENT;

  registerWindowContent(EDITOR_WINDOW_CONTENT, NoopRenderer);
  registerWindowContent(MEDIA_LIBRARY_WINDOW_CONTENT, NoopRenderer);

  assert.equal(getWindowContent(editorType), NoopRenderer);
  assert.equal(getWindowContent(mediaType), NoopRenderer);
});
