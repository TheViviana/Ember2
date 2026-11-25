/**
 * media-list-reducer：六态状态机（CR-20261119-23 §D3/D8）。
 * 六态：idle / loading / ready / error / confirming / deleting。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createMediaListState,
  mediaListReducer,
  type MediaListAction,
  type MediaListState,
} from '../../../src/features/media/media-list-reducer.ts';
import { FIRST_SLICE, MORE_SLICE, type MediaEntry } from '../../../src/features/media/media-groups.ts';

const entry = (kind: MediaEntry['kind'], path: string, modifiedMs: number): MediaEntry => ({
  kind,
  path,
  modifiedMs,
  bytes: 1,
});

function run(state: MediaListState, action: MediaListAction): MediaListState {
  return mediaListReducer(state, action);
}

const SAMPLE: readonly MediaEntry[] = [
  entry('audio', 'media/audio/s.mp3', 100),
  entry('image', 'media/image/i.png', 900),
  entry('video', 'media/video/v.mp4', 500),
];

// ── 加载主链路 ──────────────────────────────────────────────────────────────

void test('idle → LOAD_START → loading → LOAD_OK → ready：排序降序 + 切片 120', () => {
  const s0 = createMediaListState();
  assert.equal(s0.status, 'idle');
  const s1 = run(s0, { type: 'LOAD_START' });
  assert.equal(s1.status, 'loading');
  const s2 = run(s1, { type: 'LOAD_OK', entries: SAMPLE });
  assert.equal(s2.status, 'ready');
  assert.deepEqual(
    s2.entries.map((e) => e.modifiedMs),
    [900, 500, 100],
    'LOAD_OK 内完成降序排序',
  );
  assert.equal(s2.visibleCount, FIRST_SLICE);
  assert.equal(s2.error, null);
});

void test('LOAD_ERR → error 保存 code+message；error 态可重试（LOAD_START）', () => {
  const s = run(run(createMediaListState(), { type: 'LOAD_START' }), {
    type: 'LOAD_ERR',
    code: 'E_IO',
    message: '读取失败',
  });
  assert.equal(s.status, 'error');
  assert.equal(s.error?.code, 'E_IO');
  assert.equal(s.error?.message, '读取失败');
  assert.equal(s.entries.length, 0);
  const retried = run(s, { type: 'LOAD_START' });
  assert.equal(retried.status, 'loading');
});

// ── tab 与懒加载（仅 ready）────────────────────────────────────────────────

void test('TAB_CHANGE：ready 生效且切片重置；loading 期间被拒', () => {
  const ready = run(run(createMediaListState(), { type: 'LOAD_START' }), {
    type: 'LOAD_OK',
    entries: SAMPLE,
  });
  const shownMore = run(ready, { type: 'SHOW_MORE' });
  assert.equal(shownMore.visibleCount, FIRST_SLICE + MORE_SLICE);
  const changed = run(shownMore, { type: 'TAB_CHANGE', tab: 'image' });
  assert.equal(changed.tab, 'image');
  assert.equal(changed.visibleCount, FIRST_SLICE, '切 tab 重置懒加载切片');

  const loading = run(createMediaListState(), { type: 'LOAD_START' });
  const rejected = run(loading, { type: 'TAB_CHANGE', tab: 'video' });
  assert.equal(rejected.tab, 'all', 'loading 期间 TAB_CHANGE 被拒');
});

void test('SHOW_MORE 二次追加无害（超界切片）', () => {
  const ready = run(run(createMediaListState(), { type: 'LOAD_START' }), {
    type: 'LOAD_OK',
    entries: SAMPLE,
  });
  const once = run(ready, { type: 'SHOW_MORE' });
  const twice = run(once, { type: 'SHOW_MORE' });
  assert.equal(twice.visibleCount, FIRST_SLICE + MORE_SLICE * 2);
});

// ── 删除链（confirming / deleting）─────────────────────────────────────────

void test('CONFIRM_OPEN → confirming；CONFIRM_CANCEL → ready；未就绪被拒', () => {
  const ready = run(run(createMediaListState(), { type: 'LOAD_START' }), {
    type: 'LOAD_OK',
    entries: SAMPLE,
  });
  const confirming = run(ready, { type: 'CONFIRM_OPEN', path: 'media/image/i.png' });
  assert.equal(confirming.status, 'confirming');
  assert.equal(confirming.pendingPath, 'media/image/i.png');
  const cancelled = run(confirming, { type: 'CONFIRM_CANCEL' });
  assert.equal(cancelled.status, 'ready');
  assert.equal(cancelled.pendingPath, null);

  const idle = createMediaListState();
  assert.equal(run(idle, { type: 'CONFIRM_OPEN', path: 'x' }).status, 'idle', '未就绪不得确认');
  assert.equal(
    run(confirming, { type: 'TAB_CHANGE', tab: 'audio' }).tab,
    'all',
    '确认框开着不得切 tab',
  );
});

void test('删除链：DELETE_START → deleting；DELETE_OK → loading（重新拉取）→ ready', () => {
  const ready = run(run(createMediaListState(), { type: 'LOAD_START' }), {
    type: 'LOAD_OK',
    entries: SAMPLE,
  });
  const confirming = run(ready, { type: 'CONFIRM_OPEN', path: 'media/audio/s.mp3' });
  const deleting = run(confirming, { type: 'DELETE_START' });
  assert.equal(deleting.status, 'deleting');
  assert.equal(deleting.pendingPath, 'media/audio/s.mp3');

  const reloading = run(deleting, { type: 'DELETE_OK', via: 'system' });
  assert.equal(reloading.status, 'loading', '成功后重新拉取');
  assert.equal(reloading.pendingPath, null);
  assert.equal(reloading.lastDeleteVia, 'system');

  const refreshed = run(reloading, { type: 'LOAD_OK', entries: SAMPLE.slice(1) });
  assert.equal(refreshed.status, 'ready');
  assert.equal(refreshed.entries.length, 2);

  // in-flight 拒绝：deleting 期间不得再次确认/切换
  assert.equal(run(deleting, { type: 'CONFIRM_OPEN', path: 'y' }).status, 'deleting');
  assert.equal(run(deleting, { type: 'TAB_CHANGE', tab: 'all' }).tab, confirming.tab);
});

void test('删除失败：error 保存 code+message、entries 保留、pendingPath 清空', () => {
  const ready = run(run(createMediaListState(), { type: 'LOAD_START' }), {
    type: 'LOAD_OK',
    entries: SAMPLE,
  });
  const deleting = run(run(ready, { type: 'CONFIRM_OPEN', path: 'media/video/v.mp4' }), {
    type: 'DELETE_START',
  });
  const failed = run(deleting, {
    type: 'DELETE_ERR',
    code: 'E_READONLY',
    message: '库处于只读态',
  });
  assert.equal(failed.status, 'error');
  assert.equal(failed.error?.code, 'E_READONLY');
  assert.equal(failed.error?.message, '库处于只读态');
  assert.equal(failed.entries.length, 3, '删除失败列表不闪失');
  assert.equal(failed.pendingPath, null);
  // error 态可对同一行重新发起删除确认
  const retry = run(failed, { type: 'CONFIRM_OPEN', path: 'media/video/v.mp4' });
  assert.equal(retry.status, 'confirming');
  assert.equal(retry.error, null, '重新确认清除上次错误');
});
