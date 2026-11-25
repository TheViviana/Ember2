/**
 * 设置壳导航模型：分区顺序、DEV 过滤与禁用规则。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_ENTRIES } from '../../../src/app/shell/settings-registry.ts';
import {
  buildSettingsNav,
  findSettingsNavEntry,
  type SettingsNavOptions,
} from '../../../src/app/shell/settings-nav.ts';

const BASE: SettingsNavOptions = {
  vaultId: 'vault-1',
  readonly: false,
  activePath: 'notes/a.md',
  dev: false,
};

function build(overrides: Partial<SettingsNavOptions> = {}) {
  return buildSettingsNav(SETTINGS_ENTRIES, { ...BASE, ...overrides });
}

void test('分区顺序：非 DEV 为 appearance/editor/ai/sync/shortcuts/about/tools', () => {
  assert.deepEqual(
    build().map((section) => section.id),
    ['appearance', 'editor', 'ai', 'sync', 'shortcuts', 'about', 'tools'],
  );
});

void test('DEV 构建追加 dev 分区，且含两个开发入口', () => {
  const sections = build({ dev: true });
  assert.equal(sections.at(-1)?.id, 'dev');
  assert.deepEqual(
    sections.at(-1)?.entries.map((entry) => entry.id),
    ['recovery-demo', 'dev-render-fault'],
  );
});

void test('非 DEV 过滤 recovery-demo 与 dev-render-fault', () => {
  const ids = build().flatMap((section) => section.entries.map((entry) => entry.id));
  assert.equal(ids.includes('recovery-demo'), false);
  assert.equal(ids.includes('dev-render-fault'), false);
});

void test('appearance 与 editor 已拆分为两个分区条目', () => {
  const sections = build();
  assert.deepEqual(sections[0]?.entries.map((entry) => entry.id), ['appearance']);
  assert.deepEqual(sections[1]?.entries.map((entry) => entry.id), ['editor']);
});

void test('无知识库时禁用 import/inbox/replace/health', () => {
  const sections = build({ vaultId: null, activePath: null });
  for (const id of ['import', 'inbox', 'replace', 'health']) {
    assert.equal(findSettingsNavEntry(sections, id)?.disabled, true, id);
  }
});

void test('无活动文档时禁用 history', () => {
  const sections = build({ activePath: null });
  assert.equal(findSettingsNavEntry(sections, 'history')?.disabled, true);
  assert.equal(findSettingsNavEntry(build(), 'history')?.disabled, false);
});

void test('只读库禁用 import/replace，但 inbox/health 仍可用', () => {
  const sections = build({ readonly: true });
  assert.equal(findSettingsNavEntry(sections, 'import')?.disabled, true);
  assert.equal(findSettingsNavEntry(sections, 'replace')?.disabled, true);
  assert.equal(findSettingsNavEntry(sections, 'inbox')?.disabled, false);
  assert.equal(findSettingsNavEntry(sections, 'health')?.disabled, false);
});

void test('无条件入口不带 disabled 键', () => {
  const sections = build();
  for (const id of ['appearance', 'editor', 'ai', 'translate', 'library', 'backup', 'shortcuts', 'updater', 'tools']) {
    assert.equal(findSettingsNavEntry(sections, id)?.disabled, undefined, id);
  }
});

void test('findSettingsNavEntry 找不到返回 null', () => {
  assert.equal(findSettingsNavEntry(build(), 'nope'), null);
});
