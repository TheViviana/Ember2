/**
 * CR-R5-1：AI 流式管线单源（fake stream，零 IPC）——
 * 构建失败 / 首 delta 前 reject / 中途 error / 取消恰好一次。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AiChatRequest } from '../../../src/types/ipc.ts';
import { mapAiErrorCode } from '../../../src/features/ai/ai-error-map.ts';
import { AI_CHAT_CONFIG_INITIAL } from '../../../src/features/ai/ai-chat-store.ts';
import {
  startChatSession,
  type ChatSessionArgs,
  type ChatSessionDeps,
  type ChatSessionFailure,
  type ChatSessionStreamHandlers,
} from '../../../src/features/ai/chat-session.ts';

const CONFIG = { ...AI_CHAT_CONFIG_INITIAL, model: 'm' };
const MESSAGES = [{ id: 'u1', role: 'user' as const, content: '你好', completed: true }];

interface Log {
  readonly deltas: string[];
  readonly failures: ChatSessionFailure[];
  done: number;
}

function harness(deps: ChatSessionDeps) {
  const log: Log = { deltas: [], failures: [], done: 0 };
  const run = (args: Partial<ChatSessionArgs> = {}) => startChatSession(
    { config: CONFIG, messages: MESSAGES, ...args },
    {
      onDelta: (text) => log.deltas.push(text),
      onDone: () => {
        log.done += 1;
      },
      onError: (failure) => log.failures.push(failure),
    },
    deps,
  );
  return { log, run };
}

void test('构建失败：缺模型折成 build，不发起流、取消空转', () => {
  let streamed = 0;
  const { log, run } = harness({
    stream: () => {
      streamed += 1;
      return Promise.resolve();
    },
    cancel: () => undefined,
  });
  const session = run({ config: AI_CHAT_CONFIG_INITIAL });
  assert.deepEqual(log.failures, [{ kind: 'build', reason: 'missing_model' }]);
  assert.equal(streamed, 0);
  session.cancel();
  assert.equal(streamed, 0);
});

void test('首 delta 前 reject：折成 stream 失败并附映射文案', async () => {
  const error = Object.assign(new Error('连接失败'), { code: 'E_AI_NETWORK' });
  const { log, run } = harness({ stream: () => Promise.reject(error), cancel: () => undefined });
  run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(log.failures, [{
    kind: 'stream',
    code: 'E_AI_NETWORK',
    message: '连接失败',
    text: mapAiErrorCode('E_AI_NETWORK', '连接失败').text,
  }]);
  assert.deepEqual(log.deltas, []);
  assert.equal(log.done, 0);
});

void test('中途 error：先给累积全文，再折成 stream 失败，不告 done', () => {
  const requests: AiChatRequest[] = [];
  const { log, run } = harness({
    stream: (request, handlers) => {
      requests.push(request);
      handlers.onDelta('半');
      handlers.onError('E_AI_NETWORK', '网络中断');
      return Promise.resolve();
    },
    cancel: () => undefined,
  });
  run({ system: 'sys' });
  assert.deepEqual(log.deltas, ['半']);
  assert.deepEqual(log.failures, [{
    kind: 'stream',
    code: 'E_AI_NETWORK',
    message: '网络中断',
    text: mapAiErrorCode('E_AI_NETWORK', '网络中断').text,
  }]);
  assert.equal(log.done, 0);
  assert.equal(requests[0]?.messages[0]?.role, 'system');
  assert.equal(requests[0]?.messages[0]?.content, 'sys');
});

void test('取消：重复调用只取消在途请求一次，之后不再回调', () => {
  const cancelled: string[] = [];
  const handlers: ChatSessionStreamHandlers[] = [];
  let requestId = '';
  const { log, run } = harness({
    stream: (request, streamHandlers) => {
      requestId = request.requestId;
      handlers.push(streamHandlers);
      return new Promise<void>(() => undefined);
    },
    cancel: (id) => {
      cancelled.push(id);
    },
  });
  const session = run();
  session.cancel();
  session.cancel();
  handlers[0]?.onDelta('迟到');
  assert.deepEqual(cancelled, [requestId]);
  assert.equal(requestId.length > 0, true);
  assert.deepEqual(log.deltas, []);
});
