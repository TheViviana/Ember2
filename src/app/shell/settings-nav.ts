/**
 * 设置壳导航模型（纯函数，可在 node 下测试）。
 *
 * 设置壳取代原顶栏下拉菜单：左侧分区 + 右侧内容，一次只显示一个入口。
 * 入口清单来自 settings-registry 单一登记表，本文件只负责分区、顺序、DEV 过滤与禁用计算。
 */
export type SettingsSectionId =
  | 'appearance'
  | 'editor'
  | 'ai'
  | 'sync'
  | 'shortcuts'
  | 'about'
  | 'tools'
  | 'dev';

/** 设置壳内容页；动作型入口没有 page。 */
export type SettingsPageId =
  | 'appearance'
  | 'editor'
  | 'ai'
  | 'translate'
  | 'library'
  | 'backup'
  | 'shortcuts'
  | 'update'
  | 'tools'
  | 'spatial'
  | 'inbox'
  | 'replace'
  | 'health'
  | 'history'
  | 'recoveryDemo';

export type SettingsActionId = 'import' | 'dev-render-fault';

/** writable=可写库；vault=已连接库；doc=有活动文档；dev=仅 DEV 构建可见。 */
export type SettingsRequirement = 'writable' | 'vault' | 'doc' | 'dev';

/** 登记表输入项（见 src/app/shell/settings-registry.ts）。 */
export interface SettingsSourceEntry {
  readonly id: string;
  readonly section: SettingsSectionId;
  readonly title: string;
  readonly description: string;
  readonly page?: SettingsPageId;
  readonly action?: SettingsActionId;
  readonly requires?: SettingsRequirement;
}

export interface SettingsNavEntry {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly page?: SettingsPageId;
  readonly action?: SettingsActionId;
  readonly disabled?: boolean;
}

export interface SettingsNavSection {
  readonly id: SettingsSectionId;
  readonly label: string;
  readonly entries: readonly SettingsNavEntry[];
}

export interface SettingsNavOptions {
  readonly vaultId: string | null;
  readonly readonly: boolean;
  readonly activePath: string | null;
  readonly dev: boolean;
}

/** 分区元数据：顺序即左侧导航顺序。 */
const SECTION_META: ReadonlyArray<{
  readonly id: SettingsSectionId;
  readonly label: string;
}> = Object.freeze([
  { id: 'appearance', label: '外观' },
  { id: 'editor', label: '编辑器' },
  { id: 'ai', label: 'AI' },
  { id: 'sync', label: '同步' },
  { id: 'shortcuts', label: '快捷键' },
  { id: 'about', label: '关于' },
  { id: 'tools', label: '工具与维护' },
  { id: 'dev', label: '开发' },
]);

/** 无禁用规则返回 undefined（不输出 disabled 键，保持原条目形状）。 */
function disabledFor(
  requires: SettingsRequirement | undefined,
  options: SettingsNavOptions,
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

/** 只负责分区、顺序、dev 过滤与 disabled 计算；入口清单由登记表传入。 */
export function buildSettingsNav(
  entries: readonly SettingsSourceEntry[],
  options: SettingsNavOptions,
): readonly SettingsNavSection[] {
  const visible = options.dev ? entries : entries.filter((entry) => entry.requires !== 'dev');
  return Object.freeze(
    SECTION_META.map((meta) => ({
      id: meta.id,
      label: meta.label,
      entries: Object.freeze(
        visible
          .filter((entry) => entry.section === meta.id)
          .map((entry) => {
            const disabled = disabledFor(entry.requires, options);
            return Object.freeze({
              id: entry.id,
              title: entry.title,
              description: entry.description,
              ...(entry.page === undefined ? {} : { page: entry.page }),
              ...(entry.action === undefined ? {} : { action: entry.action }),
              ...(disabled === undefined ? {} : { disabled }),
            });
          }),
      ),
    })).filter((section) => section.entries.length > 0),
  );
}

export function findSettingsNavEntry(
  sections: readonly SettingsNavSection[],
  id: string,
): SettingsNavEntry | null {
  for (const section of sections) {
    const found = section.entries.find((entry) => entry.id === id);
    if (found !== undefined) return found;
  }
  return null;
}
