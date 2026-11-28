/**
 * M4：共享切分函数与 runner 块数口径一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { CanvasCommand } from '#canvas-format';
import { splitTextByBudget } from '../../../src/core/chunk-text.ts';
import { clampChunkChars } from '../../../src/features/ai/model-budget.ts';
import { AI_CHAT_CONFIG_INITIAL } from '../../../src/features/ai/ai-chat-store.ts';
import {
  buildSplitFullText,
  computeSplitChunkCount,
} from '../../../src/app/canvas/split-preview.ts';
import { createSplitNodeRunner, type SplitRunDeps } from '../../../src/app/canvas/split-node-run.ts';

const SPLIT = { id: 's1', type: 'split', x: 0, y: 0, w: 176, h: 96 };
const DOC_A = { id: 'd1', type: 'document', docPath: 'a.md', label: 'A' };
const DOC_B = { id: 'd2', type: 'document', docPath: 'b.md', label: 'B' };

function edge(from: string, to: string) {
  return { from: { nodeId: from }, to: { nodeId: to } };
}

function recorder() {
  const state = {
    notices: [] as { message: string; tone: string }[],
    batches: [] as CanvasCommand[][],
    sequence: 0,
  };
  const deps = (overrides: Partial<SplitRunDeps> = {}): SplitRunDeps => ({
    getDocument: () => ({ nodes: [], edges: [] }),
    liveText: () => null,
    readSnapshot: () => Promise.resolve({ text: '', sha256: 'sha' }),
    aiConfig: { ...AI_CHAT_CONFIG_INITIAL, provider: 'openai-compatible', model: 'test-model' },
    stream: () => Promise.resolve(),
    cancel: () => undefined,
    notice: (message, tone) => state.notices.push({ message, tone }),
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

void test('buildSplitFullText 与 runner 历史格式逐字一致', () => {
  const docs = [
    { nodeId: 'd1', docPath: 'a.md', label: 'A' },
    { nodeId: 'd2', docPath: 'b.md', label: 'B' },
  ];
  assert.equal(
    buildSplitFullText(docs, ['甲', '乙']),
    '【文章 1：A】 甲\n\n【文章 2：B】 乙',
  );
  assert.equal(
    buildSplitFullText(docs, ['甲', null]),
    '【文章 1：A】 甲\n\n【文章 2：B】 ',
  );
});

void test('computeSplitChunkCount 等于执行层 clamp + splitTextByBudget 的块数', () => {
  const fullText = 'x'.repeat(1200) + '\n\n' + 'y'.repeat(900);
  for (const chunkChars of [undefined, 500, 4000]) {
    const expected = splitTextByBudget(
      fullText,
      clampChunkChars(chunkChars, 'openai-compatible'),
    ).length;
    assert.equal(
      computeSplitChunkCount(fullText, chunkChars, 'openai-compatible'),
      expected,
      `chunkChars=${String(chunkChars)}`,
    );
  }
});

void test('runner 实际落块数与共享函数一致', async () => {
  const { state, deps } = recorder();
  const texts = new Map([
    ['a.md', 'x'.repeat(1200)],
    ['b.md', 'y'.repeat(900)],
  ]);
  const docs = [
    { nodeId: 'd1', docPath: 'a.md', label: 'A' },
    { nodeId: 'd2', docPath: 'b.md', label: 'B' },
  ];
  const fullText = buildSplitFullText(docs, [texts.get('a.md') ?? '', texts.get('b.md') ?? '']);
  const expected = computeSplitChunkCount(fullText, 500, 'openai-compatible');
  const runner = createSplitNodeRunner(
    deps({
      getDocument: () => ({
        nodes: [
          { ...SPLIT, chunkChars: 500 },
          DOC_A,
          DOC_B,
        ],
        edges: [edge('d1', 's1'), edge('d2', 's1')],
      }),
      liveText: (path) => texts.get(path) ?? null,
    }),
  );

  await runner.start('s1');
  const created = (state.batches[0] ?? []).filter((command) => command.kind === 'addNode').length;
  assert.equal(created, expected, '新切分块数 === 共享函数结果');
  assert.match(
    state.notices.at(-1)?.message ?? '',
    new RegExp(`已切分为 ${expected} 块`),
  );
});