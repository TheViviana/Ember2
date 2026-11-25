/**
 * R4-1：设置菜单 id → 壳层动作的映射（面板类 / 副作用类 / 未知）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSettingsAction } from '../../../src/app/shell/settings-actions.ts';
import { SETTINGS_ENTRIES } from '../../../src/app/shell/settings-registry.ts';

const PANEL_CASES: ReadonlyArray<readonly [string, string]> = [
  ['appearance', 'appearance'],
  ['shortcuts', 'shortcuts'],
  ['updater', 'update'],
  ['tools', 'tools'],
  ['ai', 'ai'],
  ['translate', 'translate'],
  ['library', 'library'],
  ['inbox', 'inbox'],
  ['replace', 'replace'],
  ['backup', 'backup'],
  ['health', 'health'],
  ['history', 'history'],
  ['recovery-demo', 'recoveryDemo'],
];

void test('13 个面板入口映射到对应面板', () => {
  for (const [id, panel] of PANEL_CASES) {
    assert.deepEqual(resolveSettingsAction(id), { kind: 'panel', panel }, id);
  }
});

void test('import / dev-render-fault 归为 special', () => {
  assert.deepEqual(resolveSettingsAction('import'), { kind: 'special', id: 'import' });
  assert.deepEqual(
    resolveSettingsAction('dev-render-fault'),
    { kind: 'special', id: 'dev-render-fault' },
  );
});

void test('未知入口返回 null', () => {
  assert.equal(resolveSettingsAction('unknown'), null);
});

void test('CR-R6-1：登记表每项都能 resolve 出动作', () => {
  assert.equal(SETTINGS_ENTRIES.length, 15);
  for (const entry of SETTINGS_ENTRIES) {
    assert.notEqual(resolveSettingsAction(entry.id), null, entry.id);
  }
});
