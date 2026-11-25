import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pausePlayingMedia, type PauseableMedia } from '../../../src/features/media/media-playback.ts';

class FakeMedia implements PauseableMedia {
  paused: boolean;
  pauseCalls = 0;

  constructor(paused: boolean) {
    this.paused = paused;
  }

  pause(): void {
    this.pauseCalls += 1;
    this.paused = true;
  }
}

void test('B7：暂停窗口内全部播放元素', () => {
  const playing = new FakeMedia(false);
  const paused = new FakeMedia(true);
  assert.equal(pausePlayingMedia([playing, paused]), 1);
  assert.equal(playing.pauseCalls, 1);
  assert.equal(paused.pauseCalls, 0);
});

void test('B7：开始播放当前元素时只暂停其他元素', () => {
  const current = new FakeMedia(false);
  const other = new FakeMedia(false);
  assert.equal(pausePlayingMedia([current, other], current), 1);
  assert.equal(current.pauseCalls, 0);
  assert.equal(other.pauseCalls, 1);
});

void test('B7：空集合与全部已暂停返回 0', () => {
  assert.equal(pausePlayingMedia([]), 0);
  assert.equal(pausePlayingMedia([new FakeMedia(true), new FakeMedia(true)]), 0);
});
