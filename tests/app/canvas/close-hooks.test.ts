/**
 * C0-B B5：关窗画布钩子只触达 registry 当前实例，失败恢复交互且不吞错。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createCanvasCloseHooks,
  type CanvasCloseStore,
} from '../../../src/app/canvas/close-hooks.ts';
import { CanvasFlushError } from '../../../src/app/canvas/lifecycle.ts';
import { createCanvasEngineRegistry } from '../../../src/app/canvas/registry.ts';

function store(options: {
  readonly ok?: boolean;
  readonly timedOut?: boolean;
} = {}): { store: CanvasCloseStore; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    store: {
      flush: () => {
        calls.push('store.flush');
        return Promise.resolve({
          ok: options.ok ?? true,
          timedOut: options.timedOut ?? false,
          error: options.ok === false ? { message: 'canvas flush failed' } : null,
        });
      },
      beginClosing: () => calls.push('seal'),
      cancelClosing: () => calls.push('cancel'),
    },
  };
}

void test('无挂载实例：仍 flush core 队列，不调用 lock/resume', async () => {
  const registry = createCanvasEngineRegistry();
  const fake = store();
  const hooks = createCanvasCloseHooks(registry, fake.store);

  await hooks.flush();
  assert.deepEqual(fake.calls, ['store.flush']);
});

void test('有实例：lock → beforeFlush → store.flush；成功不 resume', async () => {
  const registry = createCanvasEngineRegistry();
  const calls: string[] = [];
  registry.register({
    lockInteraction: () => calls.push('lock'),
    resumeInteraction: () => calls.push('resume'),
    flush: () => {
      calls.push('beforeFlush');
      return Promise.resolve();
    },
    dispose: () => Promise.resolve(),
  });
  const fake = store();

  await createCanvasCloseHooks(registry, fake.store).flush();
  assert.deepEqual(calls, ['lock', 'beforeFlush']);
  assert.deepEqual(fake.calls, ['store.flush']);
});

void test('实例 beforeFlush 失败：resume、不触达 core flush、错误上抛', async () => {
  const registry = createCanvasEngineRegistry();
  const calls: string[] = [];
  registry.register({
    lockInteraction: () => calls.push('lock'),
    resumeInteraction: () => calls.push('resume'),
    flush: () => Promise.reject(new Error('pending save failed')),
    dispose: () => Promise.resolve(),
  });
  const fake = store();

  await assert.rejects(
    createCanvasCloseHooks(registry, fake.store).flush(),
    /pending save failed/,
  );
  assert.deepEqual(calls, ['lock', 'resume']);
  assert.deepEqual(fake.calls, []);
});

void test('core flush 失败/超时：resume 并抛 CanvasFlushError', async () => {
  const registry = createCanvasEngineRegistry();
  const calls: string[] = [];
  registry.register({
    lockInteraction: () => calls.push('lock'),
    resumeInteraction: () => calls.push('resume'),
    flush: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
  });
  const fake = store({ ok: false, timedOut: true });

  await assert.rejects(
    createCanvasCloseHooks(registry, fake.store).flush(),
    (error: unknown) => {
      assert.ok(error instanceof CanvasFlushError);
      assert.equal(error.code, 'E_FLUSH_TIMEOUT');
      return true;
    },
  );
  assert.deepEqual(calls, ['lock', 'resume']);
});

void test('seal / cancelSeal 只操作 core canvas 闩锁', () => {
  const registry = createCanvasEngineRegistry();
  const fake = store();
  const hooks = createCanvasCloseHooks(registry, fake.store);
  hooks.seal();
  hooks.cancelSeal();
  assert.deepEqual(fake.calls, ['seal', 'cancel']);
});
