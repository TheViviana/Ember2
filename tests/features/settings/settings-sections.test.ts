import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildSettingsSections,
  initialCollapsedSections,
  toggleCollapsedSection,
  type SettingsSectionsOptions,
} from '../../../src/features/settings/settings-menu-model.ts';
import { SETTINGS_ENTRIES } from '../../../src/app/shell/settings-registry.ts';

const base = {
  vaultId: '/vault',
  readonly: false,
  activePath: '/vault/a.md',
  dev: false,
} as const;

const build = (options: SettingsSectionsOptions) => buildSettingsSections(SETTINGS_ENTRIES, options);

void test('设置菜单是单层分组，顺序固定且无二级栏目标识', () => {
  const sections = build(base);
  assert.deepEqual(sections.map((section) => section.id), ['general', 'ai', 'library', 'data']);
  assert.deepEqual(
    sections.flatMap((section) => section.entries.map((entry) => entry.id)),
    ['appearance', 'shortcuts', 'updater', 'tools', 'ai', 'translate', 'library', 'import', 'inbox', 'replace', 'backup', 'health', 'history'],
  );
});

void test('DEV 构建追加开发分组', () => {
  const sections = build({ ...base, dev: true });
  const dev = sections.find((section) => section.id === 'dev');
  assert.ok(dev !== undefined);
  assert.deepEqual(dev.entries.map((entry) => entry.id), ['recovery-demo', 'dev-render-fault']);
});

void test('默认展开常规与 AI，其余折叠', () => {
  const sections = build(base);
  assert.deepEqual(initialCollapsedSections(sections), ['library', 'data']);
});

void test('折叠切换只影响目标分组', () => {
  const sections = build(base);
  const collapsed = initialCollapsedSections(sections);
  assert.deepEqual(toggleCollapsedSection(collapsed, 'library'), ['data']);
  assert.deepEqual(toggleCollapsedSection(collapsed, 'general'), ['library', 'data', 'general']);
});

void test('库未连接时禁用依赖库的入口', () => {
  const sections = build({ ...base, vaultId: null, activePath: null });
  const entries = new Map(
    sections.flatMap((section) => section.entries.map((entry) => [entry.id, entry])),
  );
  assert.equal(entries.get('import')?.disabled, true);
  assert.equal(entries.get('inbox')?.disabled, true);
  assert.equal(entries.get('replace')?.disabled, true);
  assert.equal(entries.get('health')?.disabled, true);
  assert.equal(entries.get('history')?.disabled, true);
  assert.notEqual(entries.get('library')?.disabled, true);
});

void test('只读库禁用写入入口，但保留库管理与媒体库', () => {
  const sections = build({ ...base, readonly: true });
  const entries = new Map(
    sections.flatMap((section) => section.entries.map((entry) => [entry.id, entry])),
  );
  assert.equal(entries.get('import')?.disabled, true);
  assert.equal(entries.get('replace')?.disabled, true);
  assert.notEqual(entries.get('library')?.disabled, true);
  assert.notEqual(entries.get('backup')?.disabled, true);
});

void test('CR-R6-1：登记表 id 唯一，dev=false 不含 dev 分组', () => {
  assert.equal(new Set(SETTINGS_ENTRIES.map((entry) => entry.id)).size, SETTINGS_ENTRIES.length);
  const sections = build(base);
  assert.equal(sections.some((section) => section.id === 'dev'), false);
  assert.equal(
    sections.flatMap((section) => section.entries).some((entry) => entry.id === 'recovery-demo'),
    false,
  );
});

void test('CR-R6-1：disabled 三规则各一条（vault / writable / doc）', () => {
  const noVault = new Map(
    build({ ...base, vaultId: null }).flatMap((s) => s.entries.map((entry) => [entry.id, entry])),
  );
  assert.equal(noVault.get('inbox')?.disabled, true, 'vault：未连接库禁用收集箱');
  assert.equal(noVault.get('import')?.disabled, true, 'writable：未连接库禁用导入');
  assert.equal(noVault.get('backup')?.disabled, undefined, '无 requires 的入口不输出 disabled');

  const readOnly = new Map(
    build({ ...base, readonly: true }).flatMap((s) => s.entries.map((entry) => [entry.id, entry])),
  );
  assert.equal(readOnly.get('replace')?.disabled, true, 'writable：只读库禁用搜索替换');
  assert.notEqual(readOnly.get('inbox')?.disabled, true, 'vault 规则不因只读禁用');

  const noDoc = new Map(
    build({ ...base, activePath: null }).flatMap((s) => s.entries.map((entry) => [entry.id, entry])),
  );
  assert.equal(noDoc.get('history')?.disabled, true, 'doc：无活动文档禁用历史版本');
});
