/**
 * 内核事件：给 UI / 日志侧的一次性通知（不同于 VaultPort 的后端事件）。
 *
 * 判别联合保证订阅侧 switch 穷尽；新增事件类型只追加，不改既有字段。
 */
import type { VaultConstantsDto, VaultIdentityDto } from '../types/ipc.ts';
import type { EmberIpcError } from './errors.ts';
import type { Unsubscribe } from './ports.ts';

/** 启动成功：identity + constants 已就绪。 */
export interface CoreReadyEvent {
  readonly type: 'core:ready';
  readonly identity: VaultIdentityDto;
  readonly constants: VaultConstantsDto;
}

/** 任何内核级失败（启动、监听、后续写入 / 索引）。 */
export interface CoreErrorEvent {
  readonly type: 'core:error';
  readonly error: EmberIpcError;
}

export interface CoreDisposedEvent {
  readonly type: 'core:disposed';
}

export type CoreEvent = CoreReadyEvent | CoreErrorEvent | CoreDisposedEvent;

export interface EventBus<E> {
  emit(event: E): void;
  subscribe(listener: (event: E) => void): Unsubscribe;
}

export function createEventBus<E>(): EventBus<E> {
  const listeners = new Set<(event: E) => void>();

  function emit(event: E): void {
    // 迭代副本：监听器内退订不会跳过后续监听器。
    for (const listener of [...listeners]) listener(event);
  }

  function subscribe(listener: (event: E) => void): Unsubscribe {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return { emit, subscribe };
}
