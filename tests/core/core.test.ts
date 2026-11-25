/**
 * C1 内核基座测试：启动生命周期、错误归因、事件转发、退订与快照去重。
 *
 * 全部依赖注入（FakeVaultPort / FakeEventPort / FakeClock），不碰真实磁盘与真实定时器。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEmberCore, type CoreSnapshot, type EmberCore } from '../../src/core/core.ts';
import { EmberIpcError } from '../../src/core/errors.ts';
import type { CoreErrorEvent, CoreEvent } from '../../src/core/events.ts';
import { createSlice } from '../../src/core/store.ts';
import { FakeCanvasPort, FakeClock, FakeEventPort, FakeVaultPort } from '../kernel/fakes.ts';

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

function hasCode(error: unknown, code: string): boolean {
  return error instanceof EmberIpcError && error.code === code;
}

void test('start：identity + constants 就绪后进入 ready 并广播 core:ready', async () => {
  const { core, vault } = makeHarness();
  const snapshots: CoreSnapshot[] = [];
  const events: CoreEvent[] = [];
  core.subscribe((snapshot) => snapshots.push(snapshot));
  core.events.subscribe((event) => events.push(event));

  assert.equal(core.getSnapshot().status, 'idle');
  await core.start();

  assert.equal(core.getSnapshot().status, 'ready');
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.status),
    ['starting', 'ready'],
  );
  assert.equal(core.getSnapshot().identity?.vaultId, 'vault-test');
  assert.equal(core.getSnapshot().constants?.watcherDebounceMs, 500);
  assert.equal(core.getSnapshot().constants?.maxDocBytes, 16 * 1024 * 1024);
  assert.equal(core.getSnapshot().lastError, null);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'core:ready');
  assert.equal(vault.identityCalls, 1);
  assert.equal(vault.constantsCalls, 1);
});

void test('FakeVaultPort：常量快照与 Rust constants.rs 完整对齐', async () => {
  const vault = new FakeVaultPort();

  assert.deepEqual(await vault.constants(), {
    maxDocBytes: 16 * 1024 * 1024,
    maxImageBytes: 20 * 1024 * 1024,
    maxMediaBytes: 500 * 1024 * 1024,
    historyKeep: 20,
    historyBudgetBytes: 64 * 1024 * 1024,
    trashRetentionDays: 7,
    watcherDebounceMs: 500,
    maxScanDepth: 32,
  });
});

void test('start：identity 失败 → failed + lastError，且不再请求 constants', async () => {
  const { core, vault } = makeHarness();
  vault.failures.set(
    'identity',
    new EmberIpcError('vault_identity', 'E_IO', 'library missing', 'E_IO'),
  );
  const events: CoreEvent[] = [];
  core.events.subscribe((event) => events.push(event));

  await core.start();

  assert.equal(core.getSnapshot().status, 'failed');
  assert.equal(core.getSnapshot().lastError?.code, 'E_IO');
  assert.equal(vault.constantsCalls, 0);
  const errorEvent = events.find((event): event is CoreErrorEvent => event.type === 'core:error');
  assert.ok(errorEvent);
  assert.equal(errorEvent.error.command, 'vault_identity');
  assert.equal(events.some((event) => event.type === 'core:ready'), false);
});

void test('start：非 EmberIpcError 的 rejection 也归一到 EmberIpcError', async () => {
  const { core, vault } = makeHarness();
  // FakeVaultPort 只按 EmberIpcError 注入；这里直接替换方法模拟序列化层的裸 Error 拒绝。
  vault.constants = () => Promise.reject(new Error('constants exploded'));

  await core.start();

  assert.equal(core.getSnapshot().status, 'failed');
  assert.equal(core.getSnapshot().lastError?.code, 'E_UNKNOWN');
  assert.equal(core.getSnapshot().lastError?.message, 'constants exploded');
});

void test('start：先订阅再 scan，扫描期间事件缓冲回放不丢文件', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('initial.md', 'A');
  let releaseScan: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseScan = resolve;
  });
  const originalScan = vault.scan.bind(vault);
  vault.scan = async () => {
    const snapshot = await originalScan();
    await gate;
    return snapshot;
  };

  const starting = core.start();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  vault.seed('during.md', 'B');
  events.emitFileChanged({
    changes: [
      { kind: 'created', path: 'during.md', bytes: 1, sha256: 'sha-during', modifiedMs: 10 },
    ],
  });
  const listenersDuringScan = events.fileChangedListenerCount;
  releaseScan();
  await starting;

  assert.equal(listenersDuringScan, 1);
  assert.equal(core.getIndex().docs.get('during.md')?.sha256, 'sha-during');
  assert.equal(core.getIndex().docs.has('initial.md'), true);
});

void test('start：并发与重复调用复用同一次启动', async () => {
  const { core, vault } = makeHarness();

  await Promise.all([core.start(), core.start()]);
  await core.start();

  assert.equal(core.getSnapshot().status, 'ready');
  assert.equal(vault.identityCalls, 1);
  assert.equal(vault.constantsCalls, 1);
  assert.equal(vault.scanCalls, 1);
});

void test('watch-error：订阅后转发 core:error，dispose 后退订且不再接收', async () => {
  const { core, events } = makeHarness();
  const received: CoreEvent[] = [];
  core.events.subscribe((event) => received.push(event));

  await core.start();
  assert.equal(events.watchErrorListenerCount, 1);

  events.emitWatchError({ code: 'E_IO', message: 'notify queue overflow' });
  const errorEvent = received.find(
    (event): event is CoreErrorEvent =>
      event.type === 'core:error' && event.error.command === 'vault://watch-error',
  );
  assert.ok(errorEvent);
  assert.equal(errorEvent.error.code, 'E_IO');

  const before = received.length;
  core.dispose();

  assert.equal(core.getSnapshot().status, 'disposed');
  assert.equal(events.watchErrorListenerCount, 0);
  assert.equal(received[received.length - 1]?.type, 'core:disposed');

  events.emitWatchError({ code: 'E_IO', message: 'late error' });
  assert.equal(received.length, before + 1);
});

void test('dispose：幂等，且 disposed 之后 start 不再触碰端口', async () => {
  const { core, vault } = makeHarness();
  let disposedEvents = 0;
  core.events.subscribe((event) => {
    if (event.type === 'core:disposed') disposedEvents += 1;
  });

  core.dispose();
  core.dispose();
  await core.start();

  assert.equal(core.getSnapshot().status, 'disposed');
  assert.equal(disposedEvents, 1);
  assert.equal(vault.identityCalls, 0);
  assert.equal(vault.constantsCalls, 0);
});

void test('createSlice：相同引用不通知，替换后按注册顺序通知', () => {
  const slice = createSlice({ value: 1 });
  const order: string[] = [];
  slice.subscribe(() => order.push('first'));
  const offSecond = slice.subscribe(() => order.push('second'));

  const current = slice.getSnapshot();
  slice.set(current);
  assert.deepEqual(order, []);

  slice.set({ value: 2 });
  assert.deepEqual(order, ['first', 'second']);

  offSecond();
  slice.set({ value: 3 });
  assert.deepEqual(order, ['first', 'second', 'first']);
  assert.deepEqual(slice.getSnapshot(), { value: 3 });
});

void test('FakeClock：advance 按到期顺序唤醒 wait，不消耗真实时间', async () => {
  const clock = new FakeClock(1000);
  const order: string[] = [];
  const slow = clock.wait(40).then(() => order.push('slow'));
  const fast = clock.wait(10).then(() => order.push('fast'));

  assert.equal(clock.pendingCount, 2);
  await clock.advance(20);
  assert.deepEqual(order, ['fast']);
  assert.equal(clock.now(), 1020);

  await clock.advance(20);
  assert.deepEqual(order, ['fast', 'slow']);
  assert.equal(clock.now(), 1040);
  assert.equal(clock.pendingCount, 0);
  await Promise.all([slow, fast]);
});

// ------------------------------------------------- 提交 4：EmberCore.canvas 挂载

void test('不传 canvas：P2 既有启动 / 文档写盘 / flushDocs / dispose 行为不变', async () => {
  const { core, vault } = makeHarness();
  vault.seed('a.md', 'v0');

  await core.start();
  assert.equal(core.getSnapshot().status, 'ready');
  assert.equal(core.getIndex().docs.has('a.md'), true);

  await core.openDoc('a.md');
  core.editDoc('a.md', 'v1');
  const outcome = await core.saveDoc('a.md');
  assert.equal(outcome.ok, true);
  assert.equal(vault.writeCalls.length, 1);
  assert.equal(vault.writeCalls[0]?.text, 'v1');

  await core.flushDocs();
  assert.equal(core.getDocument('a.md')?.dirty, false);

  // core.canvas 恒非 null；未注入时为禁用态（详细语义见下一条用例）。
  assert.ok(core.canvas);

  core.dispose();
  assert.equal(core.getSnapshot().status, 'disposed');
});

void test('禁用态 canvas：list / open / save 返回 E_INVALID_ARG，flush 立即 ok 且无待保存项', async () => {
  const { core } = makeHarness();

  await assert.rejects(core.canvas.list(), (error: unknown) => hasCode(error, 'E_INVALID_ARG'));
  await assert.rejects(core.canvas.open('c1'), (error: unknown) => hasCode(error, 'E_INVALID_ARG'));
  await assert.rejects(core.canvas.save('c1', '{}'), (error: unknown) =>
    hasCode(error, 'E_INVALID_ARG'),
  );

  // 禁用态 flush 表示「画布未启用，无待保存内容」，不表示已排空真实队列（CR §7.1 / S1）。
  assert.deepEqual(await core.canvas.flush(), {
    ok: true,
    timedOut: false,
    error: null,
    results: [],
    pendingIds: [],
  });

  // R2：禁用态 store 在 beginClosing 之后 flush 仍立即 ok。
  core.canvas.beginClosing();
  assert.deepEqual(await core.canvas.flush(), {
    ok: true,
    timedOut: false,
    error: null,
    results: [],
    pendingIds: [],
  });
  core.canvas.cancelClosing();
});

void test('注入 canvas：core.canvas 为真实队列，open / save / flush 全部走注入端口', async () => {
  const vault = new FakeVaultPort();
  const events = new FakeEventPort();
  const clock = new FakeClock();
  const port = new FakeCanvasPort();
  const core = createEmberCore({ vault, events, clock, canvas: port });
  port.seed('c1', '{}');

  const opened = await core.canvas.open('c1');
  assert.equal(opened.exists, true);
  assert.equal(opened.text, '{}');

  const saved = await core.canvas.save('c1', '{"n":1}');
  assert.equal(saved.id, 'c1');
  assert.equal(port.files.get('c1')?.text, '{"n":1}');
  assert.equal(port.writeCalls[0]?.expectedSha, opened.sha256);

  const report = await core.canvas.flush();
  assert.equal(report.ok, true);
  assert.equal(report.timedOut, false);
  assert.equal(report.error, null);
  assert.deepEqual(
    report.results.map((result) => result.id),
    ['c1'],
  );
  assert.deepEqual(report.pendingIds, []);

  core.dispose();
});

void test('dispose：canvas.beginClosing 生效，新 save 拒绝 E_CLOSING，已入队任务不被丢弃', async () => {
  const vault = new FakeVaultPort();
  const events = new FakeEventPort();
  const clock = new FakeClock();
  const port = new FakeCanvasPort();
  const core = createEmberCore({ vault, events, clock, canvas: port });
  port.seed('c1', '{}');
  await core.canvas.open('c1');

  const release = port.holdWrite('c1');
  const queued = core.canvas.save('c1', '{"n":1}');

  core.dispose();
  await assert.rejects(core.canvas.save('c1', '{"n":2}'), (error: unknown) =>
    hasCode(error, 'E_CLOSING'),
  );
  assert.equal(port.writeCalls.length, 1, '被拒绝的 save 不得触盘');

  release();
  await queued;
  assert.equal(port.files.get('c1')?.text, '{"n":1}');

  // R2：dispose（beginClosing）之后 flush 仍能收走已入队任务。
  const report = await core.canvas.flush();
  assert.equal(report.ok, true);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0]?.id, 'c1');
  assert.deepEqual(report.pendingIds, []);
});

// ------------------------------------------------ R3-1a：core.writeDocText 带外写入

void test('writeDocText：未打开文档写入成功，索引 sha 前进到落盘版本', async () => {
  const { core, vault } = makeHarness();
  vault.seed('a.md', 'v0');
  await core.start();
  const before = core.getIndex().docs.get('a.md');
  assert.ok(before);

  const result = await core.writeDocText('a.md', 'v1', before.sha256);

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.write.path : null, 'a.md');
  const after = core.getIndex().docs.get('a.md');
  assert.notEqual(after?.sha256, before.sha256);
  assert.equal(after?.sha256, result.ok ? result.write.sha256 : undefined);
  assert.equal(vault.files.get('a.md')?.text, 'v1');
  assert.equal(vault.writeCalls.length, 1);
  assert.equal(vault.writeCalls[0]?.expectedSha, before.sha256);
});

void test('writeDocText：打开且 clean 的文档重读，订阅者收到新正文且 dirty 保持 false', async () => {
  const { core, vault } = makeHarness();
  vault.seed('a.md', 'v0');
  await core.start();
  await core.openDoc('a.md');
  const baseSha = core.getDocument('a.md')?.baseSha;
  const emissions: Array<{ text: string; dirty: boolean }> = [];
  core.subscribeDocuments((docs) => {
    const doc = docs.get('a.md');
    if (doc) emissions.push({ text: doc.text, dirty: doc.dirty });
  });

  const result = await core.writeDocText('a.md', 'v1', baseSha as string);

  assert.equal(result.ok, true);
  assert.equal(vault.files.get('a.md')?.text, 'v1');
  const doc = core.getDocument('a.md');
  assert.equal(doc?.text, 'v1');
  assert.equal(doc?.dirty, false);
  assert.equal(doc?.baseSha, result.ok ? result.write.sha256 : undefined);
  assert.ok(emissions.some((e) => e.text === 'v1' && e.dirty === false));
});

void test('writeDocText：打开且 dirty 的文档拒写为 dirty，且不调用 vault.write', async () => {
  const { core, vault } = makeHarness();
  vault.seed('a.md', 'v0');
  await core.start();
  await core.openDoc('a.md');
  core.editDoc('a.md', 'dirty-text');
  assert.equal(core.getDocument('a.md')?.dirty, true);
  const baseSha = core.getDocument('a.md')?.baseSha;
  const before = vault.writeCalls.length;

  const result = await core.writeDocText('a.md', 'v1', baseSha as string);

  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.reason, 'dirty');
  assert.equal(vault.writeCalls.length, before);
  assert.equal(vault.files.get('a.md')?.text, 'v0');
});

void test('writeDocText：打开且 saving 的文档拒写为 dirty，且不调用 vault.write', async () => {
  const { core, vault } = makeHarness();
  vault.seed('a.md', 'v0');
  await core.start();
  await core.openDoc('a.md');
  core.editDoc('a.md', 'dirty-text');
  // 不推进时钟，触发一次保存使其进入 saving 但未结算。
  const saving = core.saveDoc('a.md');
  assert.equal(core.getDocument('a.md')?.saving, true);
  const before = vault.writeCalls.length;

  const result = await core.writeDocText('a.md', 'v1', 'ignored');

  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.reason, 'dirty');
  assert.equal(vault.writeCalls.length, before);
  await saving;
});

void test('writeDocText：expectedSha 不符返回 conflict，磁盘与索引不动', async () => {
  const { core, vault } = makeHarness();
  vault.seed('a.md', 'v0');
  await core.start();
  const before = core.getIndex().docs.get('a.md');

  const result = await core.writeDocText('a.md', 'v1', 'sha-that-does-not-match');

  assert.equal(result.ok, false);
  if (!result.ok && result.reason !== 'dirty') {
    assert.equal(result.reason, 'conflict');
    assert.equal(result.error.code, 'E_INVALID_ARG');
  }
  assert.equal(vault.files.get('a.md')?.text, 'v0');
  assert.equal(core.getIndex().docs.get('a.md')?.sha256, before?.sha256);
});

void test('writeDocText：非冲突写错误返回 io，不抛错', async () => {
  const { core, vault } = makeHarness();
  vault.seed('a.md', 'v0');
  vault.failures.set(
    'write',
    new EmberIpcError('vault_write', 'E_DISK_FULL', 'disk full', 'E_DISK_FULL'),
  );
  await core.start();
  const baseSha = core.getIndex().docs.get('a.md')?.sha256;

  const result = await core.writeDocText('a.md', 'v1', baseSha as string);

  assert.equal(result.ok, false);
  if (!result.ok && result.reason !== 'dirty') {
    assert.equal(result.reason, 'io');
    assert.equal(result.error.code, 'E_DISK_FULL');
  }
});
