/**
 * CR-R6-1：设置入口单一登记表（15 项，文案与顺序逐字保持 R4-1 现状）。
 *
 * 菜单分组 / 禁用态由 settings-menu-model 按 section + requires 派生；
 * 壳层动作由 settings-actions 按 panel / special 派生，禁止另写平行映射表。
 */
import type {
  SettingsRequirement,
  SettingsSectionId,
} from '../../features/settings/settings-menu-model.ts';
import type { ShellPanelId } from './shell-panels.ts';

export interface SettingsRegistryEntry {
  readonly id: string;
  readonly section: SettingsSectionId;
  readonly title: string;
  readonly description: string;
  readonly panel?: ShellPanelId;
  readonly special?: 'import' | 'dev-render-fault';
  readonly requires?: SettingsRequirement;
}

export const SETTINGS_ENTRIES = Object.freeze([
  { id: 'appearance', section: 'general', title: '外观', description: '浅色 / 深色 / 跟随系统', panel: 'appearance' },
  {
    id: 'shortcuts',
    section: 'general',
    title: '快捷键',
    description: '查看并修改全局命令的按键绑定',
    panel: 'shortcuts',
  },
  {
    id: 'updater',
    section: 'general',
    title: '检查更新',
    description: '检查并安装 Ember 新版本',
    panel: 'update',
  },
  { id: 'tools', section: 'general', title: '效率工具', description: '番茄钟、白噪音与今日回顾', panel: 'tools' },
  {
    id: 'ai',
    section: 'ai',
    title: 'AI 设置',
    description: '配置 AI 对话使用的 Provider、API Key 与模型',
    panel: 'ai',
  },
  {
    id: 'translate',
    section: 'ai',
    title: '翻译设置',
    description: '选择 AI 翻译或联网翻译，并设置默认目标语言',
    panel: 'translate',
  },
  {
    id: 'library',
    section: 'library',
    title: '知识库与媒体库',
    description: '切换或添加知识库，浏览与清理媒体文件',
    panel: 'library',
  },
  {
    id: 'import',
    section: 'library',
    title: '导入文档',
    description: '把 Markdown 文件导入当前知识库',
    special: 'import',
    requires: 'writable',
  },
  {
    id: 'inbox',
    section: 'library',
    title: '收集箱',
    description: '查看暂存的待整理文件与链接',
    panel: 'inbox',
    requires: 'vault',
  },
  {
    id: 'replace',
    section: 'library',
    title: '搜索替换',
    description: '在整个知识库中查找并替换文本',
    panel: 'replace',
    requires: 'writable',
  },
  { id: 'backup', section: 'data', title: '备份与恢复', description: '导出知识库备份或检查已有备份', panel: 'backup' },
  {
    id: 'health',
    section: 'data',
    title: '健康检查',
    description: '查看回收站占用并执行清理',
    panel: 'health',
    requires: 'vault',
  },
  {
    id: 'history',
    section: 'data',
    title: '历史版本',
    description: '查看与恢复当前文档的历史版本',
    panel: 'history',
    requires: 'doc',
  },
  {
    id: 'recovery-demo',
    section: 'dev',
    title: '恢复检测演示（DEV）',
    description: '仅在开发构建中可用的恢复流程演示',
    panel: 'recoveryDemo',
    requires: 'dev',
  },
  {
    id: 'dev-render-fault',
    section: 'dev',
    title: '触发窗口渲染异常（DEV）',
    description: '下一个打开或重新打开的窗口显示错误边界，其他窗口不受影响',
    special: 'dev-render-fault',
    requires: 'dev',
  },
] as const) satisfies readonly SettingsRegistryEntry[];
