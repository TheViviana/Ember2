/**
 * R4-1：壳层面板 reducer 的开关语义（open/close/toggle/setAiTab + select）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL_SHELL_PANELS,
  selectAiTab,
  selectPanelOpen,
  shellPanelsReducer,
  type ShellPanelId,
} from '../../../src/app/shell/shell-panels.ts';

const PANELS: readonly ShellPanelId[] = [
  'settings', 'library', 'translate', 'ai', 'backup', 'update', 'appearance',
  'shortcuts', 'recoveryDemo', 'inbox', 'replace', 'health', 'history', 'tools',
  'docNewInput',
];

void test('初始态：15 个开关全关，AI tab 为 settings', () => {
  assert.equal(selectAiTab(INITIAL_SHELL_PANELS), 'settings');
  for (const panel of PANELS) {
    assert.equal(selectPanelOpen(INITIAL_SHELL_PANELS, panel), false, panel);
  }
});

void test('open/close 逐项独立生效', () => {
  let state = INITIAL_SHELL_PANELS;
  for (const panel of PANELS) {
    state = shellPanelsReducer(state, { type: 'open', panel });
    assert.equal(selectPanelOpen(state, panel), true, panel);
  }
  for (const panel of PANELS) {
    state = shellPanelsReducer(state, { type: 'close', panel });
    assert.equal(selectPanelOpen(state, panel), false, panel);
  }
});

void test('toggle 只翻转目标面板', () => {
  const toggled = shellPanelsReducer(INITIAL_SHELL_PANELS, { type: 'toggle', panel: 'settings' });
  assert.equal(selectPanelOpen(toggled, 'settings'), true);
  assert.equal(selectPanelOpen(toggled, 'library'), false);
  const restored = shellPanelsReducer(toggled, { type: 'toggle', panel: 'settings' });
  assert.equal(selectPanelOpen(restored, 'settings'), false);
});

void test('setAiTab 只切换 tab，不改 AI 开关', () => {
  const next = shellPanelsReducer(INITIAL_SHELL_PANELS, { type: 'setAiTab', tab: 'chat' });
  assert.equal(selectAiTab(next), 'chat');
  assert.equal(selectPanelOpen(next, 'ai'), false);
});

void test('无变化的 open/close/setAiTab 返回原状态对象', () => {
  const opened = shellPanelsReducer(INITIAL_SHELL_PANELS, { type: 'open', panel: 'library' });
  assert.equal(shellPanelsReducer(opened, { type: 'open', panel: 'library' }), opened);
  assert.equal(
    shellPanelsReducer(INITIAL_SHELL_PANELS, { type: 'close', panel: 'library' }),
    INITIAL_SHELL_PANELS,
  );
  assert.equal(
    shellPanelsReducer(INITIAL_SHELL_PANELS, { type: 'setAiTab', tab: 'settings' }),
    INITIAL_SHELL_PANELS,
  );
});
