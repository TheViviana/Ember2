import type { KeyBinding } from './bus.ts';
import type { CommandDefinition } from './commands.ts';

export const COMMAND_BINDINGS_STORAGE_KEY = 'ember2:command-bindings:v1';

export type CommandBindingMap = Readonly<Record<string, readonly KeyBinding[]>>;

export interface BindingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface BindingConflict {
  readonly key: string;
  readonly commandIds: readonly string[];
}

export interface LoadedBindings {
  readonly bindings: CommandBindingMap;
  readonly warning: string | null;
}

export interface KeyboardEventLike {
  readonly key: string;
  readonly code?: string;
  readonly target?: unknown;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly isComposing?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeKey(key: string): string {
  if (key === ' ') return 'Space';
  if (key === 'Esc') return 'Escape';
  return key.length === 1 ? key.toUpperCase() : key;
}

export function keyFromKeyboardEvent(event: KeyboardEventLike): string | null {
  if (['Meta', 'Control', 'Shift', 'Alt', 'AltGraph'].includes(event.key)) return null;
  const code = event.code ?? '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  const key = normalizeKey(event.key);
  return key.length === 0 ? null : key;
}

export function keyBindingFromKeyboardEvent(event: KeyboardEventLike): KeyBinding | null {
  const key = keyFromKeyboardEvent(event);
  if (key === null) return null;
  return {
    key,
    meta: event.metaKey === true,
    ctrl: event.ctrlKey === true,
    shift: event.shiftKey === true,
    alt: event.altKey === true,
  };
}

export function matchesKeyBinding(event: KeyboardEventLike, binding: KeyBinding): boolean {
  return (
    keyFromKeyboardEvent(event) === normalizeKey(binding.key) &&
    (event.metaKey === true) === (binding.meta === true) &&
    (event.ctrlKey === true) === (binding.ctrl === true) &&
    (event.shiftKey === true) === (binding.shift === true) &&
    (event.altKey === true) === (binding.alt === true)
  );
}

export function bindingKey(binding: KeyBinding): string {
  return [
    binding.meta === true ? 'meta' : '',
    binding.ctrl === true ? 'ctrl' : '',
    binding.alt === true ? 'alt' : '',
    binding.shift === true ? 'shift' : '',
    normalizeKey(binding.key),
  ].filter(Boolean).join('+');
}

export function formatKeyBinding(binding: KeyBinding): string {
  return `${binding.ctrl === true ? '⌃' : ''}${binding.alt === true ? '⌥' : ''}${binding.shift === true ? '⇧' : ''}${binding.meta === true ? '⌘' : ''}${normalizeKey(binding.key)}`;
}

export function formatBindingList(bindings: readonly KeyBinding[]): string {
  return bindings.length === 0 ? '未设置' : bindings.map(formatKeyBinding).join(' / ');
}

export function defaultCommandBindings(
  definitions: readonly Pick<CommandDefinition, 'id' | 'defaultKeybinding'>[],
): CommandBindingMap {
  const result: Record<string, readonly KeyBinding[]> = {};
  for (const definition of definitions) {
    result[definition.id] = (definition.defaultKeybinding ?? []).map((binding) => ({ ...binding }));
  }
  return result;
}

export function cloneCommandBindings(bindings: CommandBindingMap): CommandBindingMap {
  return Object.fromEntries(
    Object.entries(bindings).map(([id, items]) => [id, items.map((item) => ({ ...item }))]),
  );
}

export function findBindingConflicts(bindings: CommandBindingMap): readonly BindingConflict[] {
  const owners = new Map<string, string[]>();
  for (const [commandId, items] of Object.entries(bindings)) {
    for (const binding of items) {
      const key = bindingKey(binding);
      const ids = owners.get(key) ?? [];
      if (!ids.includes(commandId)) ids.push(commandId);
      owners.set(key, ids);
    }
  }
  return [...owners.entries()]
    .filter(([, commandIds]) => commandIds.length > 1)
    .map(([key, commandIds]) => ({ key, commandIds }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function parseBinding(value: unknown): KeyBinding | null {
  if (!isRecord(value) || typeof value['key'] !== 'string' || value['key'].length === 0) return null;
  const flags = ['meta', 'ctrl', 'shift', 'alt'] as const;
  if (flags.some((flag) => value[flag] !== undefined && typeof value[flag] !== 'boolean')) return null;
  return {
    key: normalizeKey(value['key']),
    meta: value['meta'] === true,
    ctrl: value['ctrl'] === true,
    shift: value['shift'] === true,
    alt: value['alt'] === true,
  };
}

export function loadCommandBindings(
  storage: BindingStorage,
  definitions: readonly Pick<CommandDefinition, 'id' | 'defaultKeybinding'>[],
): LoadedBindings {
  const defaults = defaultCommandBindings(definitions);
  let raw: string | null;
  try {
    raw = storage.getItem(COMMAND_BINDINGS_STORAGE_KEY);
  } catch {
    return { bindings: defaults, warning: '快捷键设置读取失败，已使用默认绑定' };
  }
  if (raw === null) return { bindings: defaults, warning: null };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed['version'] !== 1 || !isRecord(parsed['bindings'])) {
      return { bindings: defaults, warning: '快捷键设置格式无效，已使用默认绑定' };
    }
    const stored = parsed['bindings'];
    const next: Record<string, readonly KeyBinding[]> = {};
    for (const definition of definitions) {
      const value = stored[definition.id];
      if (value === undefined) {
        next[definition.id] = defaults[definition.id] ?? [];
        continue;
      }
      if (!Array.isArray(value)) return { bindings: defaults, warning: '快捷键设置格式无效，已使用默认绑定' };
      const items = value.map(parseBinding);
      if (items.some((item) => item === null)) {
        return { bindings: defaults, warning: '快捷键设置包含无效绑定，已使用默认绑定' };
      }
      next[definition.id] = items.filter((item): item is KeyBinding => item !== null);
    }
    if (findBindingConflicts(next).length > 0) {
      return { bindings: defaults, warning: '快捷键设置存在冲突，已使用默认绑定' };
    }
    return { bindings: next, warning: null };
  } catch {
    return { bindings: defaults, warning: '快捷键设置无法解析，已使用默认绑定' };
  }
}

export function saveCommandBindings(storage: BindingStorage, bindings: CommandBindingMap): string | null {
  if (findBindingConflicts(bindings).length > 0) return '存在冲突绑定，未保存';
  try {
    storage.setItem(
      COMMAND_BINDINGS_STORAGE_KEY,
      JSON.stringify({ version: 1, bindings }),
    );
    return null;
  } catch {
    return '快捷键设置保存失败，本次更改未持久化';
  }
}

interface EditableTargetShape {
  readonly tagName?: unknown;
  readonly isContentEditable?: unknown;
  readonly closest?: unknown;
}

export function isEditableKeyboardTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const candidate = target as EditableTargetShape;
  const tag = typeof candidate.tagName === 'string' ? candidate.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (candidate.isContentEditable === true) return true;
  return (
    typeof candidate.closest === 'function' &&
    (candidate.closest as (selector: string) => unknown)(
      '.cm-editor, [contenteditable="true"], [contenteditable=""]',
    ) !== null
  );
}
