/**
 * CR-20261123-69 / S1：八维分类旁路覆盖层。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_CLASSIFY_STORAGE_PREFIX,
  classificationNeedsReview,
  classifyStorageKey,
  loadClassifications,
  removeBoardClassification,
  saveClassifications,
  setBoardClassification,
  toDimensionLookup,
  type ClassifyStorage,
} from '../../../src/features/board/classify-store.ts';

function memoryStorage(initial: Record<string, string> = {}): ClassifyStorage & {
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

void test('存储键按库隔离', () => {
  assert.equal(classifyStorageKey('vault-a'), `${BOARD_CLASSIFY_STORAGE_PREFIX}vault-a`);
  assert.notEqual(classifyStorageKey('vault-a'), classifyStorageKey('vault-b'));
});

void test('保存 → 读取往返；维度按固定顺序归一', () => {
  const storage = memoryStorage();
  let map = setBoardClassification(new Map(), 'a.md', 'sha-a', ['value', 'factual'], 100);
  assert.equal(saveClassifications(storage, 'vault-a', map), null);

  const loaded = loadClassifications(storage, 'vault-a');
  assert.equal(loaded.warning, null);
  assert.deepEqual(loaded.map.get('a.md')?.dimensions, ['factual', 'value']);
  assert.equal(loaded.map.get('a.md')?.sha256, 'sha-a');
  assert.equal(loaded.map.get('a.md')?.updatedAt, 100);

  map = setBoardClassification(map, 'a.md', 'sha-a2', ['conceptual'], 200);
  saveClassifications(storage, 'vault-a', map);
  const reloaded = loadClassifications(storage, 'vault-a');
  assert.deepEqual(reloaded.map.get('a.md')?.dimensions, ['conceptual']);
});

void test('空维度等于删除；remove 不存在的路径返回同一引用', () => {
  let map = setBoardClassification(new Map(), 'a.md', 'sha', ['tacit'], 1);
  map = setBoardClassification(map, 'a.md', 'sha', [], 2);
  assert.equal(map.has('a.md'), false);

  const empty = new Map();
  assert.equal(removeBoardClassification(empty, 'missing.md'), empty);
});

void test('sha 变化时保留维度但标记需复核', () => {
  const map = setBoardClassification(new Map(), 'a.md', 'old-sha', ['procedural'], 1);
  const entry = map.get('a.md');
  assert.ok(entry);
  assert.equal(classificationNeedsReview(entry, 'old-sha'), false);
  assert.equal(classificationNeedsReview(entry, 'new-sha'), true);
});

void test('损坏 / 版本不符 → 空表 + 提示', () => {
  assert.equal(loadClassifications(memoryStorage(), 'v').warning, null);

  const broken = memoryStorage({ [classifyStorageKey('v')]: '{not json' });
  assert.deepEqual([...loadClassifications(broken, 'v').map.keys()], []);
  assert.match(loadClassifications(broken, 'v').warning ?? '', /无法解析/);

  const wrongVersion = memoryStorage({
    [classifyStorageKey('v')]: JSON.stringify({ version: 2, items: {} }),
  });
  assert.match(loadClassifications(wrongVersion, 'v').warning ?? '', /格式无效/);
});

void test('单条无效记录被丢弃，其余保留并给出计数提示', () => {
  const storage = memoryStorage({
    [classifyStorageKey('v')]: JSON.stringify({
      version: 1,
      items: {
        'ok.md': { sha256: 'sha', dimensions: ['factual'], updatedAt: 1 },
        'empty.md': { sha256: 'sha', dimensions: [], updatedAt: 1 },
        'bad-dims.md': { sha256: 'sha', dimensions: 'factual', updatedAt: 1 },
        'bad-time.md': { sha256: 'sha', dimensions: ['tacit'], updatedAt: 'now' },
      },
    }),
  });
  const loaded = loadClassifications(storage, 'v');
  assert.deepEqual([...loaded.map.keys()], ['ok.md']);
  assert.match(loaded.warning ?? '', /3 条无效记录/);
});

void test('写入失败返回提示；读取抛错返回空表', () => {
  const failing: ClassifyStorage = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('quota');
    },
  };
  assert.match(loadClassifications(failing, 'v').warning ?? '', /读取失败/);
  assert.match(saveClassifications(failing, 'v', new Map()) ?? '', /保存失败/);
});

void test('toDimensionLookup 输出可注入 buildBoardMetrics 的查表', () => {
  const map = setBoardClassification(new Map(), 'a.md', 'sha', ['explicit'], 1);
  const lookup = toDimensionLookup(map);
  assert.deepEqual(lookup.get('a.md'), ['explicit']);
  assert.equal(lookup.size, 1);
});
