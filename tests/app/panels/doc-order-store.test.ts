import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadDocOrder,
  removeChildFromOrder,
  resetDocOrder,
  setChildOrder,
} from '../../../src/app/panels/doc-order-store.ts';

interface MemStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function mem(): MemStorage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

void test('setChildOrder 写入后 loadDocOrder 可读出', () => {
  const s = mem();
  setChildOrder('/root', '', ['b', 'a'], s);
  setChildOrder('/root', 'notes', ['x'], s);
  assert.deepEqual(loadDocOrder('/root', s), { '': ['b', 'a'], notes: ['x'] });
});

void test('removeChildFromOrder 清空后删除该目录键（回退默认排序）', () => {
  const s = mem();
  setChildOrder('/root', 'notes', ['a'], s);
  removeChildFromOrder('/root', 'notes', 'a', s);
  assert.deepEqual(loadDocOrder('/root', s), {});
});

void test('removeChildFromOrder 保留剩余项', () => {
  const s = mem();
  setChildOrder('/root', 'notes', ['a', 'b', 'c'], s);
  removeChildFromOrder('/root', 'notes', 'b', s);
  assert.deepEqual(loadDocOrder('/root', s), { notes: ['a', 'c'] });
});

void test('removeChildFromOrder 未登记目录无副作用', () => {
  const s = mem();
  removeChildFromOrder('/root', 'nope', 'a', s);
  assert.deepEqual(loadDocOrder('/root', s), {});
});

void test('resetDocOrder 清空整个知识库的顺序', () => {
  const s = mem();
  setChildOrder('/root', '', ['a'], s);
  setChildOrder('/root', 'n', ['b'], s);
  resetDocOrder('/root', s);
  assert.deepEqual(loadDocOrder('/root', s), {});
});

void test('不同 root 的顺序相互隔离', () => {
  const s = mem();
  setChildOrder('/r1', '', ['a'], s);
  assert.deepEqual(loadDocOrder('/r2', s), {});
  assert.deepEqual(loadDocOrder('/r1', s), { '': ['a'] });
});

void test('损坏的存储内容解析为空对象，不抛错', () => {
  const s = mem();
  s.setItem('ember.doc-order.root', '{not json');
  assert.deepEqual(loadDocOrder('root', s), {});
  s.setItem('ember.doc-order.root2', JSON.stringify({ '': [1, 2] })); // 非字符串数组
  assert.deepEqual(loadDocOrder('root2', s), {});
});

void test('空字符串 root 也能稳定存取', () => {
  const s = mem();
  setChildOrder('', '', ['a'], s);
  assert.deepEqual(loadDocOrder('', s), { '': ['a'] });
});
