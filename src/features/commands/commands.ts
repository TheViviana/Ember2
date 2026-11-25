/**
 * CR-20261119-13：首版 15 条命令定义。
 *
 * 本文件只输出**静态定义**（id/title/category/keywords/isEnabled/defaultKeybinding）。
 * execute 闭包由 AppShell（app 层）在组装完整 Command 时注入——
 * 因为 execute 需要 handleModeChange、canvasRef、window API 等 app 侧能力。
 *
 * 本文件 **不引 src/app**（gate:layers 要求 features 层禁引 app）。
 */

import type { CommandEnableResult } from './bus.js';
import type { CommandContextSnapshot } from './index.js';
import type { KnownCommandId } from './ids.js';

export interface CommandDefinition {
  readonly id: KnownCommandId;
  readonly title: string;
  readonly category: string; // CommandCategory 定义在 context.ts
  readonly keywords: readonly string[];
  readonly isEnabled: (ctx: CommandContextSnapshot) => CommandEnableResult;
  readonly defaultKeybinding?: ReadonlyArray<{
    readonly key: string;
    readonly meta?: boolean;
    readonly ctrl?: boolean;
    readonly shift?: boolean;
    readonly alt?: boolean;
  }>;
}

// 静态命令定义（execute 由 AppShell 注入）

export const COMMAND_DEFINITIONS = Object.freeze([
  {
    id: 'view.command_palette',
    title: '打开命令面板',
    category: '视图',
    keywords: ['命令', '面板', 'palette', 'command'],
    isEnabled: () => ({ enabled: true }),
    defaultKeybinding: [{ key: 'K', meta: true }],
  },
  {
    id: 'file.new_doc',
    title: '新建文档',
    category: '文件',
    keywords: ['新建', 'create', 'new'],
    isEnabled: (ctx: CommandContextSnapshot): CommandEnableResult => {
      if (!ctx.vaultIdentity) return { enabled: false, reason: '未连接到知识库' };
      if (ctx.readOnly) return { enabled: false, reason: '知识库只读' };
      return { enabled: true };
    },
    defaultKeybinding: [{ key: 'N', meta: true }],
  },
  {
    id: 'view.mode_canvas',
    title: '切换到画布模式',
    category: '视图',
    keywords: ['画布', 'canvas', '模式', 'switch'],
    isEnabled: (ctx: CommandContextSnapshot) => ({ enabled: ctx.workspaceMode !== 'canvas' }),
  },
  {
    id: 'view.mode_docs',
    title: '切换到文档模式',
    category: '视图',
    keywords: ['文档', 'docs', '模式', 'switch'],
    isEnabled: (ctx: CommandContextSnapshot) => ({ enabled: ctx.workspaceMode !== 'docs' }),
  },
  {
    id: 'view.tile_windows',
    title: '平铺所有浮窗',
    category: '视图',
    keywords: ['平铺', 'tile', '窗口'],
    isEnabled: (ctx: CommandContextSnapshot) => ({ enabled: ctx.windowCount > 0 }),
  },
  {
    id: 'view.cascade_windows',
    title: '层叠所有浮窗',
    category: '视图',
    keywords: ['层叠', 'cascade', '窗口'],
    isEnabled: (ctx: CommandContextSnapshot) => ({ enabled: ctx.windowCount > 0 }),
  },
  {
    id: 'canvas.undo',
    title: '画布撤销',
    category: '画布',
    keywords: ['撤销', 'undo'],
    isEnabled: (ctx: CommandContextSnapshot) => ({
      enabled: ctx.workspaceMode === 'canvas' && ctx.activeCanvasId !== null,
    }),
    defaultKeybinding: [{ key: 'Z', meta: true }],
  },
  {
    id: 'canvas.redo',
    title: '画布重做',
    category: '画布',
    keywords: ['重做', 'redo'],
    isEnabled: (ctx: CommandContextSnapshot) => ({
      enabled: ctx.workspaceMode === 'canvas' && ctx.activeCanvasId !== null,
    }),
    defaultKeybinding: [{ key: 'Z', meta: true, shift: true }],
  },
  {
    id: 'canvas.select_all',
    title: '画布全选',
    category: '画布',
    keywords: ['全选', 'select', 'all'],
    isEnabled: (ctx: CommandContextSnapshot) => ({
      enabled: ctx.workspaceMode === 'canvas' && ctx.activeCanvasId !== null,
    }),
    defaultKeybinding: [{ key: 'A', meta: true }],
  },
  {
    id: 'canvas.cancel_gesture',
    title: '取消画布手势',
    category: '画布',
    keywords: ['取消', 'cancel', 'gesture', '手势'],
    isEnabled: (ctx: CommandContextSnapshot) => ({
      enabled:
        ctx.workspaceMode === 'canvas' &&
        ctx.activeCanvasId !== null &&
        ctx.canvasHasGesture,
      reason: ctx.canvasHasGesture ? undefined : '无活动手势',
    }),
  },
  {
    id: 'canvas.delete_selection',
    title: '画布删除选中',
    category: '画布',
    keywords: ['删除', 'delete', 'selection', '选中'],
    isEnabled: (ctx: CommandContextSnapshot) => ({
      enabled:
        ctx.workspaceMode === 'canvas' &&
        ctx.activeCanvasId !== null &&
        ctx.canvasHasSelection,
      reason: ctx.canvasHasSelection ? undefined : '无选中节点',
    }),
    defaultKeybinding: [{ key: 'Backspace' }, { key: 'Delete' }],
  },
  {
    id: 'canvas.add_text',
    title: '新建文本节点',
    category: '画布',
    keywords: ['新建', '文本', 'text', 'node'],
    isEnabled: (ctx: CommandContextSnapshot) => ({
      enabled: ctx.workspaceMode === 'canvas' && ctx.activeCanvasId !== null,
    }),
    // CR-20261121-58：默认快捷键已核对既有定义无冲突（⌘T/⌘⇧A/⌘⇧P 均未被占用）
    defaultKeybinding: [{ key: 'T', meta: true }],
  },
  {
    id: 'canvas.add_ai',
    title: '新建 AI 节点',
    category: '画布',
    keywords: ['新建', 'ai', '节点'],
    isEnabled: (ctx: CommandContextSnapshot) => ({
      enabled: ctx.workspaceMode === 'canvas' && ctx.activeCanvasId !== null,
    }),
    defaultKeybinding: [{ key: 'A', meta: true, shift: true }],
  },
  {
    id: 'canvas.add_prompt',
    title: '新建提示词节点',
    category: '画布',
    keywords: ['新建', '提示词', 'prompt'],
    isEnabled: (ctx: CommandContextSnapshot) => ({
      enabled: ctx.workspaceMode === 'canvas' && ctx.activeCanvasId !== null,
    }),
    defaultKeybinding: [{ key: 'P', meta: true, shift: true }],
  },
  {
    id: 'canvas.zoom_in',
    title: '画布放大',
    category: '画布',
    keywords: ['放大', 'zoom', 'in', '+'],
    isEnabled: (ctx: CommandContextSnapshot) => ({
      enabled: ctx.workspaceMode === 'canvas' && ctx.activeCanvasId !== null,
    }),
  },
  {
    id: 'canvas.zoom_out',
    title: '画布缩小',
    category: '画布',
    keywords: ['缩小', 'zoom', 'out', '-'],
    isEnabled: (ctx: CommandContextSnapshot) => ({
      enabled: ctx.workspaceMode === 'canvas' && ctx.activeCanvasId !== null,
    }),
  },
  {
    id: 'canvas.zoom_reset',
    title: '画布缩放重置',
    category: '画布',
    keywords: ['重置', 'reset', 'zoom'],
    isEnabled: (ctx: CommandContextSnapshot) => ({
      enabled:
        ctx.workspaceMode === 'canvas' &&
        ctx.activeCanvasId !== null &&
        ctx.canvasZoomLevel !== 1.0,
      reason: ctx.canvasZoomLevel === 1.0 ? '当前已是 100%' : undefined,
    }),
    defaultKeybinding: [{ key: '0', meta: true }],
  },
  {
    id: 'window.open_current_doc',
    title: '打开当前文档浮窗',
    category: '窗口',
    keywords: ['打开', 'open', '窗口', '浮窗', 'editor'],
    isEnabled: (ctx: CommandContextSnapshot) => ({ enabled: ctx.activePath !== null }),
    defaultKeybinding: [{ key: 'O', meta: true }],
  },
  {
    id: 'window.close_active',
    title: '关闭活动浮窗',
    category: '窗口',
    keywords: ['关闭', 'close', '窗口'],
    isEnabled: (ctx: CommandContextSnapshot) => ({ enabled: ctx.activeWindowId !== null }),
  },
] as const) satisfies ReadonlyArray<CommandDefinition>;