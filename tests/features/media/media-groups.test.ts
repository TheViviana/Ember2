/**
 * media-groups：tabs 过滤 / 分组计数 / 排序 / 懒加载切片（CR-20261119-23 §D8）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  countByTab,
  filterByTab,
  sliceVisible,
  sortForDisplay,
  type MediaEntry,
} from '../../../src/features/media/media-groups.ts';

const entry = (kind: MediaEntry['kind'], path: string, modifiedMs: number, bytes = 1): MediaEntry => ({
  kind,
  path,
  modifiedMs,
  bytes,
});

const FIXTURE: readonly MediaEntry[] = [
  entry('image', 'media/image/ab/one.png', 300),
  entry('audio', 'media/audio/cd/song.mp3', 200),
  entry('video', 'media/video/ef/clip.mp4', 100),
  entry('image', 'media/image/ab/two.png', 250),
  entry('doc', 'media/doc/ab/paper.pdf', 50),
];

void test('filterByTab：四种 tab 各返回正确子集', () => {
  assert.deepEqual(
    filterByTab(FIXTURE, 'all').map((e) => e.path),
    FIXTURE.map((e) => e.path),
  );
  assert.deepEqual(
    filterByTab(FIXTURE, 'image').map((e) => e.path),
    ['media/image/ab/one.png', 'media/image/ab/two.png'],
  );
  assert.deepEqual(filterByTab(FIXTURE, 'audio').length, 1);
  assert.deepEqual(filterByTab(FIXTURE, 'video').length, 1);
  assert.deepEqual(filterByTab(FIXTURE, 'doc').length, 1, 'doc tab 过滤（CR-20261120-26）');
});

void test('countByTab：all 为全量，分项相加一致', () => {
  const counts = countByTab(FIXTURE);
  assert.deepEqual(counts, { all: 5, image: 2, audio: 1, video: 1, doc: 1 });
  assert.equal(counts.image + counts.audio + counts.video + counts.doc, counts.all);
  assert.deepEqual(countByTab([]), { all: 0, image: 0, audio: 0, video: 0, doc: 0 });
});

void test('sortForDisplay：modifiedMs 降序', () => {
  const sorted = [...sortForDisplay(FIXTURE)];
  assert.deepEqual(
    sorted.map((e) => e.modifiedMs),
    [300, 250, 200, 100, 50],
  );
  // 原数组不被修改（纯函数）
  assert.equal(FIXTURE[0]?.modifiedMs, 300);
});

void test('sortForDisplay：同 ms 按 path 字典序升序（稳定确定）', () => {
  const tied = [entry('image', 'b.png', 500), entry('audio', 'c.mp3', 500), entry('video', 'a.mp4', 500)];
  assert.deepEqual(
    sortForDisplay(tied).map((e) => e.path),
    ['a.mp4', 'b.png', 'c.mp3'],
  );
});

void test('sliceVisible：切片与超界', () => {
  const big: MediaEntry[] = Array.from({ length: 400 }, (_, i) =>
    entry('image', `p${i}`, i),
  );
  assert.equal(sliceVisible(big, 120).length, 120);
  assert.equal(sliceVisible(big, 360).length, 360);
  assert.equal(sliceVisible(big, 10_000).length, 400, '超界无害');
  assert.equal(sliceVisible(big, 0).length, 0);
});
