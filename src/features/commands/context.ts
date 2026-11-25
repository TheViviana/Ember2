/**
 * CR-20261119-13：命令上下文类型 + 纯工厂。
 *
 * 本文件 **不引 src/app / src/stores**（gate:layers 要求 features 层禁引 app）。
 * 原始快照由 AppShell 从各 zustand store 组装后传入 createCommandContext。
 */

export type CommandCategory = '文件' | '视图' | '画布' | '窗口';

export interface CommandContextSnapshot {
  readonly workspaceMode: 'canvas' | 'docs';
  readonly activeWindowId: string | null;
  readonly activePath: string | null;
  readonly activeCanvasId: string | null;
  readonly canvasHasSelection: boolean;
  /** 画布是否有 in-progress gesture（cancel_gesture 启用条件） */
  readonly canvasHasGesture: boolean;
  /** 当前缩放倍率，1.0 = 100%；zoom_reset 启用条件 */
  readonly canvasZoomLevel: number;
  readonly vaultIdentity: { readonly root: string } | null;
  readonly readOnly: boolean;
  readonly windowCount: number;
  readonly hasMinimizedWindows: boolean;
}

export interface CommandAbilities {
  readonly pushNotice: (message: string, tone: 'info' | 'warning' | 'error') => void;
}

export interface CommandContext {
  /** 调用时刻快照；不可变 */
  readonly snapshot: Readonly<CommandContextSnapshot>;
  /** 执行器注入的能力 */
  readonly abilities: Readonly<CommandAbilities>;
}

/**
 * 纯工厂：接收原始快照 + abilities → 返回 CommandContext。
 * 零副作用、零 store 读取、零 react import。
 */
export function createCommandContext(
  snapshot: Readonly<CommandContextSnapshot>,
  abilities: Readonly<CommandAbilities>,
): CommandContext {
  return { snapshot, abilities };
}
