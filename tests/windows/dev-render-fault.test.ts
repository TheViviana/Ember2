import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NEXT_WINDOW_TARGET,
  RENDER_FAULT_KEY,
  armRenderFault,
  clearRenderFault,
  isRenderFaultArmed,
  type RenderFaultStorage,
} from '../../src/windows/dev-render-fault.ts';

class MemoryStorage implements RenderFaultStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

void test('DEV：next 目标命中任一新挂载窗口且一次性', () => {
  const storage = new MemoryStorage();
  assert.equal(armRenderFault(NEXT_WINDOW_TARGET, storage), true);
  assert.equal(storage.getItem(RENDER_FAULT_KEY), NEXT_WINDOW_TARGET);
  assert.equal(isRenderFaultArmed('window-a', storage, true), true);
  assert.equal(isRenderFaultArmed('window-b', storage, true), true);

  clearRenderFault(storage, true);
  assert.equal(storage.getItem(RENDER_FAULT_KEY), null);
  assert.equal(isRenderFaultArmed('window-a', storage, true), false);
});

void test('DEV：指定窗口 id 只命中该窗口', () => {
  const storage = new MemoryStorage();
  assert.equal(armRenderFault('window-a', storage), true);
  assert.equal(isRenderFaultArmed('window-a', storage, true), true);
  assert.equal(isRenderFaultArmed('window-b', storage, true), false);
});

void test('生产构建永不注入，也不清除存储', () => {
  const storage = new MemoryStorage();
  assert.equal(armRenderFault(NEXT_WINDOW_TARGET, storage), true);
  assert.equal(isRenderFaultArmed('window-a', storage, false), false);
  clearRenderFault(storage, false);
  assert.equal(storage.getItem(RENDER_FAULT_KEY), NEXT_WINDOW_TARGET);
});

void test('空目标与不可用存储安全失败', () => {
  const storage = new MemoryStorage();
  assert.equal(armRenderFault('   ', storage), false);
  assert.equal(storage.getItem(RENDER_FAULT_KEY), null);

  const broken: RenderFaultStorage = {
    getItem() {
      throw new Error('storage disabled');
    },
    setItem() {
      throw new Error('storage disabled');
    },
    removeItem() {
      throw new Error('storage disabled');
    },
  };
  assert.equal(armRenderFault(NEXT_WINDOW_TARGET, broken), false);
  assert.equal(isRenderFaultArmed('window-a', broken, true), false);
  clearRenderFault(broken, true);
});
