/**
 * 设置下拉菜单的数据模型（纯函数，可在 node 下测试）。
 *
 * 菜单只有一层：标题分组 → 功能入口；不再有「左分类 / 右列表」的二级结构。
 */
export type SettingsSectionId = 'general' | 'ai' | 'library' | 'data' | 'dev';

/** writable=可写库；vault=已连接库；doc=有活动文档；dev=仅 DEV 构建可见。 */
export type SettingsRequirement = 'writable' | 'vault' | 'doc' | 'dev';

/** 登记表输入项（见 src/app/shell/settings-registry.ts）；panel/special 与本模型无关。 */
export interface SettingsSourceEntry {
  readonly id: string;
  readonly section: SettingsSectionId;
  readonly title: string;
  readonly description: string;
  readonly requires?: SettingsRequirement;
}

export interface SettingsEntry {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly disabled?: boolean;
}

export interface SettingsSection {
  readonly id: SettingsSectionId;
  readonly label: string;
  readonly entries: readonly SettingsEntry[];
  readonly defaultOpen: boolean;
}

export interface SettingsSectionsOptions {
  readonly vaultId: string | null;
  readonly readonly: boolean;
  readonly activePath: string | null;
  readonly dev: boolean;
}

/** 分组元数据：顺序即菜单顺序，defaultOpen 决定初始折叠。 */
const SECTION_META: ReadonlyArray<{
  readonly id: SettingsSectionId;
  readonly label: string;
  readonly defaultOpen: boolean;
}> = Object.freeze([
  { id: 'general', label: '常规', defaultOpen: true },
  { id: 'ai', label: 'AI 与翻译', defaultOpen: true },
  { id: 'library', label: '库管理', defaultOpen: false },
  { id: 'data', label: '数据与维护', defaultOpen: false },
  { id: 'dev', label: '开发', defaultOpen: false },
]);

/** 无禁用规则返回 undefined（不输出 disabled 键，保持原条目形状）。 */
function disabledFor(
  requires: SettingsRequirement | undefined,
  options: SettingsSectionsOptions,
): boolean | undefined {
  switch (requires) {
    case 'writable':
      return options.vaultId === null || options.readonly;
    case 'vault':
      return options.vaultId === null;
    case 'doc':
      return options.activePath === null;
    default:
      return undefined;
  }
}

/** 只负责分组、顺序、dev 过滤与 disabled 计算；入口清单由登记表传入。 */
export function buildSettingsSections(
  entries: readonly SettingsSourceEntry[],
  options: SettingsSectionsOptions,
): readonly SettingsSection[] {
  const visible = options.dev ? entries : entries.filter((entry) => entry.requires !== 'dev');
  const sections = SECTION_META.map((meta) => ({
    ...meta,
    entries: visible
      .filter((entry) => entry.section === meta.id)
      .map((entry) => {
        const disabled = disabledFor(entry.requires, options);
        return Object.freeze({
          id: entry.id,
          title: entry.title,
          description: entry.description,
          ...(disabled === undefined ? {} : { disabled }),
        });
      }),
  })).filter((section) => section.entries.length > 0);

  return Object.freeze(sections.map((section) => Object.freeze({
    ...section,
    entries: Object.freeze([...section.entries]),
  })));
}

/** 初始折叠集合 = defaultOpen 为 false 的分组。 */
export function initialCollapsedSections(
  sections: readonly SettingsSection[],
): readonly SettingsSectionId[] {
  return Object.freeze(sections.filter((section) => !section.defaultOpen).map((section) => section.id));
}

export function toggleCollapsedSection(
  collapsed: readonly SettingsSectionId[],
  id: SettingsSectionId,
): readonly SettingsSectionId[] {
  return Object.freeze(
    collapsed.includes(id) ? collapsed.filter((item) => item !== id) : [...collapsed, id],
  );
}
