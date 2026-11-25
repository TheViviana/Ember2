import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { test } from 'node:test';
import { EmberIpcError } from '../../src/core/errors.ts';
import type { CoreEvent, EventBus } from '../../src/core/events.ts';
import { FakeVaultPort } from '../kernel/fakes.ts';

// app 生产模块沿用 Vite 的无扩展名导入；仅为本测试进程补齐 Node 原生 .ts 解析。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      extname(specifier) === '' &&
      context.parentURL !== undefined &&
      existsSync(new URL(`${specifier}.ts`, context.parentURL))
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { bridgeCoreEvents } = await import('../../src/app/stores/ember-store.ts');

interface FakeBus {
  readonly events: Pick<EventBus<CoreEvent>, 'subscribe'>;
  emit(event: CoreEvent): void;
}

function makeFakeBus(): FakeBus {
  const listeners = new Set<(event: CoreEvent) => void>();
  return {
    events: {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    emit: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function makePush(): {
  readonly records: { message: string; tone: 'error' }[];
  readonly push: (message: string, tone: 'error') => void;
} {
  const records: { message: string; tone: 'error' }[] = [];
  return {
    records,
    push: (message, tone) => {
      records.push({ message, tone });
    },
  };
}

void test('core:error 桥接：只推送一次常驻 error，格式为错误码加简述', () => {
  const bus = makeFakeBus();
  const { records, push } = makePush();
  bridgeCoreEvents(bus.events, push);

  bus.emit({
    type: 'core:error',
    error: new EmberIpcError('vault://watch-error', 'E_IO', 'watcher failed', 'E_IO'),
  });

  assert.deepEqual(records, [
    { message: '[core:error] E_IO: watcher failed', tone: 'error' },
  ]);
});

void test('core:error 桥接：ready 与 disposed 不推 UI 通知', () => {
  const bus = makeFakeBus();
  const { records, push } = makePush();
  const vault = new FakeVaultPort();
  bridgeCoreEvents(bus.events, push);

  bus.emit({
    type: 'core:ready',
    identity: vault.identityValue,
    constants: vault.constantsValue,
  });
  bus.emit({ type: 'core:disposed' });

  assert.equal(records.length, 0);
});

void test('core:error 桥接：退订后不再推送', () => {
  const bus = makeFakeBus();
  const { records, push } = makePush();
  const unsubscribe = bridgeCoreEvents(bus.events, push);
  unsubscribe();

  bus.emit({
    type: 'core:error',
    error: new EmberIpcError('vault_read', 'E_IO', 'read failed', 'E_IO'),
  });

  assert.equal(records.length, 0);
});
