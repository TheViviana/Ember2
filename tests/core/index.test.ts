/**
 * C2 索引与目录树测试：scan 全量建索引、派生树稳定性、file-changed 增量补丁。
 *
 * 纯函数部分直接测 `vault-index`；集成部分经 FakeVaultPort / FakeEventPort 驱动 core，
 * 不碰真实磁盘、不碰 Tauri、不消耗真实时间。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createEmberCore, type EmberCore } from '../../src/core/core.ts';
import { EmberIpcError } from '../../src/core/errors.ts';
import type { CoreEvent } from '../../src/core/events.ts';
import {
  applyFileChanges,
  createIndex,
  type VaultIndexSnapshot,
} from '../../src/core/vault-index.ts';
import { FakeClock, FakeEventPort, FakeVaultPort } from '../kernel/fakes.ts';

interface Harness {
  core: EmberCore;
  vault: FakeVaultPort;
  events: FakeEventPort;
  clock: FakeClock;
}

function makeHarness(): Harness {
  const vault = new FakeVaultPort();
  const events = new FakeEventPort();
  const clock = new FakeClock();
  const core = createEmberCore({ vault, events, clock });
  return { core, vault, events, clock };
}

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function size(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** 快照路径的扁平有序视图，用于断言 docs 的集合与排序。 */
function sortedPaths(snapshot: VaultIndexSnapshot): string[] {
  return [...snapshot.docs.keys()].sort();
}

function scanEntry(path: string) {
  return { path, bytes: 1, sha256: `sha-${path}`, modifiedMs: 1 };
}

// ------------------------------------------------------------- vault-index 纯函数

void test('createIndex：扫描条目全收，不做扩展名或深度过滤', () => {
  const index = createIndex(
    [
      scanEntry('b.md'),
      scanEntry('notes/z.md'),
      scanEntry('notes/a.md'),
      scanEntry('notes/sub/x.md'),
      scanEntry('a.md'),
      scanEntry('Foo.MD'),
      scanEntry('deep/1/2/x.md'),
      scanEntry('diagram.png'),
    ],
  );

  assert.deepEqual([...index.docs.keys()].sort(), [
    'Foo.MD',
    'a.md',
    'b.md',
    'deep/1/2/x.md',
    'diagram.png',
    'notes/a.md',
    'notes/sub/x.md',
    'notes/z.md',
  ]);
  assert.deepEqual(sortedPaths(index), [
    'Foo.MD',
    'a.md',
    'b.md',
    'deep/1/2/x.md',
    'diagram.png',
    'notes/a.md',
    'notes/sub/x.md',
    'notes/z.md',
  ]);
});

void test('applyFileChanges：created / updated / removed / renamed 增量维护快照', () => {
  const base = createIndex(
    [{ path: 'a.md', bytes: 1, sha256: 'sha-a', modifiedMs: 1 }],
  );

  const created = applyFileChanges(
    base,
    [{ kind: 'created', path: 'dir/b.md', bytes: 2, sha256: 'sha-b', modifiedMs: 2 }],
  );
  assert.equal(created.changed, true);
  assert.deepEqual([...created.snapshot.docs.keys()].sort(), ['a.md', 'dir/b.md']);
  assert.deepEqual(sortedPaths(created.snapshot), ['a.md', 'dir/b.md']);

  const same = applyFileChanges(
    created.snapshot,
    [{ kind: 'updated', path: 'dir/b.md', bytes: 2, sha256: 'sha-b', modifiedMs: 2 }],
  );
  assert.equal(same.changed, false);
  assert.equal(same.snapshot, created.snapshot);

  const updated = applyFileChanges(
    created.snapshot,
    [{ kind: 'updated', path: 'a.md', bytes: 9, sha256: 'sha-a2', modifiedMs: 3 }],
  );
  assert.equal(updated.changed, true);
  assert.equal(updated.snapshot.docs.get('a.md')?.sha256, 'sha-a2');

  const renamed = applyFileChanges(
    updated.snapshot,
    [
      {
        kind: 'renamed',
        from: 'dir/b.md',
        path: 'dir/c.md',
        bytes: 2,
        sha256: 'sha-b',
        modifiedMs: 4,
      },
    ],
  );
  assert.equal(renamed.changed, true);
  assert.equal(renamed.snapshot.docs.has('dir/b.md'), false);
  assert.equal(renamed.snapshot.docs.get('dir/c.md')?.modifiedMs, 4);

  const removed = applyFileChanges(
    renamed.snapshot,
    [{ kind: 'removed', path: 'dir/c.md' }],
  );
  assert.equal(removed.changed, true);
  assert.deepEqual([...removed.snapshot.docs.keys()], ['a.md']);
  assert.deepEqual(sortedPaths(removed.snapshot), ['a.md']);
});

void test('applyFileChanges：同批去重且不过滤路径，缺哈希条目无法更新', () => {
  const base = createIndex(
    [
      { path: 'a.md', bytes: 1, sha256: 'sha-a', modifiedMs: 1 },
      { path: 'keep/x.md', bytes: 1, sha256: 'sha-x', modifiedMs: 1 },
    ],
  );

  const withPaths = applyFileChanges(
    base,
    [
      { kind: 'created', path: 'image.png', bytes: 1, sha256: 's', modifiedMs: 1 },
      { kind: 'created', path: '.hidden.md', bytes: 1, sha256: 's', modifiedMs: 1 },
      { kind: 'created', path: 'media/x.md', bytes: 1, sha256: 's', modifiedMs: 1 },
      { kind: 'created', path: 'no-hash.md', bytes: 1, modifiedMs: 1 },
    ],
  );
  assert.equal(withPaths.changed, true);
  assert.equal(withPaths.snapshot.docs.has('image.png'), true);
  assert.equal(withPaths.snapshot.docs.has('.hidden.md'), true);
  assert.equal(withPaths.snapshot.docs.has('media/x.md'), true);
  assert.equal(withPaths.snapshot.docs.has('no-hash.md'), false);

  const deduped = applyFileChanges(
    base,
    [
      { kind: 'created', path: 'x.md', bytes: 1, sha256: 's1', modifiedMs: 1 },
      { kind: 'removed', path: 'x.md' },
    ],
  );
  assert.equal(deduped.changed, false);
  assert.equal(deduped.snapshot, base);

  const renamedOut = applyFileChanges(
    base,
    [
      {
        kind: 'renamed',
        from: 'keep/x.md',
        path: 'keep/x.txt',
        bytes: 1,
        sha256: 'sha-x',
        modifiedMs: 2,
      },
    ],
  );
  assert.equal(renamedOut.changed, true);
  assert.deepEqual([...renamedOut.snapshot.docs.keys()], ['a.md', 'keep/x.txt']);
});

// -------------------------------------------------------------------- core 接线

void test('start：vault_scan 建立索引并通知索引订阅者', async () => {
  const { core, vault } = makeHarness();
  vault.seed('b.md', 'B');
  vault.seed('notes/a.md', 'A');
  const indexes: VaultIndexSnapshot[] = [];
  core.subscribeIndex((index) => indexes.push(index));

  await core.start();

  assert.equal(vault.scanCalls, 1);
  assert.deepEqual([...core.getIndex().docs.keys()].sort(), ['b.md', 'notes/a.md']);
  assert.equal(indexes.length, 1);
  assert.equal(core.getIndex(), indexes[0]);
  assert.deepEqual(sortedPaths(core.getIndex()), ['b.md', 'notes/a.md']);
});

void test('start：scan 失败 → failed + core:error(vault_scan)，索引保持为空', async () => {
  const { core, vault } = makeHarness();
  vault.failures.set(
    'scan',
    new EmberIpcError('vault_scan', 'E_IO', 'scan exploded', 'E_IO'),
  );
  const events: CoreEvent[] = [];
  core.events.subscribe((event) => events.push(event));

  await core.start();

  assert.equal(core.getSnapshot().status, 'failed');
  assert.equal(core.getSnapshot().lastError?.command, 'vault_scan');
  assert.equal(core.getIndex().docs.size, 0);
  assert.equal(events.some((event) => event.type === 'core:ready'), false);
});

void test('file-changed：批量增量更新索引，按 path 去重且无差异不通知', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('a.md', 'A');
  await core.start();
  assert.equal(events.fileChangedListenerCount, 1);

  let notifications = 0;
  core.subscribeIndex(() => {
    notifications += 1;
  });

  events.emitFileChanged({
    changes: [
      { kind: 'created', path: 'dir/b.md', bytes: size('B'), sha256: sha('B'), modifiedMs: 10 },
      { kind: 'created', path: 'dir/b.md', bytes: size('B2'), sha256: sha('B2'), modifiedMs: 11 },
    ],
  });
  assert.equal(core.getIndex().docs.get('dir/b.md')?.sha256, sha('B2'));
  assert.equal(notifications, 1);

  events.emitFileChanged({
    changes: [
      {
        kind: 'updated',
        path: 'dir/b.md',
        bytes: size('B2'),
        sha256: sha('B2'),
        modifiedMs: 11,
      },
    ],
  });
  assert.equal(notifications, 1);

  events.emitFileChanged({
    changes: [
      {
        kind: 'renamed',
        from: 'a.md',
        path: 'moved/a.md',
        bytes: size('A'),
        sha256: sha('A'),
        modifiedMs: 12,
      },
    ],
  });
  assert.equal(core.getIndex().docs.has('a.md'), false);
  assert.equal(core.getIndex().docs.get('moved/a.md')?.sha256, sha('A'));
  assert.equal(notifications, 2);

  events.emitFileChanged({
    changes: [
      { kind: 'removed', path: 'moved/a.md' },
      { kind: 'created', path: 'media/skip.md', bytes: 1, sha256: 's', modifiedMs: 13 },
    ],
  });
  assert.equal(core.getIndex().docs.has('moved/a.md'), false);
  assert.equal(core.getIndex().docs.has('media/skip.md'), true);
  assert.equal(notifications, 3);
});

void test('dispose：退订 file-changed，之后事件不再改动索引', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('a.md', 'A');
  await core.start();
  assert.equal(events.fileChangedListenerCount, 1);

  core.dispose();
  assert.equal(events.fileChangedListenerCount, 0);
  assert.equal(events.watchErrorListenerCount, 0);

  events.emitFileChanged({
    changes: [{ kind: 'created', path: 'b.md', bytes: 1, sha256: 's', modifiedMs: 1 }],
  });
  assert.equal(core.getIndex().docs.has('b.md'), false);
});
