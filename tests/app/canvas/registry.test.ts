/**
 * C0-B B5：实例 registry 的 token 语义。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanvasEngineRegistry, type CanvasEngineHooks } from '../../../src/app/canvas/registry.ts';

function hooks(tag: string, calls: string[]): CanvasEngineHooks {
  return {
    lockInteraction: () => calls.push(`${tag}:lock`),
    resumeInteraction: () => calls.push(`${tag}:resume`),
    flush: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
  };
}

void test('register 返回递增 token，current 指向最新实例', () => {
  const registry = createCanvasEngineRegistry();
  const first = registry.register(hooks('a', []));
  assert.equal(registry.current()?.token, first);
  const second = registry.register(hooks('b', []));
  assert.notEqual(second, first);
  assert.equal(registry.current()?.token, second);
});

void test('旧 token unregister 不得注销新实例', () => {
  const registry = createCanvasEngineRegistry();
  const stale = registry.register(hooks('old', []));
  const current = registry.register(hooks('new', []));

  registry.unregister(stale);

  assert.equal(registry.current()?.token, current);
  registry.unregister(current);
  assert.equal(registry.current(), null);
});

void test('重复 unregister 幂等，不影响后续注册', () => {
  const registry = createCanvasEngineRegistry();
  const token = registry.register(hooks('a', []));
  registry.unregister(token);
  registry.unregister(token);
  assert.equal(registry.current(), null);

  const next = registry.register(hooks('b', []));
  assert.equal(registry.current()?.token, next);
  assert.notEqual(next, token);
});
