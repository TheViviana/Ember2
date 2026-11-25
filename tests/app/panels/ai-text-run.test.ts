/**
 * CR-R4-4：选中文本 AI 动作（DI）——成功正路径与全部失败路径，fake deps，零 IPC。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { EmberIpcError } from '../../../src/data/ipc-client.ts';
import type { AiChatRequest } from '../../../src/types/ipc.ts';
import type { ChatRequestConfig } from '../../../src/features/ai/ai-chat-request.ts';
import type { AiTextActionId } from '../../../src/features/ai/ai-text-actions.ts';
import {
  createAiTextRun,
  type AiTextFailure,
  type AiTextRunDeps,
} from '../../../src/app/panels/ai-text-run.ts';

const VALID_CONFIG: ChatRequestConfig = {
  provider: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  allowInsecureHttp: false,
  model: 'gpt-x',
};

interface CardLog {
  readonly deltas: string[];
  readonly done: string[];
  readonly errors: string[];
}

function newLog(): CardLog {
  return { deltas: [], done: [], errors: [] };
}

function handlersOf(log: CardLog) {
  return {
    onDelta: (full: string): void => {
      log.deltas.push(full);
    },
    onDone: (full: string): void => {
      log.done.push(full);
    },
    onError: (message: string): void => {
      log.errors.push(message);
    },
  };
}

type StreamFake = AiTextRunDeps['stream'];

interface Harness {
  readonly deps: AiTextRunDeps;
  readonly requests: AiChatRequest[];
  readonly cancelled: string[];
  readonly failures: AiTextFailure[];
}

function harness(
  options: { readonly config?: ChatRequestConfig; readonly stream?: StreamFake } = {},
): Harness {
  const requests: AiChatRequest[] = [];
  const cancelled: string[] = [];
  const failures: AiTextFailure[] = [];
  const stream: StreamFake = options.stream ?? (() => Promise.resolve());
  const deps: AiTextRunDeps = {
    config: () => options.config ?? VALID_CONFIG,
    stream: (request, streamHandlers) => {
      requests.push(request);
      return stream(request, streamHandlers);
    },
    cancel: (requestId) => {
      cancelled.push(requestId);
      return Promise.resolve({ cancelled: true });
    },
    notice: (failure) => {
      failures.push(failure);
      if (failure.kind === 'unknown-action') return '未知的 AI 动作';
      if (failure.kind === 'config') return `配置无效:${failure.reason}`;
      return `流失败:${failure.code ?? '-'}:${failure.message}`;
    },
  };
  return { deps, requests, cancelled, failures };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

void test('成功：逐段累积，done 给全文，系统提示与动作指令不变', () => {
  const h = harness({
    stream: (request, streamHandlers) => {
      streamHandlers.onDelta({ type: 'delta', requestId: request.requestId, text: '你' });
      streamHandlers.onDelta({ type: 'delta', requestId: request.requestId, text: '好' });
      streamHandlers.onDone({ type: 'done', requestId: request.requestId });
      return Promise.resolve();
    },
  });
  const log = newLog();
  createAiTextRun(h.deps).run('polish', '原文', handlersOf(log));
  assert.deepEqual(log.deltas, ['你', '你好']);
  assert.deepEqual(log.done, ['你好']);
  assert.deepEqual(h.failures, []);
  const request = h.requests[0];
  assert.equal(request?.messages[0]?.role, 'system');
  assert.equal(request?.messages[1]?.content, '润色下面的文字：\n\n原文');
});

void test('未知动作：只报卡片错误，不发起请求、不调用取消', () => {
  const h = harness();
  const log = newLog();
  const cancel = createAiTextRun(h.deps).run(
    'nope' as unknown as AiTextActionId,
    '文本',
    handlersOf(log),
  );
  assert.deepEqual(log.errors, ['未知的 AI 动作']);
  assert.deepEqual(h.failures, [{ kind: 'unknown-action' }]);
  assert.equal(h.requests.length, 0);
  cancel();
  assert.deepEqual(h.cancelled, []);
});

void test('配置无效：缺模型时直接报卡片错误，不发起请求', () => {
  const h = harness({ config: { ...VALID_CONFIG, model: null } });
  const log = newLog();
  createAiTextRun(h.deps).run('expand', '文本', handlersOf(log));
  assert.deepEqual(log.errors, ['配置无效:missing_model']);
  assert.equal(h.requests.length, 0);
});

void test('首 delta 前失败：reject 折成卡片错误，不产生 delta / done', async () => {
  const h = harness({ stream: () => Promise.reject(new Error('连接失败')) });
  const log = newLog();
  createAiTextRun(h.deps).run('condense', '文本', handlersOf(log));
  await flush();
  assert.deepEqual(log.errors, ['流失败:-:连接失败']);
  assert.deepEqual(log.deltas, []);
  assert.deepEqual(log.done, []);
});

void test('流式中失败：沿用事件中的错误码与文案', () => {
  const h = harness({
    stream: (request, streamHandlers) => {
      streamHandlers.onDelta({ type: 'delta', requestId: request.requestId, text: '半' });
      streamHandlers.onError({} as EmberIpcError, {
        type: 'error',
        requestId: request.requestId,
        code: 'E_AI_NETWORK',
        message: '网络连接失败',
      });
      return Promise.resolve();
    },
  });
  const log = newLog();
  createAiTextRun(h.deps).run('summarize', '文本', handlersOf(log));
  assert.deepEqual(log.deltas, ['半']);
  assert.deepEqual(log.errors, ['流失败:E_AI_NETWORK:网络连接失败']);
  assert.deepEqual(log.done, []);
});

void test('取消：run 的取消函数与 flow.cancel 都只取消在途请求一次', () => {
  const h = harness({ stream: () => new Promise<void>(() => undefined) });
  const runner = createAiTextRun(h.deps);
  const cancel = runner.run('extend', '文本', handlersOf(newLog()));
  const requestId = h.requests[0]?.requestId;
  assert.equal(typeof requestId, 'string');
  cancel();
  assert.deepEqual(h.cancelled, [requestId]);
  runner.cancel();
  assert.deepEqual(h.cancelled, [requestId]);

  const h2 = harness({ stream: () => new Promise<void>(() => undefined) });
  const runner2 = createAiTextRun(h2.deps);
  runner2.run('define', '文本', handlersOf(newLog()));
  runner2.cancel();
  runner2.cancel();
  assert.deepEqual(h2.cancelled, [h2.requests[0]?.requestId]);
});
