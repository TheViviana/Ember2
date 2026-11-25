import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultImportTarget,
  runImport,
  type ImportCallResult,
} from '../../../src/features/import/import-runner.ts';

function result(sourcePath: string): ImportCallResult {
  if (sourcePath.includes('skip')) return { status: 'skipped', path: null, bytes: 0, sha: null };
  return { status: 'imported', path: `documents/${sourcePath.split('/').pop()}`, bytes: 3, sha: 'abc' };
}

void test('成功、跳过与单项失败分别计数，成功路径逐项对账', async () => {
  const reconciled: string[] = [];
  const run = await runImport(['/tmp/a.md', '/tmp/skip.md', '/tmp/bad.md'], 'documents', 'skip', {
    flush: () => Promise.resolve(),
    importFile: (path) => path.includes('bad')
      ? Promise.reject(new Error('bad utf8'))
      : Promise.resolve(result(path)),
    reconcile: (path) => { reconciled.push(path); return Promise.resolve(); },
  }, { onChange: () => {}, shouldCancel: () => false });
  assert.deepEqual([run.imported, run.skipped, run.failed, run.cancelled, run.fatalError], [1, 1, 1, false, null]);
  assert.deepEqual(reconciled, ['documents/a.md']);
});

void test('取消只阻止后续文件，已导入项不回滚', async () => {
  const calls: string[] = [];
  let cancel = false;
  const run = await runImport(['/tmp/a.md', '/tmp/b.md', '/tmp/c.md'], '', 'rename', {
    flush: () => Promise.resolve(),
    importFile: (path) => { calls.push(path); cancel = true; return Promise.resolve(result(path)); },
    reconcile: () => Promise.resolve(),
  }, { onChange: () => {}, shouldCancel: () => cancel });
  assert.deepEqual(calls, ['/tmp/a.md']);
  assert.equal(run.imported, 1);
  assert.equal(run.cancelled, true);
  assert.equal(run.items[1]?.status, 'pending');
});

void test('flush 失败在零写入时中止', async () => {
  let writes = 0;
  const run = await runImport(['/tmp/a.md'], '', 'skip', {
    flush: () => Promise.reject(new Error('dirty save failed')),
    importFile: () => { writes += 1; return Promise.resolve(result('/tmp/a.md')); },
    reconcile: () => Promise.resolve(),
  }, { onChange: () => {}, shouldCancel: () => false });
  assert.equal(writes, 0);
  assert.match(run.fatalError ?? '', /导入未开始/);
});

void test('reconcile 失败可见且停止后续写入', async () => {
  let writes = 0;
  const run = await runImport(['/tmp/a.md', '/tmp/b.md'], '', 'skip', {
    flush: () => Promise.resolve(),
    importFile: (path) => { writes += 1; return Promise.resolve(result(path)); },
    reconcile: () => Promise.reject(new Error('reload failed')),
  }, { onChange: () => {}, shouldCancel: () => false });
  assert.equal(writes, 1);
  assert.equal(run.imported, 1);
  assert.match(run.fatalError ?? '', /同步打开文档失败/);
});

void test('默认目标使用活动文档目录，无上下文时回退 documents', () => {
  assert.equal(defaultImportTarget(null), 'documents/');
  assert.equal(defaultImportTarget('notes/a.md'), 'notes');
  assert.equal(defaultImportTarget('a.md'), '');
});
