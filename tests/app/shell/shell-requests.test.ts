/**
 * CR-20261120-40 C：壳层请求通道——「打开翻译设置」每会话只引导一次，
 * AppShell 消费后清除请求位，guidedOnce 保持以防反复弹面板。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { useShellRequestStore } from '../../../src/app/shell/shell-requests.ts';

void test('初始无请求', () => {
  assert.equal(useShellRequestStore.getState().translateSettingsRequested, false);
  assert.equal(useShellRequestStore.getState().translateSettingsGuidedOnce, false);
});

void test('requestTranslateSettings 置位并记录 guidedOnce', () => {
  useShellRequestStore.getState().requestTranslateSettings();
  assert.equal(useShellRequestStore.getState().translateSettingsRequested, true);
  assert.equal(useShellRequestStore.getState().translateSettingsGuidedOnce, true);
});

void test('已引导后再次 request 不再置位（每会话只弹一次）', () => {
  useShellRequestStore.getState().consumeTranslateSettingsRequest();
  assert.equal(useShellRequestStore.getState().translateSettingsRequested, false);
  useShellRequestStore.getState().requestTranslateSettings();
  assert.equal(useShellRequestStore.getState().translateSettingsRequested, false);
  assert.equal(useShellRequestStore.getState().translateSettingsGuidedOnce, true);
});
