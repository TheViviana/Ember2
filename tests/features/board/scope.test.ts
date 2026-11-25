/**
 * 2026-11-23：看板范围/下钻过滤（全部/30/90/182、单日、近 7 天、90 天未更新）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOARD_STALE_DAYS, filterBoardDocs } from '../../../src/features/board/scope.ts';

const NOW = new Date(2026, 10, 23, 12, 0).getTime();
const doc = (path: string, daysAgo: number, hour = 12) => ({
  path,
  modifiedMs: new Date(2026, 10, 23 - daysAgo, hour, 0).getTime(),
});

const docs = [
  doc('today.md', 0),
  doc('three.md', 3),
  doc('ten.md', 10),
  doc('forty.md', 40),
  doc('hundred.md', 100),
  doc('twohundred.md', 200),
];

void test('全部/30/90/182 按最后修改时间圈定', () => {
  assert.equal(filterBoardDocs(docs, { now: NOW }).length, 6);
  assert.deepEqual(filterBoardDocs(docs, { now: NOW, rangeDays: 30 }).map((d) => d.path), [
    'today.md',
    'three.md',
    'ten.md',
  ]);
  assert.equal(filterBoardDocs(docs, { now: NOW, rangeDays: 90 }).length, 4);
  assert.equal(filterBoardDocs(docs, { now: NOW, rangeDays: 182 }).length, 5);
});

void test('单日筛选按本地日期精确匹配', () => {
  assert.deepEqual(
    filterBoardDocs(docs, { now: NOW, activeDate: '2026-11-20' }).map((d) => d.path),
    ['three.md'],
  );
});

void test('近 7 天与 90 天未更新互斥语义', () => {
  assert.deepEqual(
    filterBoardDocs(docs, { now: NOW, quickFilter: 'week' }).map((d) => d.path),
    ['today.md', 'three.md'],
  );
  assert.deepEqual(
    filterBoardDocs(docs, { now: NOW, quickFilter: 'stale' }).map((d) => d.path),
    ['hundred.md', 'twohundred.md'],
  );
  assert.equal(BOARD_STALE_DAYS, 90);
});

void test('range 与下钻取交集，不越界', () => {
  assert.deepEqual(
    filterBoardDocs(docs, { now: NOW, rangeDays: 30, quickFilter: 'week' }).map((d) => d.path),
    ['today.md', 'three.md'],
  );
  assert.deepEqual(
    filterBoardDocs(docs, { now: NOW, rangeDays: 30, activeDate: '2026-11-13' }).map(
      (d) => d.path,
    ),
    ['ten.md'],
  );
});
