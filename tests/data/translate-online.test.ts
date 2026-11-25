/**
 * CR-20261121-41：translateOnline 事件链验证（假传输层 + 最小 window shim）。
 * 验证 progress/segment 事件按序送达回调、resolve 返回权威全文、
 * {code,message} 形态的拒绝正确转为 EmberIpcError。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createIpcClient, type IpcTransport } from '../../src/data/ipc-client.ts';
import { toIpcError, EmberIpcError } from '../../src/core/errors.ts';
import type { TranslateEvent } from '../../src/types/ipc.ts';

// 最小 window shim：Channel 构造需要 __TAURI_INTERNALS__.transformCallback（真机由 Tauri 注入）。
const callbacks = new Map<number, (raw: unknown) => void>();
let callbackId = 0;
(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    transformCallback: (callback: (raw: unknown) => void) => {
      callbackId += 1;
      callbacks.set(callbackId, callback);
      return callbackId;
    },
  },
};

interface FakeInvokeArgs {
  readonly onEvent: { readonly id: number };
}

function fakeTransport(
  script: (deliver: (event: TranslateEvent, index: number) => void) => Promise<string>,
  onInvoke?: (command: string) => void,
): IpcTransport {
  return {
    invoke<T>(command: string, args?: unknown): Promise<T> {
      onInvoke?.(command);
      if (command !== 'translate_online') {
        return Promise.reject(new Error(`unexpected command: ${command}`));
      }
      const { onEvent } = args as FakeInvokeArgs;
      const deliver = (event: TranslateEvent, index: number): void => {
        callbacks.get(onEvent.id)?.({ index, message: event });
      };
      return script(deliver) as Promise<T>;
    },
  };
}

void test('progress 与 segment 事件按序送达，resolve 返回全文兜底', async () => {
  const events: TranslateEvent[] = [];
  const client = createIpcClient(
    fakeTransport((deliver) => {
      deliver({ type: 'progress', done: 0, total: 2 }, 0);
      deliver({ type: 'progress', done: 1, total: 2 }, 1);
      deliver({ type: 'segment', index: 0, source: '原文一', text: '第一段' }, 2);
      deliver({ type: 'progress', done: 2, total: 2 }, 3);
      deliver({ type: 'segment', index: 1, source: '原文二', text: '第二段' }, 4);
      return Promise.resolve('第一段\n\n第二段');
    }),
  );
  const result = await client.translateOnline({ text: 'x', targetLang: '中文' }, (event) => {
    events.push(event);
  });
  assert.deepEqual(events, [
    { type: 'progress', done: 0, total: 2 },
    { type: 'progress', done: 1, total: 2 },
    { type: 'segment', index: 0, source: '原文一', text: '第一段' },
    { type: 'progress', done: 2, total: 2 },
    { type: 'segment', index: 1, source: '原文二', text: '第二段' },
  ]);
  assert.equal(result, '第一段\n\n第二段');
});

void test('invoke 载荷含 onEvent 通道且命令名正确', async () => {
  const seen: string[] = [];
  const client = createIpcClient(
    fakeTransport(() => Promise.resolve('ok'), (command) => seen.push(command)),
  );
  await client.translateOnline({ text: 'x', targetLang: '英文' }, () => undefined);
  assert.deepEqual(seen, ['translate_online']);
});

void test('拒绝载荷 {code,message} 经 toIpcError 转 EmberIpcError 并保留原文案', () => {
  // Tauri 对自定义 Err 的拒绝形态是序列化后的载荷对象（非 Error 实例）；
  // translateOnline 的 catch 统一走 toIpcError，这里直接验证该映射。
  const rejection: unknown = { code: 'E_TRANSLATE_NETWORK', message: '联网翻译网络请求失败' };
  const error = toIpcError('translate_online', rejection);
  assert.ok(error instanceof EmberIpcError);
  assert.equal(error.code, 'E_TRANSLATE_NETWORK');
  assert.equal(error.message, '联网翻译网络请求失败');
});
