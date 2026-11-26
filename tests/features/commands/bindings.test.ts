import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COMMAND_BINDINGS_STORAGE_KEY,
  cloneCommandBindings,
  defaultCommandBindings,
  findBindingConflicts,
  formatBindingList,
  isEditableKeyboardTarget,
  keyBindingFromKeyboardEvent,
  loadCommandBindings,
  matchesKeyBinding,
  saveCommandBindings,
  type BindingStorage,
} from '../../../src/features/commands/bindings.ts';
import type { CommandDefinition } from '../../../src/features/commands/commands.ts';

const definitions = [
  { id: 'view.command_palette', defaultKeybinding: [{ key: 'K', meta: true }] },
  { id: 'canvas.delete_selection', defaultKeybinding: [{ key: 'Backspace' }, { key: 'Delete' }] },
] as Pick<CommandDefinition, 'id' | 'defaultKeybinding'>[];

function memoryStorage(initial: string | null = null): BindingStorage & { value: string | null } {
  return {
    value: initial,
    getItem() { return this.value; },
    setItem(_key, value) { this.value = value; },
  };
}

void test('默认绑定克隆且支持多键位，清空命令不污染默认值', () => {
  const defaults = defaultCommandBindings(definitions);
  const cloned = cloneCommandBindings(defaults);
  assert.deepEqual(cloned, defaults);
  assert.notEqual(cloned['view.command_palette'], defaults['view.command_palette']);
  assert.equal(formatBindingList(defaults['canvas.delete_selection'] ?? []), 'Backspace / Delete');
});

void test('Windows 默认绑定把 Meta 改写为 Ctrl，并显示 Ctrl 文案', () => {
  const defaults = defaultCommandBindings(definitions, false);
  assert.deepEqual(defaults['view.command_palette'], [{ key: 'K', meta: false, ctrl: true }]);
  assert.equal(formatBindingList(defaults['view.command_palette'] ?? [], false), 'Ctrl+K');
  // macOS 仍保留 ⌘
  assert.deepEqual(defaultCommandBindings(definitions, true)['view.command_palette'], [
    { key: 'K', meta: true },
  ]);
});

void test('键盘事件按 code 归一化字符并精确匹配修饰键', () => {
  const event = { key: 'k', code: 'KeyK', metaKey: true };
  assert.deepEqual(keyBindingFromKeyboardEvent(event), { key: 'K', meta: true, ctrl: false, shift: false, alt: false });
  assert.equal(matchesKeyBinding(event, { key: 'K', meta: true }), true);
  assert.equal(matchesKeyBinding({ ...event, shiftKey: true }, { key: 'K', meta: true }), false);
  assert.equal(keyBindingFromKeyboardEvent({ key: 'Meta', metaKey: true }), null);
});

void test('冲突检测覆盖同一组合键的多个命令', () => {
  const conflicts = findBindingConflicts({
    a: [{ key: 'K', meta: true }],
    b: [{ key: 'k', meta: true }],
    c: [{ key: 'K', ctrl: true }],
  });
  assert.deepEqual(conflicts, [{ key: 'meta+K', commandIds: ['a', 'b'] }]);
});

void test('持久化读取合法绑定并为新命令补默认绑定', () => {
  const storage = memoryStorage(JSON.stringify({
    version: 1,
    bindings: { 'view.command_palette': [{ key: 'P', ctrl: true }] },
  }));
  const loaded = loadCommandBindings(storage, definitions);
  assert.equal(loaded.warning, null);
  assert.deepEqual(loaded.bindings['view.command_palette'], [{ key: 'P', ctrl: true, meta: false, shift: false, alt: false }]);
  assert.deepEqual(loaded.bindings['canvas.delete_selection'], definitions[1]?.defaultKeybinding);
});

void test('损坏、冲突和读取失败均安全回退默认', () => {
  assert.match(loadCommandBindings(memoryStorage('{bad'), definitions).warning ?? '', /无法解析/);
  const conflict = memoryStorage(JSON.stringify({ version: 1, bindings: {
    'view.command_palette': [{ key: 'Delete' }],
    'canvas.delete_selection': [{ key: 'Delete' }],
  } }));
  assert.match(loadCommandBindings(conflict, definitions).warning ?? '', /冲突/);
  const failed: BindingStorage = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
  };
  assert.match(loadCommandBindings(failed, definitions).warning ?? '', /读取失败/);
});

void test('保存写入版本化 JSON，冲突与存储异常不落盘', () => {
  const storage = memoryStorage();
  const bindings = defaultCommandBindings(definitions);
  assert.equal(saveCommandBindings(storage, bindings), null);
  assert.equal(storage.value?.includes('"version":1'), true);
  assert.equal(storage.value, JSON.stringify({ version: 1, bindings }));
  assert.notEqual(saveCommandBindings(storage, { a: [{ key: 'A' }], b: [{ key: 'A' }] }), null);
  const failed: BindingStorage = {
    getItem() { return null; },
    setItem() { throw new Error('quota'); },
  };
  assert.match(saveCommandBindings(failed, bindings) ?? '', /未持久化/);
  assert.equal(COMMAND_BINDINGS_STORAGE_KEY, 'ember2:command-bindings:v1');
});

void test('编辑目标识别覆盖输入、contenteditable 与 CodeMirror', () => {
  assert.equal(isEditableKeyboardTarget({ tagName: 'input' }), true);
  assert.equal(isEditableKeyboardTarget({ isContentEditable: true }), true);
  assert.equal(isEditableKeyboardTarget({ closest: (selector: string) => selector.includes('.cm-editor') ? {} : null }), true);
  assert.equal(isEditableKeyboardTarget({ tagName: 'BUTTON', closest: () => null }), false);
});
