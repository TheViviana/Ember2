/**
 * 设置入口单一登记表（16 项）。
 *
 * 分区 / 禁用态由 settings-nav 按 section + requires 派生；
 * 页面与动作由 SettingsShellHost 按 page / action 分发，禁止另写平行映射表。
 */
import type {
  SettingsActionId,
  SettingsPageId,
  SettingsRequirement,
  SettingsSectionId,
} from './settings-nav.ts';

export interface SettingsRegistryEntry {
  readonly id: string;
  readonly section: SettingsSectionId;
  readonly title: string;
  readonly description: string;
  readonly page?: SettingsPageId;
  readonly action?: SettingsActionId;
  readonly requires?: SettingsRequirement;
}

export const SETTINGS_ENTRIES = Object.freeze([
  {
    id: 'appearance',
    section: 'appearance',
    title: '外观',
    description: '主题配色，跟随系统或手动选择',
    page: 'appearance',
  },
  {
    id: 'editor',
    section: 'editor',
    title: '编辑器',
    description: '编辑浮窗行号与文章正文字号',
    page: 'editor',
  },
  {
    id: 'ai',
    section: 'ai',
    title: 'AI 设置',
    description: '配置 AI 对话使用的 Provider、API Key 与模型',
    page: 'ai',
  },
  {
    id: 'translate',
    section: 'ai',
    title: '翻译设置',
    description: '选择 AI 翻译或联网翻译，并设置默认目标语言',
    page: 'translate',
  },
  {
    id: 'library',
    section: 'sync',
    title: '知识库与媒体库',
    description: '切换或添加知识库，浏览与清理媒体文件',
    page: 'library',
  },
  {
    id: 'backup',
    section: 'sync',
    title: '备份与恢复',
    description: '导出知识库备份或检查已有备份',
    page: 'backup',
  },
  {
    id: 'shortcuts',
    section: 'shortcuts',
    title: '快捷键',
    description: '查看并修改全局命令的按键绑定',
    page: 'shortcuts',
  },
  {
    id: 'updater',
    section: 'about',
    title: '检查更新',
    description: '检查并安装 Ember 新版本',
    page: 'update',
  },
  {
    id: 'tools',
    section: 'tools',
    title: '效率工具',
    description: '番茄钟、白噪音与今日回顾',
    page: 'tools',
  },
  {
    id: 'import',
    section: 'tools',
    title: '导入文档',
    description: '把 Markdown 文件导入当前知识库',
    action: 'import',
    requires: 'writable',
  },
  {
    id: 'inbox',
    section: 'tools',
    title: '收集箱',
    description: '查看暂存的待整理文件与链接',
    page: 'inbox',
    requires: 'vault',
  },
  {
    id: 'replace',
    section: 'tools',
    title: '搜索替换',
    description: '在整个知识库中查找并替换文本',
    page: 'replace',
    requires: 'writable',
  },
  {
    id: 'health',
    section: 'tools',
    title: '健康检查',
    description: '查看回收站占用并执行清理',
    page: 'health',
    requires: 'vault',
  },
  {
    id: 'history',
    section: 'tools',
    title: '历史版本',
    description: '查看与恢复当前文档的历史版本',
    page: 'history',
    requires: 'doc',
  },
  {
    id: 'recovery-demo',
    section: 'dev',
    title: '恢复检测演示（DEV）',
    description: '仅在开发构建中可用的恢复流程演示',
    page: 'recoveryDemo',
    requires: 'dev',
  },
  {
    id: 'dev-render-fault',
    section: 'dev',
    title: '触发窗口渲染异常（DEV）',
    description: '下一个打开或重新打开的窗口显示错误边界，其他窗口不受影响',
    action: 'dev-render-fault',
    requires: 'dev',
  },
] as const) satisfies readonly SettingsRegistryEntry[];
