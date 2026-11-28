/**
 * M4：split 块数预览投影的三态、失效与过期结果丢弃。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSplitPreviewProjection,
  type SplitPreviewDeps,
} from '../../../src/app/canvas/use-split-previews.ts';
import {
  SPLIT_MAX_TOTAL_CHARS,
} from '../../../src/app/canvas/split-node-execution.ts';
import type { SplitPreview } from '../../../src/app/canvas/split-preview.ts';
import type { AiProvider } from '../../../src/features/ai/ai-endpoint.ts';

interface DocShape {
  nodes: readonly unknown[];
  edges: readonly unknown[];
}

const SPLIT = { id: 's1', type: 'split' };
const DOC = { id: 'd1', type: 'document', docPath: 'a.md', label: 'A' };
const EDGE = { from: { nodeId: 'd1' }, to: { nodeId: 's1' } };

function documentWith(
  nodes: readonly unknown[] = [SPLIT, DOC],
  edges: readonly unknown[] = [EDGE],
): DocShape {
  return { nodes, edges };
}

function setup(overrides: Partial<SplitPreviewDeps> = {}) {
  const published: (ReadonlyMap<string, SplitPreview>)[] = [];
  let document = documentWith();
  let provider: AiProvider = 'openai-compatible';
  const reads: string[] = [];
  const live = new Map<string, string>([['a.md', 'x'.repeat(20_000)]]);
  const deps: SplitPreviewDeps = {
    getDocument: () => document,
    readLiveText: (path) => live.get(path) ?? null,
    readSnapshot: (path) => {
      reads.push(path);
      return Promise.resolve(live.get(path) ?? '');
    },
    getProvider: () => provider,
    publish: (previews) => published.push(previews),
    debounceMs: 0,
    ...overrides,
  };
  const projection = createSplitPreviewProjection(deps);
  return {
    projection,
    published,
    reads,
    live,
    setDocument: (next: DocShape) => {
      document = next;
    },
    setProvider: (next: AiProvider) => {
      provider = next;
    },
    last: (): SplitPreview | undefined => published.at(-1)?.get('s1'),
  };
}

void test('读取成功：预览为精确块数', async () => {
  const { projection, last } = setup();
  await projection.refresh({ force: true });
  assert.deepEqual(last(), { kind: 'count', count: 1 });
});

void test('读取失败：块数待计算', async () => {
  const { projection, last } = setup({
    readLiveText: () => null,
    readSnapshot: () => Promise.reject(new Error('读取失败')),
  });
  await projection.refresh({ force: true });
  assert.deepEqual(last(), { kind: 'pending' });
});

void test('超过 SPLIT_MAX_TOTAL_CHARS：素材过长', async () => {
  const big = 'x'.repeat(SPLIT_MAX_TOTAL_CHARS + 10);
  const { projection, last } = setup({
    readLiveText: () => big,
  });
  await projection.refresh({ force: true });
  assert.deepEqual(last(), { kind: 'too-long' });
});

void test('没有上游文档：块数待计算', async () => {
  const { projection, last, setDocument } = setup();
  setDocument({ nodes: [SPLIT], edges: [] });
  await projection.refresh({ force: true });
  assert.deepEqual(last(), { kind: 'pending' });
});

void test('provider 变化导致 clampChunkChars 变化时重算', async () => {
  const { projection, last, setProvider } = setup();
  setProvider('openai-compatible-local');
  await projection.refresh({ force: true });
  assert.deepEqual(last(), { kind: 'count', count: 3 });

  setProvider('openai-compatible');
  await projection.refresh({ force: true });
  assert.deepEqual(last(), { kind: 'count', count: 1 });
});

void test('上游 docPath 变化时按新正文重算', async () => {
  const { projection, last, live, setDocument } = setup();
  live.set('a.md', 'x'.repeat(120_000));
  await projection.refresh({ force: true });
  assert.deepEqual(last(), { kind: 'count', count: 3 });

  live.set('b.md', 'y'.repeat(1_000));
  setDocument(
    documentWith(
      [SPLIT, { ...DOC, docPath: 'b.md' }],
      [EDGE],
    ),
  );
  await projection.refresh();
  assert.deepEqual(last(), { kind: 'count', count: 1 });
});

void test('仅坐标变化：结构签名不变，跳过正文读取', async () => {
  const { projection, reads, setDocument } = setup();
  await projection.refresh({ force: true });
  const callsAfterFirst = reads.length;

  setDocument({
    nodes: [SPLIT, { ...DOC, x: 999, y: 999 }],
    edges: [EDGE],
  });
  await projection.refresh();
  assert.equal(reads.length, callsAfterFirst, '结构未变不应重复读取');
});

void test('切换 mode 不改变块数，也不重读正文', async () => {
  const { projection, reads, last, setDocument } = setup({
    readLiveText: () => null,
    readSnapshot: () => Promise.resolve('x'.repeat(20_000)),
  });
  await projection.refresh({ force: true });
  assert.deepEqual(last(), { kind: 'count', count: 1 });
  const callsAfterFirst = reads.length;

  setDocument({
    nodes: [{ ...SPLIT, mode: 'refine' }, DOC],
    edges: [EDGE],
  });
  await projection.refresh();
  assert.equal(reads.length, callsAfterFirst, 'mode 不在签名内，不应重读');
  assert.deepEqual(last(), { kind: 'count', count: 1 }, '块数与 mode 无关');
});

void test('过期结果不得覆盖后一轮预览', async () => {
  const pending: ((value: string) => void)[] = [];
  const { projection, last } = setup({
    readLiveText: () => null,
    readSnapshot: () =>
      new Promise<string>((resolve) => {
        pending.push(resolve);
      }),
  });

  const first = projection.refresh({ force: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = projection.refresh({ force: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(pending.length, 2, '两轮都发起了读取');

  pending[1]?.('y'.repeat(120_000));
  await second;
  assert.deepEqual(last(), { kind: 'count', count: 3 });

  pending[0]?.('x'.repeat(1_000));
  await first;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(last(), { kind: 'count', count: 3 }, '旧结果被丢弃');
});