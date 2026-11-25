/**
 * media-format：字节 / 时间格式化（CR-20261119-23 §D8；与 backup 同规格）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatBytes, formatTime } from '../../../src/features/media/media-format.ts';

void test('formatBytes：< 1 KiB 显示 B', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1023), '1023 B');
});

void test('formatBytes：1024 进制保留 1 位小数', () => {
  assert.equal(formatBytes(1024), '1.0 KiB');
  assert.equal(formatBytes(1536), '1.5 KiB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MiB');
  assert.equal(formatBytes(64 * 1024 * 1024), '64.0 MiB');
  assert.equal(formatBytes(1024 * 1024 * 1024), '1.0 GiB');
});

void test('formatBytes：非法输入不抛错', () => {
  assert.equal(formatBytes(-1), '0 B');
  assert.equal(formatBytes(Number.NaN), '0 B');
});

void test('formatTime：epoch 毫秒 → 本地可读（时区无关往返）', () => {
  const d = new Date(2026, 10, 20, 9, 30, 5); // 本地 2026-11-20 09:30:05
  assert.equal(formatTime(d.getTime()), '2026-11-20 09:30:05');
  assert.equal(formatTime(0).startsWith('1970-'), true, 'epoch 起点合法');
});
