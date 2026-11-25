import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  UPDATER_AUTO_CHECK_KEY,
  formatBytes,
  formatProgress,
  loadAutoCheck,
  normalizeReleaseNotes,
  saveAutoCheck,
  type UpdaterStorage,
} from '../../../src/features/updater/model.ts';

class MemoryStorage implements UpdaterStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

void test('自动检查默认为开，只有显式 0 才关闭', () => {
  assert.equal(loadAutoCheck(null), true);
  const storage = new MemoryStorage();
  assert.equal(loadAutoCheck(storage), true);
  storage.setItem(UPDATER_AUTO_CHECK_KEY, '0');
  assert.equal(loadAutoCheck(storage), false);
  storage.setItem(UPDATER_AUTO_CHECK_KEY, '1');
  assert.equal(loadAutoCheck(storage), true);
});

void test('保存开关写入本地存储并返回失败原因', () => {
  const storage = new MemoryStorage();
  assert.equal(saveAutoCheck(storage, false), null);
  assert.equal(storage.getItem(UPDATER_AUTO_CHECK_KEY), '0');
  assert.equal(saveAutoCheck(storage, true), null);
  assert.equal(storage.getItem(UPDATER_AUTO_CHECK_KEY), '1');
  assert.notEqual(saveAutoCheck(null, true), null);
});

void test('下载进度总量未知时只显示已下载量', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KiB');
  assert.equal(formatBytes(2 * 1024 * 1024), '2.0 MiB');
  assert.equal(formatProgress(512, null), '已下载 512 B');
  assert.equal(formatProgress(512, 1024), '已下载 512 B / 1.0 KiB（50%）');
});

void test('发布说明只做纯文本归一化，空白视为无内容', () => {
  assert.equal(normalizeReleaseNotes(null), null);
  assert.equal(normalizeReleaseNotes('  \n '), null);
  assert.equal(normalizeReleaseNotes('  修复播放控件  '), '修复播放控件');
});
