/**
 * A2：backup-format 纯函数（node:test，CR-20261119-22 §6.1）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatBytes, formatTime } from '../../../src/features/backup/backup-format.ts';

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

void test('formatTime：合法 ISO → 本地可读（时区无关往返）', () => {
  const d = new Date(2026, 0, 15, 9, 30, 5); // 本地 2026-01-15 09:30:05
  assert.equal(formatTime(d.toISOString()), '2026-01-15 09:30:05');
});

void test('formatTime：非法串原样返回不抛错', () => {
  assert.equal(formatTime('not-a-date'), 'not-a-date');
  assert.equal(formatTime(''), '');
});
