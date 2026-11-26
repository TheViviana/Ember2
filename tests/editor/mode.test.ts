import test from 'node:test';
import assert from 'node:assert/strict';
import {
  editorIsReadOnly,
  editorModeReducer,
  INITIAL_EDITOR_MODE,
  type EditorModeState,
} from '../../src/editor/mode.ts';

void test('文章浮窗默认进入可编辑模式', () => {
  assert.deepEqual(INITIAL_EDITOR_MODE, { mode: 'edit', focus: false });
  assert.equal(editorIsReadOnly(INITIAL_EDITOR_MODE, false), false);
});

void test('源码/阅读切换保留专注，专注可独立开关', () => {
  const reading = editorModeReducer(INITIAL_EDITOR_MODE, { type: 'content', mode: 'read' });
  const focused = editorModeReducer(reading, { type: 'toggle-focus' });
  assert.deepEqual(focused, { mode: 'read', focus: true });
  assert.equal(editorModeReducer(focused, { type: 'content', mode: 'edit' }).focus, true);
  assert.deepEqual(
    editorModeReducer(focused, { type: 'exit-focus' }),
    { mode: 'read', focus: false },
  );
});

void test('外部普通打开/阅读打开都明确内容模式并退出专注', () => {
  const state: EditorModeState = { mode: 'read', focus: true };
  assert.deepEqual(
    editorModeReducer(state, { type: 'request', mode: 'edit' }),
    { mode: 'edit', focus: false },
  );
  assert.deepEqual(
    editorModeReducer({ mode: 'edit', focus: true }, { type: 'request', mode: 'read' }),
    { mode: 'read', focus: false },
  );
});

void test('四种源码/阅读 × 专注组合及关窗锁定的只读边界', () => {
  for (const focus of [false, true]) {
    assert.equal(editorIsReadOnly({ mode: 'edit', focus }, false), false);
    assert.equal(editorIsReadOnly({ mode: 'read', focus }, false), true);
    assert.equal(editorIsReadOnly({ mode: 'edit', focus }, true), true);
    assert.equal(editorIsReadOnly({ mode: 'read', focus }, true), true);
  }
});
