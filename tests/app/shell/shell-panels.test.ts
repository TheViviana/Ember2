/**
 * 设置壳落地后：壳层面板只剩 settings / ai / docNewInput 三个开关。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL_SHELL_PANELS,
  selectPanelOpen,
  shellPanelsReducer,
  type ShellPanelId,
} from '../../../src/app/shell/shell-panels.ts';

const PANELS: readonly ShellPanelId[] = ['settings', 'ai', 'docNewInput'];

void test('初始态：三个开关全关', () => {
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
  assert.equal(selectPanelOpen(toggled, 'ai'), false);
  const restored = shellPanelsReducer(toggled, { type: 'toggle', panel: 'settings' });
  assert.equal(selectPanelOpen(restored, 'settings'), false);
});

void test('无变化的 open/close 返回原状态对象', () => {
  const opened = shellPanelsReducer(INITIAL_SHELL_PANELS, { type: 'open', panel: 'ai' });
  assert.equal(shellPanelsReducer(opened, { type: 'open', panel: 'ai' }), opened);
  assert.equal(
    shellPanelsReducer(INITIAL_SHELL_PANELS, { type: 'close', panel: 'ai' }),
    INITIAL_SHELL_PANELS,
  );
});
