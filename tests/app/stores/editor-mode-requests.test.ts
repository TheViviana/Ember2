/**
 * CR-20261121-51：编辑器窗口模式请求通道——画布右键「打开阅读浮窗」/节点「展开」
 * 按路径记账模式请求，EditorWindow 消费后移除；immersive 为全局开关，
 * 仅在最后一个编辑器窗口关闭时由 AppShell 复位。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { useEditorModeRequestStore } from '../../../src/app/stores/editor-mode-requests.ts';

void test('初始无请求且未沉浸', () => {
  assert.deepEqual(useEditorModeRequestStore.getState().byPath, {});
  assert.equal(useEditorModeRequestStore.getState().immersive, false);
});

void test('requestMode 按路径记账，consumeMode 消费后移除', () => {
  useEditorModeRequestStore.getState().requestMode('/docs/a.md', 'read');
  useEditorModeRequestStore.getState().requestMode('/docs/b.md', 'edit');
  assert.deepEqual(useEditorModeRequestStore.getState().byPath, {
    '/docs/a.md': 'read',
    '/docs/b.md': 'edit',
  });

  useEditorModeRequestStore.getState().consumeMode('/docs/a.md');
  assert.deepEqual(useEditorModeRequestStore.getState().byPath, {
    '/docs/b.md': 'edit',
  });
  useEditorModeRequestStore.getState().consumeMode('/docs/b.md');
  assert.deepEqual(useEditorModeRequestStore.getState().byPath, {});
});

void test('consumeMode 对未知路径是无操作', () => {
  useEditorModeRequestStore.getState().requestMode('/docs/c.md', 'read');
  useEditorModeRequestStore.getState().consumeMode('/docs/missing.md');
  assert.deepEqual(useEditorModeRequestStore.getState().byPath, {
    '/docs/c.md': 'read',
  });
  useEditorModeRequestStore.getState().consumeMode('/docs/c.md');
  assert.deepEqual(useEditorModeRequestStore.getState().byPath, {});
});

void test('toggleImmersive 翻转；clearImmersive 仅在开启时复位', () => {
  useEditorModeRequestStore.getState().toggleImmersive();
  assert.equal(useEditorModeRequestStore.getState().immersive, true);

  // 已关闭时 clearImmersive 是无操作（幂等，供关窗流程重复调用）
  useEditorModeRequestStore.getState().toggleImmersive();
  useEditorModeRequestStore.getState().clearImmersive();
  assert.equal(useEditorModeRequestStore.getState().immersive, false);

  useEditorModeRequestStore.getState().toggleImmersive();
  useEditorModeRequestStore.getState().clearImmersive();
  assert.equal(useEditorModeRequestStore.getState().immersive, false);
});
