import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SETTINGS_RECENT_KEY,
  SETTINGS_RECENT_LIMIT,
  loadRecentSettings,
  recordRecentSetting,
} from '../../../src/app/shell/settings-recent.ts';

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

void test('记录最近设置：去重、前置并限制数量', () => {
  const storage = new MemoryStorage();
  recordRecentSetting(storage, 'appearance');
  recordRecentSetting(storage, 'editor');
  const next = recordRecentSetting(storage, 'appearance');
  assert.deepEqual(next, ['appearance', 'editor']);
  recordRecentSetting(storage, 'ai');
  const capped = recordRecentSetting(storage, 'library');
  assert.equal(capped.length, SETTINGS_RECENT_LIMIT);
  assert.deepEqual(capped, ['library', 'ai', 'appearance']);
  assert.deepEqual(loadRecentSettings(storage), capped);
});

void test('损坏数据与非法条目回退为空或过滤', () => {
  const storage = new MemoryStorage();
  storage.setItem(SETTINGS_RECENT_KEY, '{oops');
  assert.deepEqual(loadRecentSettings(storage), []);
  storage.setItem(SETTINGS_RECENT_KEY, JSON.stringify(['ai', 3, '', 'ai', null, 'editor']));
  assert.deepEqual(loadRecentSettings(storage), ['ai', 'editor']);
  storage.setItem(SETTINGS_RECENT_KEY, JSON.stringify({ id: 'ai' }));
  assert.deepEqual(loadRecentSettings(storage), []);
});

void test('存储抛错不影响导航', () => {
  const storage = {
    getItem(): string | null {
      throw new Error('denied');
    },
    setItem(): void {
      throw new Error('quota');
    },
  };
  assert.deepEqual(loadRecentSettings(storage), []);
  assert.deepEqual(recordRecentSetting(storage, 'ai'), ['ai']);
});
