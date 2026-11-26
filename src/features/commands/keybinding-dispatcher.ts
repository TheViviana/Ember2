import type { CommandBindingMap, KeyboardEventLike } from './bindings.ts';
import { isEditableKeyboardTarget, matchesKeyBinding } from './bindings.ts';
import type { KnownCommandId } from './ids.ts';

// 白名单条目受 KnownCommandId 约束；查询侧仍接受任意已注册 id（未知 id 不得命中）。
const GLOBAL_COMMAND_IDS: ReadonlySet<string> = new Set<KnownCommandId>(['view.command_palette']);

export interface DispatchableCommand {
  readonly id: string;
  readonly enabled?: boolean;
}

export interface KeybindingDispatchEvent extends KeyboardEventLike {
  preventDefault(): void;
  stopPropagation(): void;
}

export function dispatchCommandKeybinding(
  event: KeybindingDispatchEvent,
  commands: readonly DispatchableCommand[],
  bindings: CommandBindingMap,
  execute: (commandId: string) => void,
): boolean {
  if (event.isComposing === true) return false;
  const editable = isEditableKeyboardTarget(event.target);
  for (const command of commands) {
    if (command.enabled === false) continue;
    if (editable && !GLOBAL_COMMAND_IDS.has(command.id)) continue;
    const items = (bindings[command.id] ?? []).filter(
      (binding) => !editable || binding.meta === true || binding.ctrl === true,
    );
    if (!items.some((binding) => matchesKeyBinding(event, binding))) continue;
    event.preventDefault();
    event.stopPropagation();
    execute(command.id);
    return true;
  }
  return false;
}
