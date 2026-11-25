/**
 * CR-R6-2：命令 id 唯一真理源（19 条，与 commands.ts 定义逐字一致）。
 *
 * bus 的 `CommandId` 仍为 string——registry / palette 必须接受历史或未知 id，
 * 以保留 `E_COMMAND_NOT_FOUND` 行为；需要穷尽性检查的入口
 * （命令定义、AppShell 分发表、全局快捷键白名单）一律使用 `KnownCommandId`。
 */
export const COMMAND_IDS = Object.freeze([
  'view.command_palette',
  'file.new_doc',
  'view.mode_canvas',
  'view.mode_docs',
  'view.tile_windows',
  'view.cascade_windows',
  'canvas.undo',
  'canvas.redo',
  'canvas.select_all',
  'canvas.cancel_gesture',
  'canvas.delete_selection',
  'canvas.add_text',
  'canvas.add_ai',
  'canvas.zoom_in',
  'canvas.zoom_out',
  'canvas.zoom_reset',
  'window.open_current_doc',
  'window.close_active',
] as const);

export type KnownCommandId = (typeof COMMAND_IDS)[number];
