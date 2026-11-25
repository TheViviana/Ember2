import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  inboxStorageKey,
  loadInboxItems,
  saveInboxItems,
} from '../../../src/features/collect/storage.ts';
import type { InboxItem } from '../../../src/features/collect/model.ts';

const item: InboxItem = { id: 'a', kind: 'text', text: 'hello', createdAt: 1 };

void test('存储按 vault 隔离', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  assert.equal(saveInboxItems(storage, 'vault-a', [item]), null);
  assert.equal(saveInboxItems(storage, 'vault-b', []), null);
  assert.equal(inboxStorageKey('vault-a'), 'ember2:inbox:v1:vault-a');
  assert.deepEqual(loadInboxItems(storage, 'vault-a').items, [item]);
  assert.deepEqual(loadInboxItems(storage, 'vault-b').items, []);
});

void test('损坏结构回退为空并给出可见警告', () => {
  const storage = {
    getItem: () => JSON.stringify({ version: 1, items: [{ id: 'bad' }] }),
    setItem: () => undefined,
  };
  const loaded = loadInboxItems(storage, 'vault');
  assert.deepEqual(loaded.items, []);
  assert.match(loaded.warning ?? '', /损坏/);
});

void test('读取与写入异常不会静默吞掉', () => {
  const readFailure = loadInboxItems(
    {
      getItem: () => { throw new Error('denied'); },
      setItem: () => undefined,
    },
    'vault',
  );
  assert.match(readFailure.warning ?? '', /读取失败/);
  const writeFailure = saveInboxItems(
    {
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
    },
    'vault',
    [item],
  );
  assert.match(writeFailure ?? '', /未持久化/);
  assert.match(writeFailure ?? '', /quota/);
});
