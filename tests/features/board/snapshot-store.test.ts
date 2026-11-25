/**
 * CR-20261123-69 / S3：看板快照与环比。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  averageScore,
  createBoardSnapshot,
  loadSnapshots,
  previousSnapshot,
  recordSnapshot,
  snapshotDate,
  type BoardSnapshot,
  type SnapshotsStorage,
} from '../../../src/features/board/snapshot-store.ts';
import { buildBoardMetrics, parseDocStat } from '../../../src/features/board/model.ts';

function memoryStorage(initial: Record<string, string> = {}): SnapshotsStorage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

function snapshotAt(generatedAt: number): BoardSnapshot {
  const now = generatedAt;
  const docs = [parseDocStat({ path: 'a.md', sha256: 's', bytes: 2, modifiedMs: now, text: 'a' })];
  return createBoardSnapshot(buildBoardMetrics(docs, new Map(), { now }), now);
}

void test('快照日期为本地 YYYY-MM-DD', () => {
  assert.equal(snapshotDate(new Date(2026, 10, 23, 23, 59).getTime()), '2026-11-23');
  assert.equal(snapshotDate(new Date(2026, 10, 24, 0, 1).getTime()), '2026-11-24');
});

void test('createBoardSnapshot 写入八维得分与总数', () => {
  const now = new Date(2026, 10, 23, 12).getTime();
  const docs = [
    parseDocStat({ path: 'a.md', sha256: 's1', bytes: 2, modifiedMs: now, text: 'a' }),
    parseDocStat({ path: 'b.md', sha256: 's2', bytes: 2, modifiedMs: now, text: 'b' }),
  ];
  const metrics = buildBoardMetrics(
    docs,
    new Map([['a.md', ['factual']], ['b.md', ['tacit']]]),
    { now, links: [{ from: 'a.md', to: 'b.md' }] },
  );
  const snapshot = createBoardSnapshot(metrics, now);
  assert.equal(snapshot.docs, 2);
  assert.equal(snapshot.links, 1);
  assert.equal(snapshot.unclassified, 0);
  assert.equal(snapshot.date, '2026-11-23');
  assert.equal(snapshot.scores.factual, metrics.dimensions[0]?.score);
  assert.ok(averageScore(snapshot) > 0);
});

void test('追加排序、只保留最近 N 份、读取往返', () => {
  const storage = memoryStorage();
  recordSnapshot(storage, 'v', snapshotAt(3000));
  recordSnapshot(storage, 'v', snapshotAt(1000));
  const list = recordSnapshot(storage, 'v', snapshotAt(2000));
  assert.deepEqual(list.map((item) => item.generatedAt), [1000, 2000, 3000]);
  assert.deepEqual(
    loadSnapshots(storage, 'v').map((item) => item.generatedAt),
    [1000, 2000, 3000],
  );

  const pruned = recordSnapshot(storage, 'v', snapshotAt(4000), 2);
  assert.deepEqual(pruned.map((item) => item.generatedAt), [3000, 4000]);
});

void test('previousSnapshot 取严格更早的最新一份；首次为 null', () => {
  const snapshots = [snapshotAt(1000), snapshotAt(2000), snapshotAt(3000)];
  assert.equal(previousSnapshot([], 5000), null);
  assert.equal(previousSnapshot(snapshots, 500), null);
  assert.equal(previousSnapshot(snapshots, 3000)?.generatedAt, 2000);
  assert.equal(previousSnapshot(snapshots, 9000)?.generatedAt, 3000);
});

void test('损坏 / 版本不符 / 单条无效 → 丢弃，不抛错', () => {
  assert.deepEqual(loadSnapshots(memoryStorage(), 'v'), []);
  assert.deepEqual(loadSnapshots(memoryStorage({ 'ember2:board:snapshots:v1:v': '{x' }), 'v'), []);
  assert.deepEqual(
    loadSnapshots(
      memoryStorage({
        'ember2:board:snapshots:v1:v': JSON.stringify({ version: 2, items: [] }),
      }),
      'v',
    ),
    [],
  );

  const invalidItem = { generatedAt: 1, date: '2026-01-01' };
  const loaded = loadSnapshots(
    memoryStorage({
      'ember2:board:snapshots:v1:v': JSON.stringify({ version: 1, items: [invalidItem] }),
    }),
    'v',
  );
  assert.deepEqual(loaded, []);
});

void test('写入失败不影响内存返回值', () => {
  const failing: SnapshotsStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error('quota');
    },
  };
  const list = recordSnapshot(failing, 'v', snapshotAt(1000));
  assert.equal(list.length, 1);
});
