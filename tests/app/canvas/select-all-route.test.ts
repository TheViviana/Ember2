import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isTextEditingTarget,
  resolveSelectAllRoute,
} from '../../../src/app/canvas/select-all-route.ts';

void test('非文本焦点下 ⌘/Ctrl+A 路由给画布', () => {
  assert.equal(resolveSelectAllRoute({ metaKey: true, ctrlKey: false, key: 'a', target: {} }), 'canvas');
  assert.equal(resolveSelectAllRoute({ metaKey: false, ctrlKey: true, key: 'A', target: {} }), 'canvas');
  assert.equal(resolveSelectAllRoute({ metaKey: true, ctrlKey: false, key: 'a', target: null }), 'canvas');
});

void test('文本输入、可编辑区与 CodeMirror 保留原生 ⌘A', () => {
  assert.equal(isTextEditingTarget({ tagName: 'input' }), true);
  assert.equal(isTextEditingTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTextEditingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(
    isTextEditingTarget({ tagName: 'DIV', closest: (selector: string) => (selector === '.cm-editor' ? {} : null) }),
    true,
  );
  assert.equal(resolveSelectAllRoute({ metaKey: true, ctrlKey: false, key: 'a', target: { tagName: 'INPUT' } }), 'ignore');
  assert.equal(
    resolveSelectAllRoute({ metaKey: true, ctrlKey: false, key: 'a', target: { tagName: 'DIV', isContentEditable: true } }),
    'ignore',
  );
});

void test('非 ⌘A 按键与普通按钮焦点不拦截', () => {
  assert.equal(resolveSelectAllRoute({ metaKey: true, ctrlKey: false, key: 'c', target: {} }), 'ignore');
  assert.equal(resolveSelectAllRoute({ metaKey: false, ctrlKey: false, key: 'a', target: {} }), 'ignore');
  assert.equal(isTextEditingTarget({ tagName: 'BUTTON' }), false);
  assert.equal(isTextEditingTarget(undefined), false);
});
