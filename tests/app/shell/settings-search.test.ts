import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterSettingsSections, findRecentEntries } from '../../../src/app/shell/settings-search.ts';
import type { SettingsNavSection } from '../../../src/app/shell/settings-nav.ts';

const SECTIONS: readonly SettingsNavSection[] = [
  {
    id: 'appearance',
    label: '外观',
    entries: [
      { id: 'appearance', title: '外观', description: '主题与动态背景', page: 'appearance' },
      { id: 'editor', title: '编辑器', description: '行号与正文字号', page: 'editor' },
    ],
  },
  {
    id: 'ai',
    label: 'AI',
    entries: [
      { id: 'ai', title: 'AI 助手', description: '模型与密钥', page: 'ai' },
      { id: 'import', title: '导入文档', description: '从文件导入', action: 'import' },
    ],
  },
];

void test('空查询原样返回，标题与说明都可命中', () => {
  assert.equal(filterSettingsSections(SECTIONS, '  '), SECTIONS);
  const byTitle = filterSettingsSections(SECTIONS, '外观');
  assert.deepEqual(byTitle.map((section) => section.entries.map((entry) => entry.id)), [['appearance']]);
  const byDescription = filterSettingsSections(SECTIONS, '密钥');
  assert.deepEqual(
    byDescription.map((section) => section.entries.map((entry) => entry.id)),
    [['ai']],
  );
});

void test('无命中时返回空数组并丢弃空分组', () => {
  assert.deepEqual(filterSettingsSections(SECTIONS, '不存在'), []);
  const filtered = filterSettingsSections(SECTIONS, '字号');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.id, 'appearance');
});

void test('最近入口按记录顺序返回，跳过动作与禁用项', () => {
  const withDisabled: readonly SettingsNavSection[] = [
    {
      id: 'ai',
      label: 'AI',
      entries: [
        ...SECTIONS[1]!.entries,
        { id: 'editor', title: '编辑器', description: '行号', page: 'editor', disabled: true },
      ],
    },
  ];
  assert.deepEqual(
    findRecentEntries(withDisabled, ['ai', 'import', 'editor']).map((entry) => entry.id),
    ['ai'],
  );
  assert.deepEqual(findRecentEntries(SECTIONS, []), []);
});
