import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_BOARD_FILTERS,
  boardFilterStorageKey,
  describeBoardFilters,
  loadBoardFilters,
  normalizeBoardFilters,
  saveBoardFilters,
} from '../../../src/features/board/filters.ts';

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

void test('缺失或损坏的持久化数据回退默认值', () => {
  const storage = new MemoryStorage();
  assert.deepEqual(loadBoardFilters(storage, 'vault-a'), DEFAULT_BOARD_FILTERS);
  storage.setItem(boardFilterStorageKey('vault-a'), '{oops');
  assert.deepEqual(loadBoardFilters(storage, 'vault-a'), DEFAULT_BOARD_FILTERS);
  storage.setItem(boardFilterStorageKey('vault-a'), 'null');
  assert.deepEqual(loadBoardFilters(storage, 'vault-a'), DEFAULT_BOARD_FILTERS);
});

void test('逐项校验范围、日期、快捷与分类筛选', () => {
  assert.deepEqual(
    normalizeBoardFilters({
      rangeDays: 30,
      activeDate: '2026-11-25',
      quickFilter: 'week',
      listFilter: 'unclassified',
    }),
    { rangeDays: 30, activeDate: '2026-11-25', quickFilter: null, listFilter: 'unclassified' },
  );
  assert.deepEqual(
    normalizeBoardFilters({
      rangeDays: 45,
      activeDate: '11-25',
      quickFilter: 'later',
      listFilter: 'other',
    }),
    DEFAULT_BOARD_FILTERS,
  );
  assert.deepEqual(normalizeBoardFilters({ rangeDays: 182, quickFilter: 'stale' }), {
    rangeDays: 182,
    activeDate: null,
    quickFilter: 'stale',
    listFilter: 'all',
  });
});

void test('按库隔离保存并恢复', () => {
  const storage = new MemoryStorage();
  saveBoardFilters(storage, 'vault-a', {
    rangeDays: 90,
    activeDate: null,
    quickFilter: 'stale',
    listFilter: 'all',
  });
  saveBoardFilters(storage, 'vault-b', {
    rangeDays: null,
    activeDate: null,
    quickFilter: null,
    listFilter: 'unclassified',
  });
  assert.equal(loadBoardFilters(storage, 'vault-a').rangeDays, 90);
  assert.equal(loadBoardFilters(storage, 'vault-a').quickFilter, 'stale');
  assert.equal(loadBoardFilters(storage, 'vault-b').listFilter, 'unclassified');
  assert.equal(loadBoardFilters(storage, 'vault-b').rangeDays, null);
});

void test('存储抛错不打断看板', () => {
  const storage = {
    getItem(): string | null {
      throw new Error('denied');
    },
    setItem(): void {
      throw new Error('quota');
    },
  };
  assert.deepEqual(loadBoardFilters(storage, 'vault-a'), DEFAULT_BOARD_FILTERS);
  assert.doesNotThrow(() =>
    saveBoardFilters(storage, 'vault-a', DEFAULT_BOARD_FILTERS),
  );
});

void test('筛选条只描述当前生效的条件', () => {
  assert.deepEqual(describeBoardFilters(DEFAULT_BOARD_FILTERS), []);
  assert.deepEqual(
    describeBoardFilters({
      rangeDays: 30,
      activeDate: '2026-11-25',
      quickFilter: null,
      listFilter: 'unclassified',
    }),
    [
      { key: 'range', label: '近 30 天' },
      { key: 'date', label: '日期 2026-11-25' },
      { key: 'list', label: '仅未分类' },
    ],
  );
  assert.deepEqual(
    describeBoardFilters({
      rangeDays: null,
      activeDate: null,
      quickFilter: 'stale',
      listFilter: 'all',
    }),
    [{ key: 'quick', label: '90 天未更新' }],
  );
});
