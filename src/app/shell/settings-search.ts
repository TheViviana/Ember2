/**
 * 设置首页搜索：按标题 + 说明过滤，保留分组顺序并丢弃空分组。
 * 纯函数，便于在 node 下锁定标题/说明都可命中的行为。
 */
import type { SettingsNavEntry, SettingsNavSection } from './settings-nav.ts';

export function filterSettingsSections(
  sections: readonly SettingsNavSection[],
  query: string,
): readonly SettingsNavSection[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return sections;
  const out: SettingsNavSection[] = [];
  for (const section of sections) {
    const entries = section.entries.filter((entry) =>
      `${entry.title} ${entry.description}`.toLowerCase().includes(needle),
    );
    if (entries.length > 0) out.push({ ...section, entries });
  }
  return out;
}

/** 按最近顺序取仍存在且可用的页面入口；动作型入口不进最近列表。 */
export function findRecentEntries(
  sections: readonly SettingsNavSection[],
  ids: readonly string[],
): readonly SettingsNavEntry[] {
  const byId = new Map<string, SettingsNavEntry>();
  for (const section of sections) {
    for (const entry of section.entries) {
      if (entry.page !== undefined && entry.disabled !== true) byId.set(entry.id, entry);
    }
  }
  const out: SettingsNavEntry[] = [];
  for (const id of ids) {
    const entry = byId.get(id);
    if (entry !== undefined) out.push(entry);
  }
  return out;
}
