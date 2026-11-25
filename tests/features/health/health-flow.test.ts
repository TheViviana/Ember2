import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cleanupWorkbenchTrash,
  formatTrashBytes,
  loadWorkbenchTrash,
  summarizeTrash,
  type HealthPanelEffects,
  type WorkbenchTrashEntry,
} from '../../../src/features/health/health-flow.ts';

const first: WorkbenchTrashEntry = {
  id: 'a', path: 'documents/a.md', bytes: 512, deletedAt: '2026-11-20T08:00:00Z',
};
const second: WorkbenchTrashEntry = {
  id: 'b', path: null, bytes: 1024, deletedAt: null,
};

function effects(overrides: Partial<HealthPanelEffects> = {}): HealthPanelEffects {
  return {
    list: () => Promise.resolve([]),
    cleanup: () => Promise.resolve({ removedIds: [], errors: [] }),
    ...overrides,
  };
}

void test('真实条数与总字节，空存量为 0', () => {
  assert.deepEqual(summarizeTrash([first, second]), { count: 2, totalBytes: 1536 });
  assert.deepEqual(summarizeTrash([]), { count: 0, totalBytes: 0 });
  assert.equal(formatTrashBytes(1536), '1.5 KiB');
  assert.equal(formatTrashBytes(0), '0 B');
});

void test('默认无选择或取消永久删除确认均零调用', async () => {
  let calls = 0;
  let confirmations = 0;
  const bridge = effects({
    list: () => { calls += 1; return Promise.resolve([]); },
    cleanup: () => { calls += 1; return Promise.resolve({ removedIds: ['a'], errors: [] }); },
  });
  const empty = await cleanupWorkbenchTrash([first], [], bridge, () => {
    confirmations += 1;
    return true;
  });
  const cancelled = await cleanupWorkbenchTrash([first], ['a'], bridge, () => false);
  assert.equal(empty.status, 'cancelled');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(calls, 0);
  assert.equal(confirmations, 0);
});

void test('确认收到所选计数和字节，cleanup 后强制刷新', async () => {
  const calls: string[] = [];
  let confirmed: unknown = null;
  const result = await cleanupWorkbenchTrash([first, second], ['a'], effects({
    cleanup: (ids) => {
      calls.push(`cleanup:${ids.join(',')}`);
      return Promise.resolve({ removedIds: ['a'], errors: [] });
    },
    list: () => {
      calls.push('list');
      return Promise.resolve([second]);
    },
  }), (summary) => {
    confirmed = summary;
    return true;
  });
  assert.deepEqual(confirmed, { count: 1, totalBytes: 512 });
  assert.deepEqual(calls, ['cleanup:a', 'list']);
  assert.equal(result.status, 'ok');
  if (result.status === 'ok') assert.deepEqual(result.value.entries, [second]);
});

void test('局部失败项即使刷新缺漏也保留，成功项移除', async () => {
  const failure = { id: 'b', code: 'E_IO', message: 'permission denied' };
  const result = await cleanupWorkbenchTrash([first, second], ['a', 'b'], effects({
    cleanup: () => Promise.resolve({ removedIds: ['a'], errors: [failure] }),
    list: () => Promise.resolve([]),
  }), () => true);
  assert.equal(result.status, 'ok');
  if (result.status === 'ok') {
    assert.deepEqual(result.value.entries, [second]);
    assert.deepEqual(result.value.cleanup?.errors, [failure]);
  }
});

void test('cleanup 拒绝不刷新且原列表保留，错误可见', async () => {
  let lists = 0;
  const result = await cleanupWorkbenchTrash([first], ['a'], effects({
    cleanup: () => Promise.reject(new Error('cleanup failed')),
    list: () => { lists += 1; return Promise.resolve([]); },
  }), () => true);
  assert.equal(result.status, 'error');
  if (result.status === 'error') {
    assert.match(result.error, /cleanup failed/);
    assert.deepEqual(result.value.entries, [first]);
  }
  assert.equal(lists, 0);
});

void test('清理后的刷新失败仍移除成功项并保留失败项', async () => {
  const result = await cleanupWorkbenchTrash([first, second], ['a', 'b'], effects({
    cleanup: () => Promise.resolve({
      removedIds: ['a'],
      errors: [{ id: 'b', code: 'E_IO', message: 'still busy' }],
    }),
    list: () => Promise.reject(new Error('refresh failed')),
  }), () => true);
  assert.equal(result.status, 'error');
  if (result.status === 'error') {
    assert.match(result.error, /refresh failed/);
    assert.deepEqual(result.value.entries, [second]);
    assert.equal(result.value.cleanup?.errors[0]?.message, 'still busy');
  }
});

void test('初始 list 错误不吞掉', async () => {
  const result = await loadWorkbenchTrash(effects({
    list: () => Promise.reject(new Error('list failed')),
  }));
  assert.equal(result.status, 'error');
  if (result.status === 'error') assert.match(result.error, /list failed/);
});
