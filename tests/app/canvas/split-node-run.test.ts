/**
 * 分块节点执行编排：切分、覆盖确认、逐块提炼、失败与取消（fake deps）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { CanvasCommand } from '#canvas-format';
import { layoutChunkNodes } from '../../../src/app/canvas/split-node-execution.ts';
import { splitTextByBudget } from '../../../src/core/chunk-text.ts';
import {
  createSplitNodeRunner,
  type SplitProgress,
  type SplitRunDeps,
} from '../../../src/app/canvas/split-node-run.ts';
import { AI_CHAT_CONFIG_INITIAL } from '../../../src/features/ai/ai-chat-store.ts';
import type { SplitRerunConfirmSignal } from '../../../src/core/canvas/split-rerun-contract.ts';

const SPLIT = { id: 's1', type: 'split', x: 0, y: 0, w: 176, h: 96 };

function docNode(id: string, docPath: string, label: string) {
  return { id, type: 'document', docPath, label };
}

function edge(from: string, to: string) {
  return { from: { nodeId: from }, to: { nodeId: to } };
}

interface Recorder {
  readonly notices: { message: string; tone: string; signal?: SplitRerunConfirmSignal }[];
  readonly flashes: { nodeId: string; kind: string }[];
  readonly batches: CanvasCommand[][];
  readonly progress: SplitProgress[];
  readonly layoutExcludes: (readonly string[])[];
  streams: number;
  sequence: number;
}

function recorder(): Recorder {
  return {
    notices: [],
    flashes: [],
    batches: [],
    progress: [],
    layoutExcludes: [],
    streams: 0,
    sequence: 0,
  };
}

function deps(rec: Recorder, overrides: Partial<SplitRunDeps> = {}): SplitRunDeps {
  return {
    getDocument: () => ({ nodes: [], edges: [] }),
    liveText: () => null,
    readSnapshot: () => Promise.resolve({ text: '', sha256: 'sha' }),
    aiConfig: { ...AI_CHAT_CONFIG_INITIAL, model: 'test-model' },
    stream: () => Promise.resolve(),
    cancel: () => undefined,
    notice: (message, tone, signal) => rec.notices.push({ message, tone, signal }),
    executeCommands: (commands) => {
      rec.batches.push([...commands]);
      return true;
    },
    createNodeId: () => `n${++rec.sequence}`,
    createEdgeId: () => `e${++rec.sequence}`,
    occupiedRects: (excludeNodeIds) => {
      rec.layoutExcludes.push(excludeNodeIds);
      return [];
    },
    progress: (value) => rec.progress.push(value),
    flash: (nodeId, kind) => rec.flashes.push({ nodeId, kind }),
    ...overrides,
  };
}

void test('纯布局：从右侧竖排，避开已有节点', () => {
  const positions = layoutChunkNodes(
    { x: 0, y: 0, w: 176, h: 96 },
    3,
    [{ x: 256, y: 0, w: 160, h: 96 }],
  );
  assert.equal(positions.length, 3);
  assert.deepEqual(positions[0], { x: 256, y: 120 });
  assert.deepEqual(positions[1], { x: 256, y: 240 });
  assert.ok((positions[2]?.y ?? 0) >= 240);
});

void test('split 模式：按预算批量落块，不调用模型', async () => {
  const rec = recorder();
  let started = 0;
  const runner = createSplitNodeRunner(
    deps(rec, {
      getDocument: () => ({
        nodes: [{ ...SPLIT, chunkChars: 500 }, docNode('d1', 'a.md', 'A')],
        edges: [edge('d1', 's1')],
      }),
      readSnapshot: () => Promise.resolve({ text: 'x'.repeat(4_990), sha256: 's' }),
      stream: () => {
        started += 1;
        return Promise.resolve();
      },
    }),
  );

  await runner.start('s1');
  assert.equal(started, 0, 'split 模式不调用模型');
  assert.equal(rec.batches.length, 1);
  const batch = rec.batches[0] ?? [];
  assert.equal(batch.filter((command) => command.kind === 'addNode').length, 10);
  assert.equal(batch.filter((command) => command.kind === 'addEdge').length, 10);
  assert.deepEqual(rec.progress.at(-1), { phase: 'split', done: 10, total: 10 });
  assert.deepEqual(rec.flashes, [{ nodeId: 's1', kind: 'ok' }]);
});

void test('split 子块只带 chunkIndex/sourceNodeId，不含 offset/length 或编辑态字段', async () => {
  const rec = recorder();
  const runner = createSplitNodeRunner(
    deps(rec, {
      getDocument: () => ({
        nodes: [{ ...SPLIT, chunkChars: 500 }, docNode('d1', 'a.md', 'A')],
        edges: [edge('d1', 's1')],
      }),
      readSnapshot: () => Promise.resolve({ text: 'x'.repeat(900), sha256: 's' }),
    }),
  );

  await runner.start('s1');
  const created = (rec.batches[0] ?? [])
    .filter((command): command is Extract<CanvasCommand, { kind: 'addNode' }> => command.kind === 'addNode')
    .map((command) => command.node);
  assert.ok(created.length >= 2);
  for (const [index, node] of created.entries()) {
    const raw = node as Readonly<Record<string, unknown>>;
    assert.equal(raw.chunkIndex, index);
    assert.equal(raw.sourceNodeId, 's1');
    for (const forbidden of ['offset', 'length', 'edited', 'isLocked', 'editState']) {
      assert.equal(forbidden in raw, false, `子块不得携带 ${forbidden}`);
    }
  }
});

void test('已有子块：未确认时拒绝重跑', async () => {
  const rec = recorder();
  const runner = createSplitNodeRunner(
    deps(rec, {
      getDocument: () => ({
        nodes: [SPLIT, docNode('d1', 'a.md', 'A'), { id: 'c1', type: 'text' }],
        edges: [edge('d1', 's1'), edge('s1', 'c1')],
      }),
      readSnapshot: () => Promise.resolve({ text: 'x'.repeat(20), sha256: 's' }),
    }),
  );

  await runner.start('s1');
  assert.equal(rec.batches.length, 0);
  assert.match(rec.notices[0]?.message ?? '', /已有 1 个块/);
});

void test('已有子块：确认后先删旧块再建新块', async () => {
  const rec = recorder();
  const runner = createSplitNodeRunner(
    deps(rec, {
      getDocument: () => ({
        nodes: [SPLIT, docNode('d1', 'a.md', 'A'), { id: 'c1', type: 'text' }],
        edges: [edge('d1', 's1'), edge('s1', 'c1')],
      }),
      readSnapshot: () => Promise.resolve({ text: 'x'.repeat(20), sha256: 's' }),
    }),
  );

  await runner.start('s1', { replace: true });
  assert.equal(rec.layoutExcludes[0]?.join(','), 'c1');
  assert.equal(rec.batches[0]?.[0]?.kind, 'removeNode');
});

void test('未编辑且无下游连线：重跑不要求确认，直接整批覆盖', async () => {
  const rec = recorder();
  const text = 'x'.repeat(20);
  const full = `【文章 1：A】 ${text}`;
  const chunk = splitTextByBudget(full, 500)[0];
  const blockText = full.slice(chunk?.start ?? 0, chunk?.end ?? full.length);
  const runner = createSplitNodeRunner(
    deps(rec, {
      getDocument: () => ({
        nodes: [SPLIT, docNode('d1', 'a.md', 'A'), { id: 'c1', type: 'text', label: blockText, chunkIndex: 0, sourceNodeId: 's1' }],
        edges: [edge('d1', 's1'), edge('s1', 'c1')],
      }),
      readSnapshot: () => Promise.resolve({ text, sha256: 's' }),
    }),
  );

  await runner.start('s1');
  assert.equal(rec.batches.length, 1);
  assert.equal(rec.batches[0]?.[0]?.kind, 'removeNode');
  assert.equal(rec.notices.some((notice) => notice.tone === 'warning'), false);
});

void test('块被编辑：未确认时拒绝重跑，文案说明会覆盖已编辑块', async () => {
  const rec = recorder();
  const runner = createSplitNodeRunner(
    deps(rec, {
      getDocument: () => ({
        nodes: [SPLIT, docNode('d1', 'a.md', 'A'), { id: 'c1', type: 'text', label: '我改过', chunkIndex: 0, sourceNodeId: 's1' }],
        edges: [edge('d1', 's1'), edge('s1', 'c1')],
      }),
      readSnapshot: () => Promise.resolve({ text: 'x'.repeat(20), sha256: 's' }),
    }),
  );

  await runner.start('s1');
  assert.equal(rec.batches.length, 0);
  assert.match(rec.notices[0]?.message ?? '', /块内容与重新切分结果不同/);
});

void test('块有下游连线：未确认时拒绝重跑，确认后整批覆盖', async () => {
  const rec = recorder();
  const text = 'x'.repeat(20);
  const full = `【文章 1：A】 ${text}`;
  const chunk = splitTextByBudget(full, 500)[0];
  const blockText = full.slice(chunk?.start ?? 0, chunk?.end ?? full.length);
  const runner = createSplitNodeRunner(
    deps(rec, {
      getDocument: () => ({
        nodes: [SPLIT, docNode('d1', 'a.md', 'A'), { id: 'c1', type: 'text', label: blockText, chunkIndex: 0, sourceNodeId: 's1' }, { id: 'o1', type: 'text' }],
        edges: [edge('d1', 's1'), edge('s1', 'c1'), edge('c1', 'o1')],
      }),
      readSnapshot: () => Promise.resolve({ text, sha256: 's' }),
    }),
  );

  await runner.start('s1');
  assert.equal(rec.batches.length, 0);
  assert.match(rec.notices[0]?.message ?? '', /下游连线/);

  await runner.start('s1', { replace: true });
  assert.equal(rec.batches.length, 1);
  assert.equal(rec.batches[0]?.[0]?.kind, 'removeNode');
});

void test('覆盖重跑：旧块由 removeNode 清理，下游出边不被重新接线', async () => {
  const rec = recorder();
  const text = 'x'.repeat(20);
  const full = `【文章 1：A】 ${text}`;
  const chunk = splitTextByBudget(full, 500)[0];
  const blockText = full.slice(chunk?.start ?? 0, chunk?.end ?? full.length);
  const runner = createSplitNodeRunner(
    deps(rec, {
      getDocument: () => ({
        nodes: [
          SPLIT,
          docNode('d1', 'a.md', 'A'),
          { id: 'c1', type: 'text', label: blockText, chunkIndex: 0, sourceNodeId: 's1' },
          { id: 'o1', type: 'text', label: '下游' },
        ],
        edges: [edge('d1', 's1'), edge('s1', 'c1'), edge('c1', 'o1')],
      }),
      readSnapshot: () => Promise.resolve({ text, sha256: 's' }),
    }),
  );

  await runner.start('s1', { replace: true });
  const batch = rec.batches[0] ?? [];
  const removed = batch
    .filter((command): command is Extract<CanvasCommand, { kind: 'removeNode' }> => command.kind === 'removeNode')
    .map((command) => command.id);
  assert.deepEqual(removed, ['c1'], '旧块整批删除');
  const addEdges = batch.filter(
    (command): command is Extract<CanvasCommand, { kind: 'addEdge' }> => command.kind === 'addEdge',
  );
  assert.ok(addEdges.length > 0);
  assert.ok(
    addEdges.every((command) => command.edge.from.nodeId === 's1'),
    '只重建 split → 新块，不接回旧下游',
  );
  assert.ok(
    addEdges.every((command) => command.edge.to.nodeId !== 'o1'),
    '旧块下游出边未被重新接线',
  );
});

void test('refine 模式：逐块提炼后一次性写回，只占一条历史', async () => {
  const rec = recorder();
  let calls = 0;
  const runner = createSplitNodeRunner(
    deps(rec, {
      getDocument: () => ({
        nodes: [{ ...SPLIT, mode: 'refine', chunkChars: 500 }, docNode('d1', 'a.md', 'A')],
        edges: [edge('d1', 's1')],
      }),
      readSnapshot: () => Promise.resolve({ text: 'a'.repeat(1_490), sha256: 's' }),
      stream: (_request, handlers) => {
        calls += 1;
        handlers.onDelta(`提炼${calls}`);
        handlers.onDone();
        return Promise.resolve();
      },
    }),
  );

  await runner.start('s1');
  assert.equal(calls, 3);
  assert.equal(rec.batches.length, 1, '整批切分+提炼只占一条历史');
  const writes = (rec.batches[0] ?? []).filter(
    (command): command is Extract<CanvasCommand, { kind: 'addNode' }> => command.kind === 'addNode',
  );
  assert.deepEqual(writes.map((command) => command.node.label), ['提炼1', '提炼2', '提炼3']);
  assert.equal(writes.length, 3);
  assert.deepEqual(rec.flashes, [{ nodeId: 's1', kind: 'ok' }]);
});

void test('refine 单块失败：继续其余块，保留原始块并提示', async () => {
  const rec = recorder();
  let calls = 0;
  const runner = createSplitNodeRunner(
    deps(rec, {
      getDocument: () => ({
        nodes: [{ ...SPLIT, mode: 'refine', chunkChars: 500 }, docNode('d1', 'a.md', 'A')],
        edges: [edge('d1', 's1')],
      }),
      readSnapshot: () => Promise.resolve({ text: 'a'.repeat(1_490), sha256: 's' }),
      stream: (_request, handlers) => {
        calls += 1;
        if (calls === 2) {
          handlers.onError('E_AI_NETWORK', '网络中断');
        } else {
          handlers.onDelta(`块${calls}`);
          handlers.onDone();
        }
        return Promise.resolve();
      },
    }),
  );

  await runner.start('s1');
  assert.equal(calls, 3, '失败后继续后续块');
  assert.equal(rec.batches.length, 1, '整批只提交一次');
  const full = `【文章 1：A】 ${'a'.repeat(1_490)}`;
  const expectedRaw = splitTextByBudget(full, 500).map((chunk) =>
    full.slice(chunk.start, chunk.end),
  );
  const writes = (rec.batches[0] ?? []).filter(
    (command): command is Extract<CanvasCommand, { kind: 'addNode' }> => command.kind === 'addNode',
  );
  assert.equal(writes.length, 3);
  assert.deepEqual(writes.map((command) => command.node.label), ['块1', expectedRaw[1], '块3']);
  assert.match(rec.notices.at(-1)?.message ?? '', /1 块提炼失败/);
  assert.equal(rec.flashes.at(-1)?.nodeId, 's1');
  assert.equal(rec.flashes.at(-1)?.kind, 'error');
  assert.equal(rec.flashes.length, 2, '失败块与分块节点各一次错误态');
});

void test('单块重试：只更新该块，成功一条历史，失败零改动', async () => {
  const success = recorder();
  const okRunner = createSplitNodeRunner(
    deps(success, {
      getDocument: () => ({
        nodes: [SPLIT, { id: 'b1', type: 'text', label: '待提炼的块', chunkIndex: 0, sourceNodeId: 's1' }],
        edges: [edge('s1', 'b1')],
      }),
      stream: (_request, handlers) => {
        handlers.onDelta('提炼结果');
        handlers.onDone();
        return Promise.resolve();
      },
    }),
  );
  await okRunner.retryBlock('b1');
  assert.deepEqual(success.batches, [
    [{ kind: 'updateNode', id: 'b1', changes: { label: '提炼结果' } }],
  ]);
  assert.deepEqual(success.flashes, [{ nodeId: 'b1', kind: 'ok' }]);

  const failure = recorder();
  const badRunner = createSplitNodeRunner(
    deps(failure, {
      getDocument: () => ({
        nodes: [SPLIT, { id: 'b1', type: 'text', label: '待提炼的块', chunkIndex: 0, sourceNodeId: 's1' }],
        edges: [edge('s1', 'b1')],
      }),
      stream: (_request, handlers) => {
        handlers.onError('E_AI_NETWORK', '网络中断');
        return Promise.resolve();
      },
    }),
  );
  await badRunner.retryBlock('b1');
  assert.equal(failure.batches.length, 0, '失败不产生历史');
  assert.deepEqual(failure.flashes, [{ nodeId: 'b1', kind: 'error' }]);
});

void test('取消：整批回滚，不落块也不新增历史', async () => {
  const rec = recorder();
  let finish: () => void = () => undefined;
  let batchesDuringStream = -1;
  const runner = createSplitNodeRunner(
    deps(rec, {
      getDocument: () => ({
        nodes: [{ ...SPLIT, mode: 'refine', chunkChars: 500 }, docNode('d1', 'a.md', 'A')],
        edges: [edge('d1', 's1')],
      }),
      readSnapshot: () => Promise.resolve({ text: 'a'.repeat(1_490), sha256: 's' }),
      stream: () => {
        batchesDuringStream = rec.batches.length;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    }),
  );

  const started = runner.start('s1');
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(batchesDuringStream, 0, 'refine 运行期画布上没有块');
  runner.cancel();
  finish();
  await started;

  assert.equal(rec.batches.length, 0, '取消后没有创建/写回批次');
  assert.equal(rec.flashes.length, 0);
  assert.match(rec.notices.at(-1)?.message ?? '', /未写入任何块/);
});

void test('S1：孤儿块按 sourceNodeId 识别，重跑覆盖而不是新增重复块', async () => {
  const rec = recorder();
  const text = 'x'.repeat(20);
  const orphan = { id: 'c1', type: 'text', label: '旧孤儿', chunkIndex: 0, sourceNodeId: 's1' };
  const doc = {
    nodes: [
      SPLIT,
      { id: 'd1', type: 'document', docPath: 'a.md', label: 'A' },
      orphan,
    ],
    // 出边已被手动删除，只剩文档 → split。
    edges: [edge('d1', 's1')],
  };
  const runner = createSplitNodeRunner(
    deps(rec, {
      getDocument: () => doc,
      readSnapshot: () => Promise.resolve({ text, sha256: 's' }),
    }),
  );

  await runner.start('s1');
  assert.equal(rec.batches.length, 0);
  assert.equal(rec.notices[0]?.signal?.existingBlockCount, 1, '孤儿块仍被识别为旧子块');

  await runner.start('s1', { replace: true });
  assert.equal(rec.batches.length, 1);
  const batch = rec.batches[0] ?? [];
  assert.equal(
    batch.some((command) => command.kind === 'removeNode' && command.id === 'c1'),
    true,
    '旧孤儿在覆盖批次中被移除',
  );
});

void test('S1：无 sourceNodeId 的旧块仍能通过出边识别', async () => {
  const rec = recorder();
  const text = 'x'.repeat(20);
  const legacy = { id: 'c1', type: 'text', label: '旧块', chunkIndex: 0 };
  const doc = {
    nodes: [SPLIT, docNode('d1', 'a.md', 'A'), legacy],
    edges: [edge('d1', 's1'), edge('s1', 'c1')],
  };
  const runner = createSplitNodeRunner(
    deps(rec, {
      getDocument: () => doc,
      readSnapshot: () => Promise.resolve({ text, sha256: 's' }),
    }),
  );

  await runner.start('s1');
  assert.equal(rec.notices[0]?.signal?.existingBlockCount, 1, '出边旧块被识别');

  await runner.start('s1', { replace: true });
  const removed = (rec.batches[0] ?? [])
    .filter((command) => command.kind === 'removeNode')
    .map((command) => command.id);
  assert.deepEqual(removed, ['c1']);
});

void test('S1：混合场景 A（sourceNodeId）+ B（仅出边）都被识别并覆盖', async () => {
  const rec = recorder();
  const text = 'x'.repeat(20);
  const doc = {
    nodes: [
      SPLIT,
      docNode('d1', 'a.md', 'A'),
      { id: 'a1', type: 'text', label: 'A 孤儿', chunkIndex: 0, sourceNodeId: 's1' },
      { id: 'b1', type: 'text', label: 'B 仅出边', chunkIndex: 1 },
    ],
    edges: [edge('d1', 's1'), edge('s1', 'b1')],
  };
  const runner = createSplitNodeRunner(
    deps(rec, {
      getDocument: () => doc,
      readSnapshot: () => Promise.resolve({ text, sha256: 's' }),
    }),
  );

  await runner.start('s1');
  assert.equal(rec.notices[0]?.signal?.existingBlockCount, 2, 'A + B 都算旧块');

  await runner.start('s1', { replace: true });
  const removed = (rec.batches[0] ?? [])
    .filter((command) => command.kind === 'removeNode')
    .map((command) => command.id);
  assert.deepEqual(removed.sort(), ['a1', 'b1']);
});