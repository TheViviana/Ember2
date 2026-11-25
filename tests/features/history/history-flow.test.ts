import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deleteHistoryVersion,
  historyUnavailableReason,
  isValidHistoryDocId,
  loadHistoryTimeline,
  purgeHistory,
  readHistoryVersion,
  restoreHistoryVersion,
  type HistoryPanelEffects,
  type HistoryRestoreRequest,
  type HistoryVersion,
} from '../../../src/features/history/history-flow.ts';

const DOC_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const VERSION = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const NEXT_VERSION = '01ARZ3NDEKTSV4RRFFQ69G5FAX';
const TARGET = { path: 'documents/a.md', docId: DOC_ID, version: VERSION };
const timeline: readonly HistoryVersion[] = [
  { version: VERSION, createdAt: '2026-11-20T08:00:00Z', bytes: 3 },
];

function makeEffects(overrides: Partial<HistoryPanelEffects> = {}): HistoryPanelEffects {
  return {
    list: () => Promise.resolve(timeline),
    read: () => Promise.resolve({ text: 'old' }),
    readCurrent: () => Promise.resolve({ text: 'current', sha256: 'sha-current' }),
    flush: () => Promise.resolve(),
    restore: () => Promise.resolve({ path: TARGET.path, bytes: 3, sha256: 'sha-restored' }),
    delete: () => Promise.resolve({ deleted: true }),
    purge: () => Promise.resolve({ deleted: 1 }),
    reconcile: () => Promise.resolve(),
    ...overrides,
  };
}

void test('无 path / 无 id / 非法 ULID 显示原因且不调用 list', async () => {
  assert.match(historyUnavailableReason(null, DOC_ID) ?? '', /打开一个文档/);
  assert.match(historyUnavailableReason(TARGET.path, null) ?? '', /没有 id/);
  assert.match(historyUnavailableReason(TARGET.path, 'not-a-ulid') ?? '', /合法 ULID/);
  assert.equal(historyUnavailableReason(TARGET.path, DOC_ID), null);
  assert.equal(isValidHistoryDocId(DOC_ID.toLowerCase()), true);
  assert.equal(isValidHistoryDocId('81ARZ3NDEKTSV4RRFFQ69G5FAV'), false);
  assert.equal(isValidHistoryDocId('01ARZ3NDEKTSV4RRFFQ69G5FAI'), false);

  let lists = 0;
  const result = await loadHistoryTimeline('bad', makeEffects({
    list: () => { lists += 1; return Promise.resolve(timeline); },
  }));
  assert.equal(result.status, 'error');
  assert.equal(lists, 0);
});

void test('list 错误转成可见错误', async () => {
  const result = await loadHistoryTimeline(DOC_ID, makeEffects({
    list: () => Promise.reject(new Error('list denied')),
  }));
  assert.equal(result.status, 'error');
  if (result.status === 'error') assert.match(result.error, /list denied/);
});

void test('历史 read 与当前 readCurrent 错误都可见', async () => {
  const historical = await readHistoryVersion(TARGET, makeEffects({
    read: () => Promise.reject(new Error('history read failed')),
  }));
  assert.equal(historical.status, 'error');
  if (historical.status === 'error') assert.match(historical.error, /history read failed/);

  const current = await readHistoryVersion(TARGET, makeEffects({
    readCurrent: () => Promise.reject(new Error('current read failed')),
  }));
  assert.equal(current.status, 'error');
  if (current.status === 'error') assert.match(current.error, /current read failed/);
});

void test('read 成功生成当前到所选历史版本的 diff', async () => {
  const result = await readHistoryVersion(TARGET, makeEffects({
    readCurrent: () => Promise.resolve({ text: 'same\ncurrent', sha256: 'sha' }),
    read: () => Promise.resolve({ text: 'same\nhistorical' }),
  }));
  assert.equal(result.status, 'ok');
  if (result.status === 'ok') {
    assert.deepEqual(
      result.value.diff.operations.map((item) => [item.type, item.text]),
      [['equal', 'same'], ['delete', 'current'], ['insert', 'historical']],
    );
  }
});

void test('恢复严格 flush → readCurrent → restore → reconcile，使用最新 expectedSha 并刷新', async () => {
  const calls: string[] = [];
  let request: HistoryRestoreRequest | null = null;
  let reads = 0;
  const result = await restoreHistoryVersion(TARGET, makeEffects({
    flush: () => { calls.push('flush'); return Promise.resolve(); },
    readCurrent: () => {
      reads += 1;
      if (reads === 1) {
        calls.push('readCurrent:latest');
        return Promise.resolve({ text: 'latest current', sha256: 'sha-latest' });
      }
      calls.push('readCurrent:refresh');
      return Promise.resolve({ text: 'restored current', sha256: 'sha-restored' });
    },
    restore: (input) => {
      request = input;
      calls.push('restore');
      return Promise.resolve({ path: TARGET.path, bytes: 3, sha256: 'sha-restored' });
    },
    reconcile: (path) => { calls.push(`reconcile:${path}`); return Promise.resolve(); },
    list: () => {
      calls.push('list:refresh');
      return Promise.resolve([...timeline, { ...timeline[0]!, version: NEXT_VERSION }]);
    },
    read: () => { calls.push('read:refresh'); return Promise.resolve({ text: 'historical' }); },
  }));

  assert.deepEqual(calls.slice(0, 4), [
    'flush',
    'readCurrent:latest',
    'restore',
    `reconcile:${TARGET.path}`,
  ]);
  assert.deepEqual(request, { ...TARGET, expectedSha: 'sha-latest' });
  assert.ok(calls.includes('list:refresh'));
  assert.ok(calls.includes('readCurrent:refresh'));
  assert.ok(calls.includes('read:refresh'));
  assert.equal(result.status, 'ok');
  if (result.status === 'ok') {
    assert.equal(result.value.versions.length, 2);
    assert.equal(result.value.current.sha256, 'sha-restored');
    assert.equal(result.value.historical.text, 'historical');
  }
});

void test('flush 失败不读取或恢复，readCurrent 失败不写当前文档', async () => {
  let writes = 0;
  const flushFailure = await restoreHistoryVersion(TARGET, makeEffects({
    flush: () => Promise.reject(new Error('flush failed')),
    restore: () => { writes += 1; return Promise.resolve({}); },
  }));
  assert.equal(flushFailure.status, 'error');
  if (flushFailure.status === 'error') assert.match(flushFailure.error, /flush failed/);

  const readFailure = await restoreHistoryVersion(TARGET, makeEffects({
    readCurrent: () => Promise.reject(new Error('latest read failed')),
    restore: () => { writes += 1; return Promise.resolve({}); },
  }));
  assert.equal(readFailure.status, 'error');
  if (readFailure.status === 'error') assert.match(readFailure.error, /latest read failed/);
  assert.equal(writes, 0);
});

void test('恢复冲突不重试、不 reconcile，当前内容不被覆盖', async () => {
  const currentContent = 'externally changed';
  let restores = 0;
  let reconciles = 0;
  let refreshes = 0;
  const result = await restoreHistoryVersion(TARGET, makeEffects({
    readCurrent: () => Promise.resolve({ text: currentContent, sha256: 'sha-external' }),
    restore: (request) => {
      restores += 1;
      assert.equal(request.expectedSha, 'sha-external');
      return Promise.reject(new Error('E_INVALID_ARG: conflict'));
    },
    reconcile: () => { reconciles += 1; return Promise.resolve(); },
    list: () => { refreshes += 1; return Promise.resolve(timeline); },
  }));
  assert.equal(result.status, 'error');
  if (result.status === 'error') assert.match(result.error, /未覆盖.*conflict/);
  assert.equal(restores, 1);
  assert.equal(reconciles, 0);
  assert.equal(refreshes, 0);
  assert.equal(currentContent, 'externally changed');
});

void test('reconcile 失败明确提示已恢复，且不伪装刷新成功', async () => {
  let lists = 0;
  const result = await restoreHistoryVersion(TARGET, makeEffects({
    reconcile: () => Promise.reject(new Error('reconcile failed')),
    list: () => { lists += 1; return Promise.resolve(timeline); },
  }));
  assert.equal(result.status, 'error');
  if (result.status === 'error') assert.match(result.error, /已恢复.*reconcile failed/);
  assert.equal(lists, 0);
});

void test('单版删除需要确认，delete 错误可见且不刷新', async () => {
  let deletes = 0;
  let lists = 0;
  const bridge = makeEffects({
    delete: () => { deletes += 1; return Promise.reject(new Error('delete failed')); },
    list: () => { lists += 1; return Promise.resolve(timeline); },
  });
  const cancelled = await deleteHistoryVersion(TARGET, bridge, () => false);
  const failed = await deleteHistoryVersion(TARGET, bridge, () => true);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(failed.status, 'error');
  if (failed.status === 'error') assert.match(failed.error, /delete failed/);
  assert.equal(deletes, 1);
  assert.equal(lists, 0);
});

void test('单版删除成功后刷新时间线', async () => {
  const calls: string[] = [];
  const result = await deleteHistoryVersion(TARGET, makeEffects({
    delete: () => { calls.push('delete'); return Promise.resolve({ deleted: true }); },
    list: () => { calls.push('list'); return Promise.resolve([]); },
  }), (version) => {
    assert.equal(version, VERSION);
    return true;
  });
  assert.deepEqual(calls, ['delete', 'list']);
  assert.equal(result.status, 'ok');
  if (result.status === 'ok') assert.deepEqual(result.value, []);
});

void test('purge 错误可见，取消与失败均不触碰当前文档写或刷新', async () => {
  let purges = 0;
  let lists = 0;
  let currentWrites = 0;
  const bridge = makeEffects({
    purge: () => { purges += 1; return Promise.reject(new Error('purge failed')); },
    list: () => { lists += 1; return Promise.resolve(timeline); },
    restore: () => { currentWrites += 1; return Promise.resolve({}); },
    reconcile: () => { currentWrites += 1; return Promise.resolve(); },
    readCurrent: () => { currentWrites += 1; return Promise.resolve({ text: '', sha256: '' }); },
  });
  const cancelled = await purgeHistory(DOC_ID, bridge, () => false);
  const failed = await purgeHistory(DOC_ID, bridge, () => true);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(failed.status, 'error');
  if (failed.status === 'error') assert.match(failed.error, /purge failed/);
  assert.equal(purges, 1);
  assert.equal(lists, 0);
  assert.equal(currentWrites, 0);
});

void test('purge 成功只清空并刷新历史，不写当前文档', async () => {
  const calls: string[] = [];
  const result = await purgeHistory(DOC_ID, makeEffects({
    purge: () => { calls.push('purge'); return Promise.resolve({ deleted: 1 }); },
    list: () => { calls.push('list'); return Promise.resolve([]); },
    restore: () => { calls.push('restore'); return Promise.resolve({}); },
    readCurrent: () => { calls.push('readCurrent'); return Promise.resolve({ text: '', sha256: '' }); },
    reconcile: () => { calls.push('reconcile'); return Promise.resolve(); },
  }), () => true);
  assert.deepEqual(calls, ['purge', 'list']);
  assert.equal(result.status, 'ok');
});
