/**
 * M1：重跑二次确认的纯逻辑与 runner 联动。
 *
 * UI 不重复切分判定：runner 命中 guard 时发固定格式通知，本模块识别它，
 * 再补齐下游连线信息；确认后才带 replace:true 重跑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { CanvasCommand } from '#canvas-format';
import {
  buildSplitRerunConfirmMessage,
  retryConfirmForBlock,
  RETRY_DOWNSTREAM_MESSAGE,
  splitRerunConflictFromSignal,
} from '../../../src/app/canvas/split-rerun-confirm.ts';
import {
  SPLIT_RERUN_CONFIRM_CODE,
  type SplitRerunConfirmSignal,
} from '../../../src/core/canvas/split-rerun-contract.ts';
import { createSplitNodeRunner, type SplitRunDeps } from '../../../src/app/canvas/split-node-run.ts';
import { splitTextByBudget } from '../../../src/core/chunk-text.ts';
import { AI_CHAT_CONFIG_INITIAL } from '../../../src/features/ai/ai-chat-store.ts';

const SPLIT = { id: 's1', type: 'split', x: 0, y: 0, w: 176, h: 96 };

function edge(from: string, to: string) {
  return { from: { nodeId: from }, to: { nodeId: to } };
}

function recorder() {
  const state = {
    notices: [] as {
      message: string;
      tone: string;
      signal?: SplitRerunConfirmSignal;
    }[],
    batches: [] as CanvasCommand[][],
    sequence: 0,
  };
  const deps = (overrides: Partial<SplitRunDeps> = {}): SplitRunDeps => ({
    getDocument: () => ({ nodes: [], edges: [] }),
    liveText: () => null,
    readSnapshot: () => Promise.resolve({ text: '', sha256: 'sha' }),
    aiConfig: { ...AI_CHAT_CONFIG_INITIAL, model: 'test-model' },
    stream: () => Promise.resolve(),
    cancel: () => undefined,
    notice: (message, tone, signal) => state.notices.push({ message, tone, signal }),
    executeCommands: (commands) => {
      state.batches.push([...commands]);
      return true;
    },
    createNodeId: () => `n${++state.sequence}`,
    createEdgeId: () => `e${++state.sequence}`,
    occupiedRects: () => [],
    progress: () => undefined,
    flash: () => undefined,
    ...overrides,
  });
  return { state, deps };
}

function editedAndDownstreamDoc() {
  const text = 'x'.repeat(20);
  return {
    nodes: [
      SPLIT,
      { id: 'd1', type: 'document', docPath: 'a.md', label: 'A' },
      { id: 'c1', type: 'text', label: '我改过', chunkIndex: 0, sourceNodeId: 's1' },
      { id: 'o1', type: 'text', label: '下游' },
    ],
    edges: [edge('d1', 's1'), edge('s1', 'c1'), edge('c1', 'o1')],
    text,
  };
}

void test('结构化匹配：只认 code，文案变化不影响确认触发', () => {
  const signal: SplitRerunConfirmSignal = {
    code: SPLIT_RERUN_CONFIRM_CODE,
    edited: true,
    downstream: true,
    existingBlockCount: 3,
  };
  assert.deepEqual(splitRerunConflictFromSignal(signal), { edited: true, downstream: true });
  assert.equal(
    splitRerunConflictFromSignal({ ...signal, code: 'other' as never }),
    null,
  );
  assert.equal(splitRerunConflictFromSignal(undefined), null);
});

void test('下游不重算：runner 信号里的 downstream 直接被 UI 消费', () => {
  const signal: SplitRerunConfirmSignal = {
    code: SPLIT_RERUN_CONFIRM_CODE,
    edited: false,
    downstream: true,
    existingBlockCount: 1,
  };
  const conflict = splitRerunConflictFromSignal(signal);
  assert.ok(conflict !== null);
  assert.equal(conflict.downstream, true);
  assert.match(buildSplitRerunConfirmMessage(conflict), /下游连线会断开/);
});

void test('双命中文案同时说明覆盖已编辑块与断开下游连线', () => {
  const message = buildSplitRerunConfirmMessage({ edited: true, downstream: true });
  assert.match(message, /块内容与重新切分结果不同/);
  assert.match(message, /下游连线会断开/);
  assert.doesNotMatch(message, /\d+\s*块/);
});

void test('确认覆盖：先由 runner 拦截零命令，再用 replace:true 产生一批覆盖命令', async () => {
  const { state, deps } = recorder();
  const doc = editedAndDownstreamDoc();
  const runner = createSplitNodeRunner(
    deps({
      getDocument: () => ({ nodes: doc.nodes, edges: doc.edges }),
      readSnapshot: () => Promise.resolve({ text: doc.text, sha256: 's' }),
    }),
  );

  await runner.start('s1');
  assert.equal(state.batches.length, 0, '未确认不产生命令');
  assert.deepEqual(state.notices[0]?.signal, {
    code: SPLIT_RERUN_CONFIRM_CODE,
    edited: true,
    downstream: true,
    existingBlockCount: 1,
  });
  const conflict = splitRerunConflictFromSignal(state.notices[0]?.signal);
  assert.deepEqual(conflict, { edited: true, downstream: true });
  assert.ok(conflict !== null);
  assert.match(buildSplitRerunConfirmMessage(conflict), /下游连线会断开/);

  await runner.start('s1', { replace: true });
  assert.equal(state.batches.length, 1, '确认后整批覆盖');
  assert.equal(state.batches[0]?.[0]?.kind, 'removeNode');
});

void test('取消确认：不发起第二次重跑，节点命令与历史均无变化', async () => {
  const { state, deps } = recorder();
  const doc = editedAndDownstreamDoc();
  const runner = createSplitNodeRunner(
    deps({
      getDocument: () => ({ nodes: doc.nodes, edges: doc.edges }),
      readSnapshot: () => Promise.resolve({ text: doc.text, sha256: 's' }),
    }),
  );

  await runner.start('s1');
  // 用户取消：不调用 replace:true。
  assert.equal(state.batches.length, 0);
  assert.equal(state.notices.length, 1);
});

void test('未命中：不改块且无下游时直接执行，不进入确认分支', async () => {
  const { state, deps } = recorder();
  const text = 'x'.repeat(20);
  const full = `【文章 1：A】 ${text}`;
  const chunk = splitTextByBudget(full, 500)[0];
  const blockText = full.slice(chunk?.start ?? 0, chunk?.end ?? full.length);
  const runner = createSplitNodeRunner(
    deps({
      getDocument: () => ({
        nodes: [
          SPLIT,
          { id: 'd1', type: 'document', docPath: 'a.md', label: 'A' },
          { id: 'c1', type: 'text', label: blockText, chunkIndex: 0, sourceNodeId: 's1' },
        ],
        edges: [edge('d1', 's1'), edge('s1', 'c1')],
      }),
      readSnapshot: () => Promise.resolve({ text, sha256: 's' }),
    }),
  );

  await runner.start('s1');
  assert.equal(state.batches.length, 1);
  assert.equal(
    splitRerunConflictFromSignal(state.notices[0]?.signal),
    null,
    '成功通知不应进入确认分支',
  );
});

void test('B2：单块有下游边才需要重试确认', () => {
  assert.equal(retryConfirmForBlock([], 'b1'), null, '无下游直接重试');
  assert.equal(
    retryConfirmForBlock([{ from: { nodeId: 'u' }, to: { nodeId: 'b1' } }], 'b1'),
    null,
    '只有入边不算下游',
  );
  assert.equal(
    retryConfirmForBlock([{ from: { nodeId: 'b1' }, to: { nodeId: 'b1' } }], 'b1'),
    null,
    '自环不算下游',
  );
  assert.deepEqual(
    retryConfirmForBlock([{ from: { nodeId: 'b1' }, to: { nodeId: 'o1' } }], 'b1'),
    { nodeId: 'b1', message: RETRY_DOWNSTREAM_MESSAGE },
  );
  assert.equal(RETRY_DOWNSTREAM_MESSAGE, '该块有下游连线，重试会改写其内容');
});