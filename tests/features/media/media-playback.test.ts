/**
 * media-playback：播放支持判定与文案（CR-20261119-24）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canPlayHint,
  CONTAINER_ONLY_MESSAGE,
  isPlayableContainer,
  MEDIA_LOAD_FAILED_MESSAGE,
  mediaLoadErrorMessage,
  PLAYABLE_CONTAINERS,
} from '../../../src/features/media/media-playback.ts';

void test('严格容器清单：mp3/m4a/mp4/mov 四种', () => {
  assert.deepEqual([...PLAYABLE_CONTAINERS], ['mp3', 'm4a', 'mp4', 'mov']);
  assert.equal(isPlayableContainer('mp3'), true);
  assert.equal(isPlayableContainer('mov'), true);
  assert.equal(isPlayableContainer('prores'), false);
  assert.equal(isPlayableContainer(''), false);
});

void test('mediaLoadErrorMessage：SRC_NOT_SUPPORTED / DECODE → 容器文案', () => {
  assert.equal(mediaLoadErrorMessage(4), CONTAINER_ONLY_MESSAGE);
  assert.equal(mediaLoadErrorMessage(3), CONTAINER_ONLY_MESSAGE);
});

void test('mediaLoadErrorMessage：其余 → 通用加载失败文案', () => {
  assert.equal(mediaLoadErrorMessage(1), MEDIA_LOAD_FAILED_MESSAGE); // ABORT
  assert.equal(mediaLoadErrorMessage(2), MEDIA_LOAD_FAILED_MESSAGE); // NETWORK
  assert.equal(mediaLoadErrorMessage(null), MEDIA_LOAD_FAILED_MESSAGE);
  assert.equal(mediaLoadErrorMessage(undefined), MEDIA_LOAD_FAILED_MESSAGE);
});

void test('canPlayType 仅预提示：空串提示、maybe/probably 不提示', () => {
  assert.equal(canPlayHint(''), '此格式可能无法播放');
  assert.equal(canPlayHint('maybe'), null);
  assert.equal(canPlayHint('probably'), null);
});
