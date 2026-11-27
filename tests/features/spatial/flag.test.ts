/**
 * 空间工作区实验开关：默认关闭、读写与坏存储回退。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SPATIAL_FLAG_KEY,
  readSpatialEnabled,
  writeSpatialEnabled,
} from '../../../src/features/spatial/flag.ts';

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

void test('未设置时默认关闭', () => {
  assert.equal(readSpatialEnabled(new MemoryStorage()), false);
});

void test('写入后按开关值读取', () => {
  const storage = new MemoryStorage();
  writeSpatialEnabled(storage, true);
  assert.equal(storage.getItem(SPATIAL_FLAG_KEY), '1');
  assert.equal(readSpatialEnabled(storage), true);
  writeSpatialEnabled(storage, false);
  assert.equal(readSpatialEnabled(storage), false);
});

void test('非 1 的历史值一律按关闭处理', () => {
  const storage = new MemoryStorage();
  for (const value of ['0', 'true', '', 'yes']) {
    storage.setItem(SPATIAL_FLAG_KEY, value);
    assert.equal(readSpatialEnabled(storage), false, value);
  }
});

void test('存储抛错时读取返回 false、写入不抛出', () => {
  const storage = {
    getItem(): string | null {
      throw new Error('denied');
    },
    setItem(): void {
      throw new Error('quota');
    },
  };
  assert.equal(readSpatialEnabled(storage), false);
  assert.doesNotThrow(() => {
    writeSpatialEnabled(storage, true);
  });
});