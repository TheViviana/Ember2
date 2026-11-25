import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatchCommandKeybinding, type KeybindingDispatchEvent } from '../../../src/features/commands/keybinding-dispatcher.ts';

function event(overrides: Partial<KeybindingDispatchEvent> = {}) {
  let prevented = 0;
  let stopped = 0;
  const value: KeybindingDispatchEvent = {
    key: 'k', code: 'KeyK', metaKey: true,
    preventDefault() { prevented += 1; },
    stopPropagation() { stopped += 1; },
    ...overrides,
  };
  return { value, prevented: () => prevented, stopped: () => stopped };
}

void test('命中启用命令只执行一次并消费事件', () => {
  const e = event();
  const executed: string[] = [];
  const handled = dispatchCommandKeybinding(e.value, [
    { id: 'view.command_palette', enabled: true },
    { id: 'other', enabled: true },
  ], {
    'view.command_palette': [{ key: 'K', meta: true }],
    other: [{ key: 'K', meta: true }],
  }, (id) => executed.push(id));
  assert.equal(handled, true);
  assert.deepEqual(executed, ['view.command_palette']);
  assert.equal(e.prevented(), 1);
  assert.equal(e.stopped(), 1);
});

void test('编辑目标仅允许命令面板等全局命令', () => {
  const target = { tagName: 'TEXTAREA' };
  const executed: string[] = [];
  const bindings = {
    'canvas.select_all': [{ key: 'A', meta: true }],
    'view.command_palette': [{ key: 'K', meta: true }],
  };
  const select = event({ key: 'a', code: 'KeyA', target });
  assert.equal(dispatchCommandKeybinding(select.value, [
    { id: 'canvas.select_all', enabled: true },
  ], bindings, (id) => executed.push(id)), false);
  const palette = event({ target });
  assert.equal(dispatchCommandKeybinding(palette.value, [
    { id: 'view.command_palette', enabled: true },
  ], bindings, (id) => executed.push(id)), true);
  assert.deepEqual(executed, ['view.command_palette']);
});

void test('disabled、IME、未绑定与未命中均放行', () => {
  const executed: string[] = [];
  const commands = [{ id: 'view.command_palette', enabled: false }];
  const bindings = { 'view.command_palette': [{ key: 'K', meta: true }] };
  assert.equal(dispatchCommandKeybinding(event().value, commands, bindings, (id) => executed.push(id)), false);
  assert.equal(dispatchCommandKeybinding(event({ isComposing: true }).value, [{ id: 'view.command_palette' }], bindings, (id) => executed.push(id)), false);
  assert.equal(dispatchCommandKeybinding(event().value, [{ id: 'view.command_palette' }], {}, (id) => executed.push(id)), false);
  assert.equal(dispatchCommandKeybinding(event({ key: 'j', code: 'KeyJ' }).value, [{ id: 'view.command_palette' }], bindings, (id) => executed.push(id)), false);
  assert.deepEqual(executed, []);
});
