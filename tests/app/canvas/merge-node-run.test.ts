/**
 * 汇总节点执行编排：一次生成、超预算拒绝、输出校验与取消（fake deps）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AiRunOutput } from '../../../src/app/canvas/ai-node-run.ts';
import {
  createMergeNodeRunner,
  type MergeRunDeps,
} from '../../../src/app/canvas/merge-node-run.ts';
import { AI_CHAT_CONFIG_INITIAL } from '../../../src/features/ai/ai-chat-store.ts';
import { charBudgetFor } from '../../../src/features/ai/model-budget.ts';
import { mergeOutputsToDocument } from '../../../src/app/canvas/node-layout.ts';

const MERGE = { id: 'm1', type: 'merge' };

function textNode(id: string, label = '') {
  return { id, type: 'text', label };
}

function docNode(id: string, docPath: string) {
  return { id, type: 'document', docPath, label: '输出' };
}

function edge(from: string, to: string) {
  return { from: { nodeId: from }, to: { nodeId: to } };
}

interface Recorder {
  readonly notices: { message: string; tone: string }[];
  readonly flashes: { nodeId: string; kind: string }[];
  readonly applied: AiRunOutput[];
  streams: number;
}

function recorder(): Recorder {
  return { notices: [], flashes: [], applied: [], streams: 0 };
}

function deps(rec: Recorder, overrides: Partial<MergeRunDeps> = {}): MergeRunDeps {
  return {
    getDocument: () => ({ nodes: [], edges: [] }),
    aiConfig: { ...AI_CHAT_CONFIG_INITIAL, model: 'test-model' },
    stream: () => Promise.resolve(),
    cancel: () => undefined,
    notice: (message, tone) => rec.notices.push({ message, tone }),
    execute: (output) => {
      rec.applied.push(output);
      return Promise.resolve({ ok: true });
    },
    readSnapshot: () => Promise.resolve({ text: '', sha256: 'sha' }),
    flash: (nodeId, kind) => rec.flashes.push({ nodeId, kind }),
    ...overrides,
  };
}

void test('成功路径：按连线顺序拼接并写入文本节点', async () => {
  const rec = recorder();
  let userContent = '';
  const runner = createMergeNodeRunner(
    deps(rec, {
      getDocument: () => ({
        nodes: [MERGE, textNode('b1', '第一块'), textNode('b2', '第二块'), textNode('o1')],
        edges: [edge('b1', 'm1'), edge('b2', 'm1'), edge('m1', 'o1')],
      }),
      stream: (request, handlers) => {
        rec.streams += 1;
        const user = request.messages.find((message) => message.role === 'user');
        userContent = typeof user?.content === 'string' ? user.content : '';
        handlers.onDelta('汇总结果');
        handlers.onDone();
        return Promise.resolve();
      },
    }),
  );

  await runner.start('m1');
  assert.equal(rec.streams, 1);
  assert.match(userContent, /【块 1】[\s\S]*第一块[\s\S]*【块 2】[\s\S]*第二块/);
  assert.deepEqual(rec.applied, [{ kind: 'label', nodeId: 'o1', text: '汇总结果' }]);
  assert.deepEqual(rec.flashes, [{ nodeId: 'm1', kind: 'ok' }]);
});

void test('上游块被编辑后：merge 读取当前内容而非原始切分文本', async () => {
  const rec = recorder();
  let userContent = '';
  const runner = createMergeNodeRunner(
    deps(rec, {
      getDocument: () => ({
        nodes: [
          MERGE,
          { id: 'b1', type: 'text', label: '用户编辑后的第 1 块', chunkIndex: 0, sourceNodeId: 's1' },
          textNode('o1'),
        ],
        edges: [edge('b1', 'm1'), edge('m1', 'o1')],
      }),
      stream: (request, handlers) => {
        const user = request.messages.find((message) => message.role === 'user');
        userContent = typeof user?.content === 'string' ? user.content : '';
        handlers.onDelta('汇总结果');
        handlers.onDone();
        return Promise.resolve();
      },
    }),
  );

  await runner.start('m1');
  assert.match(userContent, /用户编辑后的第 1 块/);
  assert.doesNotMatch(userContent, /原始切分文本/);
});

void test('输入超过预算：拒绝执行并报数', async () => {
  const rec = recorder();
  const budget = charBudgetFor('ollama');
  const runner = createMergeNodeRunner(
    deps(rec, {
      getDocument: () => ({
        nodes: [MERGE, textNode('b1', 'x'.repeat(budget)), textNode('o1')],
        edges: [edge('b1', 'm1'), edge('m1', 'o1')],
      }),
      stream: () => {
        rec.streams += 1;
        return Promise.resolve();
      },
    }),
  );

  await runner.start('m1');
  assert.equal(rec.streams, 0);
  assert.equal(rec.applied.length, 0);
  assert.match(rec.notices[0]?.message ?? '', /超过预算/);
  assert.match(rec.notices[0]?.message ?? '', /减少上游内容，或先拆分再汇总/);
  assert.match(rec.notices[0]?.message ?? '', new RegExp(String(budget)));
});

void test('输出文档非空：拒绝写入', async () => {
  const rec = recorder();
  const runner = createMergeNodeRunner(
    deps(rec, {
      getDocument: () => ({
        nodes: [MERGE, textNode('b1', '块'), docNode('out', 'out.md')],
        edges: [edge('b1', 'm1'), edge('m1', 'out')],
      }),
      readSnapshot: () => Promise.resolve({ text: '已有内容', sha256: 'sha' }),
    }),
  );

  await runner.start('m1');
  assert.equal(rec.applied.length, 0);
  assert.match(rec.notices[0]?.message ?? '', /输出文档已有内容/);
});

void test('没有输入块：提示先连线', async () => {
  const rec = recorder();
  const runner = createMergeNodeRunner(
    deps(rec, {
      getDocument: () => ({
        nodes: [MERGE, textNode('o1')],
        edges: [edge('m1', 'o1')],
      }),
    }),
  );

  await runner.start('m1');
  assert.match(rec.notices[0]?.message ?? '', /请先把块/);
});

void test('取消：不写回结果', async () => {
  const rec = recorder();
  let finish: () => void = () => undefined;
  const runner = createMergeNodeRunner(
    deps(rec, {
      getDocument: () => ({
        nodes: [MERGE, textNode('b1', '块'), textNode('o1')],
        edges: [edge('b1', 'm1'), edge('m1', 'o1')],
      }),
      stream: () => new Promise<void>((resolve) => {
        finish = resolve;
      }),
    }),
  );

  const started = runner.start('m1');
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  runner.cancel();
  finish();
  await started;

  assert.equal(rec.applied.length, 0);
  assert.equal(rec.flashes.length, 0);
});

void test('A4：文本 + document 双输出共用 mergeOutputKind，runner 拒绝且投影不显示例外', async () => {
  const rec = recorder();
  const nodes = [MERGE, textNode('b1', '块'), textNode('o1'), docNode('d1', 'out.md')];
  const edges = [edge('b1', 'm1'), edge('m1', 'o1'), edge('m1', 'd1')];
  const runner = createMergeNodeRunner(
    deps(rec, {
      getDocument: () => ({ nodes, edges }),
      stream: () => Promise.reject(new Error('双输出不应调用模型')),
    }),
  );

  await runner.start('m1');
  assert.equal(rec.streams, 0, '拒绝在执行前');
  assert.match(rec.notices[0]?.message ?? '', /输出目标不唯一/);
  assert.equal(mergeOutputsToDocument(nodes, edges, 'm1'), false, '投影与 runner 同口径');
});