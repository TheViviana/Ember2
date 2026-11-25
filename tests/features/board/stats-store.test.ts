/**
 * CR-20261123-69 / S1：T1 正文统计构建器（并发 / 取消 / 缓存 / 跳过 / 失败）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_STAT_BYTES } from '../../../src/features/board/model.ts';
import {
  buildBoardStats,
  invalidateStatsCache,
  statsStorageKey,
  type BoardStatsReader,
  type BoardStatsTarget,
  type StatsStorage,
} from '../../../src/features/board/stats-store.ts';

function memoryStorage(initial: Record<string, string> = {}): StatsStorage & {
  readonly data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

function target(index: number, overrides: Partial<BoardStatsTarget> = {}): BoardStatsTarget {
  return {
    path: `d${index}.md`,
    sha256: `sha-${index}`,
    bytes: 20,
    modifiedMs: 1000 + index,
    ...overrides,
  };
}

function shaOf(path: string): string {
  return `sha-${path.replace(/^d/, '').replace(/\.md$/, '')}`;
}

void test('并发受控且结果保持输入顺序', async () => {
  const docs = Array.from({ length: 8 }, (_, index) => target(index));
  let inFlight = 0;
  let maxInFlight = 0;
  const delays = [6, 5, 4, 3, 2, 1, 0, 0];
  const read: BoardStatsReader = async (path) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const index = Number(path.slice(1, -3));
    await new Promise((resolve) => setTimeout(resolve, delays[index] ?? 0));
    inFlight -= 1;
    return { sha256: shaOf(path), text: `---\ntitle: ${path}\n---\n正文` };
  };

  const result = await buildBoardStats({ docs, read, concurrency: 3 });
  assert.equal(result.cancelled, false);
  assert.equal(result.failures.length, 0);
  assert.ok(maxInFlight <= 3, `并发上限 3，实际 ${maxInFlight}`);
  assert.ok(maxInFlight >= 2, '应真正并行');
  assert.deepEqual(
    result.stats.map((stat) => stat.path),
    docs.map((doc) => doc.path),
    '完成顺序不影响输出顺序',
  );
});

void test('缓存命中不重读；失效后只重读对应文档；sha 变化重读', async () => {
  const docs = [target(1), target(2), target(3)];
  const storage = memoryStorage();
  let calls = 0;
  const read: BoardStatsReader = (path) => {
    calls += 1;
    return Promise.resolve({ sha256: shaOf(path), text: `---\ntitle: ${path}\n---\n正文` });
  };

  const first = await buildBoardStats({ docs, read, storage, vaultId: 'v' });
  assert.equal(calls, 3);
  assert.equal(first.stats.length, 3);

  let done = 0;
  let fromCache = 0;
  const second = await buildBoardStats({
    docs,
    read,
    storage,
    vaultId: 'v',
    onProgress: (progress) => {
      done = progress.done;
      fromCache = progress.fromCache;
    },
  });
  assert.equal(calls, 3, '全部命中缓存');
  assert.equal(done, 3);
  assert.equal(fromCache, 3);
  assert.deepEqual(
    second.stats.map((stat) => stat.wordCount),
    first.stats.map((stat) => stat.wordCount),
  );

  invalidateStatsCache(storage, 'v', ['d2.md']);
  await buildBoardStats({ docs, read, storage, vaultId: 'v' });
  assert.equal(calls, 4, '只重读失效的 d2');

  const changed = [target(1, { sha256: 'sha-new' }), target(2), target(3)];
  await buildBoardStats({ docs: changed, read, storage, vaultId: 'v' });
  assert.equal(calls, 5, 'sha 变化必须重读');
});

void test('缓存损坏或缺失时静默重读', async () => {
  const storage = memoryStorage({ [statsStorageKey('v')]: '{broken' });
  let calls = 0;
  const read: BoardStatsReader = (path) => {
    calls += 1;
    return Promise.resolve({ sha256: shaOf(path), text: '正文' });
  };
  const result = await buildBoardStats({ docs: [target(1)], read, storage, vaultId: 'v' });
  assert.equal(calls, 1);
  assert.equal(result.stats[0]?.title, 'd1');
});

void test('超过 1 MiB 的文档不读取正文，只计入总数并标记跳过', async () => {
  const docs = [target(1, { bytes: MAX_STAT_BYTES + 1 })];
  let called = false;
  const read: BoardStatsReader = () => {
    called = true;
    return Promise.reject(new Error('不应读取'));
  };
  const storage = memoryStorage();

  const result = await buildBoardStats({ docs, read, storage, vaultId: 'v' });
  assert.equal(called, false);
  assert.equal(result.failures.length, 0);
  assert.equal(result.stats[0]?.skipped, true);
  assert.equal(result.stats[0]?.wordCount, 0);
  assert.equal(result.stats[0]?.title, 'd1');

  const cached = await buildBoardStats({ docs, read, storage, vaultId: 'v' });
  assert.equal(called, false, '跳过大文件也可缓存');
  assert.equal(cached.stats[0]?.skipped, true);
});

void test('单篇读取失败不阻断整批', async () => {
  const docs = [target(1), target(2), target(3)];
  const read: BoardStatsReader = (path) => {
    if (path === 'd2.md') return Promise.reject(new Error('disk error'));
    return Promise.resolve({ sha256: shaOf(path), text: '正文' });
  };
  let failed = 0;
  const result = await buildBoardStats({
    docs,
    read,
    onProgress: (progress) => {
      failed = progress.failed;
    },
  });
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.path, 'd2.md');
  assert.equal(result.failures[0]?.reason, 'disk error');
  assert.equal(failed, 1);
  assert.deepEqual(
    result.stats.map((stat) => stat.path),
    ['d1.md', 'd3.md'],
  );
});

void test('已取消信号：不读取、不产出', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const read: BoardStatsReader = (path) => {
    calls += 1;
    return Promise.resolve({ sha256: shaOf(path), text: '正文' });
  };
  const result = await buildBoardStats({
    docs: [target(1), target(2)],
    read,
    signal: controller.signal,
  });
  assert.equal(result.cancelled, true);
  assert.equal(calls, 0);
  assert.deepEqual(result.stats, []);
});

void test('读取途中取消：丢弃已返回结果并标记取消', async () => {
  const controller = new AbortController();
  const read: BoardStatsReader = (path) => {
    controller.abort();
    return Promise.resolve({ sha256: shaOf(path), text: '正文' });
  };
  const result = await buildBoardStats({
    docs: [target(1), target(2)],
    read: read,
    concurrency: 1,
    signal: controller.signal,
  });
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.stats, []);
});

void test('reader 抛 AbortError 视为取消而非失败', async () => {
  const controller = new AbortController();
  controller.abort();
  const read: BoardStatsReader = () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    return Promise.reject(error);
  };
  const result = await buildBoardStats({
    docs: [target(1)],
    read,
    signal: controller.signal,
    concurrency: 1,
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.failures.length, 0);
});
