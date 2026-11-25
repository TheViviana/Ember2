/**
 * CR-R4-2：ai-node-run 的执行编排与四条失败路径（fake deps，零 IPC）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_RUN_MAX_CHARS } from '../../../src/app/canvas/ai-node-execution.ts';
import {
  createAiNodeRunner,
  type AiNodeRunDeps,
  type AiRunOutput,
} from '../../../src/app/canvas/ai-node-run.ts';
import { mapAiErrorCode } from '../../../src/features/ai/ai-error-map.ts';
import { AI_CHAT_CONFIG_INITIAL } from '../../../src/features/ai/ai-chat-store.ts';

const AI_NODE = { id: 'ai1', type: 'ai', model: 'test-model' };

function docNode(id: string, docPath: string, label: string) {
  return { id, type: 'document', docPath, label };
}

function edge(from: string, to: string) {
  return { from: { nodeId: from }, to: { nodeId: to } };
}

interface Recorder {
  readonly notices: { message: string; tone: string }[];
  readonly flashes: { nodeId: string; kind: string }[];
  readonly cancels: string[];
  readonly applied: AiRunOutput[];
  streams: number;
}

function recorder(): Recorder {
  return { notices: [], flashes: [], cancels: [], applied: [], streams: 0 };
}

function deps(rec: Recorder, overrides: Partial<AiNodeRunDeps> = {}): AiNodeRunDeps {
  return {
    getDocument: () => ({ nodes: [], edges: [] }),
    liveText: () => null,
    readSnapshot: () => Promise.resolve({ text: '', sha256: 'sha-empty' }),
    aiConfig: AI_CHAT_CONFIG_INITIAL,
    stream: () => Promise.resolve(),
    cancel: (requestId) => rec.cancels.push(requestId),
    notice: (message, tone) => rec.notices.push({ message, tone }),
    execute: (output) => {
      rec.applied.push(output);
      return Promise.resolve({ ok: true });
    },
    flash: (nodeId, kind) => rec.flashes.push({ nodeId, kind }),
    ...overrides,
  };
}

void test('失败路径：无输出目标', async () => {
  const rec = recorder();
  const runner = createAiNodeRunner(
    deps(rec, {
      getDocument: () => ({
        nodes: [AI_NODE, docNode('d1', 'a.md', 'A')],
        edges: [edge('d1', 'ai1')],
      }),
      readSnapshot: () => Promise.resolve({ text: 'body', sha256: 's1' }),
    }),
  );
  await runner.start('ai1');
  const notice = rec.notices[0];
  assert.ok(notice);
  assert.match(notice.message, /请连接文本节点/);
  assert.equal(notice.tone, 'warning');
  assert.equal(rec.streams, 0);
  assert.equal(rec.flashes.length, 0);
});

void test('失败路径：输出文档非空', async () => {
  const rec = recorder();
  const runner = createAiNodeRunner(
    deps(rec, {
      getDocument: () => ({
        nodes: [AI_NODE, docNode('d1', 'a.md', 'A'), docNode('out', 'out.md', '输出')],
        edges: [edge('d1', 'ai1'), edge('ai1', 'out')],
      }),
      readSnapshot: (path) =>
        Promise.resolve(
          path === 'out.md' ? { text: '已有内容', sha256: 's2' } : { text: 'body', sha256: 's1' },
        ),
    }),
  );
  await runner.start('ai1');
  const notice = rec.notices[0];
  assert.ok(notice);
  assert.match(notice.message, /输出文档已有内容，仅允许写入空文件/);
  assert.equal(rec.streams, 0);
  assert.equal(rec.applied.length, 0);
});

void test('失败路径：素材过长', async () => {
  const rec = recorder();
  const runner = createAiNodeRunner(
    deps(rec, {
      getDocument: () => ({
        nodes: [AI_NODE, docNode('d1', 'a.md', 'A'), { id: 't1', type: 'text' }],
        edges: [edge('d1', 'ai1'), edge('ai1', 't1')],
      }),
      readSnapshot: () => Promise.resolve({ text: 'x'.repeat(AI_RUN_MAX_CHARS), sha256: 's1' }),
      stream: () => {
        rec.streams += 1;
        return Promise.resolve();
      },
    }),
  );
  await runner.start('ai1');
  const notice = rec.notices[0];
  assert.ok(notice);
  assert.match(notice.message, new RegExp(`素材过长（上限 ${AI_RUN_MAX_CHARS} 字符）`));
  assert.equal(notice.tone, 'warning');
  assert.equal(rec.streams, 0);
});

void test('失败路径：流式中失败 → flash error + 映射文案', async () => {
  const rec = recorder();
  const runner = createAiNodeRunner(
    deps(rec, {
      getDocument: () => ({
        nodes: [AI_NODE, docNode('d1', 'a.md', 'A'), { id: 't1', type: 'text' }],
        edges: [edge('d1', 'ai1'), edge('ai1', 't1')],
      }),
      readSnapshot: () => Promise.resolve({ text: 'body', sha256: 's1' }),
      stream: (_request, handlers) => {
        rec.streams += 1;
        handlers.onDelta('部分输出');
        handlers.onError('E_AI_NETWORK', '网络中断');
        return Promise.resolve();
      },
    }),
  );
  await runner.start('ai1');
  assert.equal(rec.streams, 1);
  assert.deepEqual(rec.flashes, [{ nodeId: 'ai1', kind: 'error' }]);
  const last = rec.notices[rec.notices.length - 1];
  assert.ok(last);
  assert.equal(last.message, mapAiErrorCode('E_AI_NETWORK', '网络中断').text);
  assert.equal(last.tone, 'error');
  assert.equal(rec.applied.length, 0);
  assert.equal(rec.cancels.length, 0);
});

void test('成功路径：写入文本节点', async () => {
  const rec = recorder();
  const runner = createAiNodeRunner(
    deps(rec, {
      getDocument: () => ({
        nodes: [AI_NODE, docNode('d1', 'a.md', 'A'), { id: 't1', type: 'text' }],
        edges: [edge('d1', 'ai1'), edge('ai1', 't1')],
      }),
      readSnapshot: () => Promise.resolve({ text: 'body', sha256: 's1' }),
      aiConfig: { ...AI_CHAT_CONFIG_INITIAL, model: 'config-model' },
      stream: (_request, handlers) => {
        rec.streams += 1;
        handlers.onDelta('结');
        handlers.onDelta('果');
        handlers.onDone();
        return Promise.resolve();
      },
    }),
  );
  await runner.start('ai1');
  assert.deepEqual(rec.applied, [{ kind: 'label', nodeId: 't1', text: '结果' }]);
  assert.deepEqual(rec.flashes, [{ nodeId: 'ai1', kind: 'ok' }]);
  const last = rec.notices[rec.notices.length - 1];
  assert.ok(last);
  assert.equal(last.message, 'AI 结果已写入文本节点');
  assert.equal(last.tone, 'info');
});

void test('取消：cancel() 携带 requestId，后续事件不再写回', async () => {
  const rec = recorder();
  let finish: () => void = () => undefined;
  const runner = createAiNodeRunner(
    deps(rec, {
      getDocument: () => ({
        nodes: [AI_NODE, docNode('d1', 'a.md', 'A'), { id: 't1', type: 'text' }],
        edges: [edge('d1', 'ai1'), edge('ai1', 't1')],
      }),
      readSnapshot: () => Promise.resolve({ text: 'body', sha256: 's1' }),
      stream: (request) => {
        rec.streams += 1;
        assert.match(request.requestId, /^[A-Za-z0-9_-]+$/);
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    }),
  );
  const started = runner.start('ai1');
  await Promise.resolve();
  await Promise.resolve();
  runner.cancel();
  assert.equal(rec.cancels.length, 1);
  finish();
  await started;
  assert.equal(rec.applied.length, 0);
  assert.equal(rec.flashes.length, 0);
});
