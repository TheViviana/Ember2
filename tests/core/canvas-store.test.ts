/**
 * 提交 3：CanvasPort 与 per-id 保存队列（CR-20261116-02 §7 / §11.2）。
 *
 * 全部走内存 FakeCanvasPort + FakeClock：写盘时序由 `holdWrite(id)` 手工控制，
 * 超时只推进假时间。断言重点：同 id 串行且第二次见第一次 sha、跨 id 不互阻、
 * 结算时机、关窗队列语义、flush 排空/超时/失败不静默、E_DISK_FULL 可恢复。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { EmberIpcError } from '../../src/core/errors.ts';
import type { CanvasStore } from '../../src/core/canvas/ports.ts';
import { createCanvasStore, CANVAS_FLUSH_TIMEOUT_MS } from '../../src/core/canvas/store.ts';
import { FakeCanvasPort, FakeClock } from '../kernel/fakes.ts';

interface Harness {
  port: FakeCanvasPort;
  clock: FakeClock;
  store: CanvasStore;
}

function makeHarness(flushTimeoutMs?: number): Harness {
  const port = new FakeCanvasPort();
  const clock = new FakeClock(1_700_000_000_000);
  const store = createCanvasStore({ port, clock, flushTimeoutMs });
  return { port, clock, store };
}

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 排空微任务链（读盘 / 写盘完成回调）；不消耗真实时间。 */
function settle(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof EmberIpcError && error.code === code;
}

// ---------------------------------------------------------------- 队列语义

void test('同 id 串行：第二次 save 能看到第一次写入的 sha', async () => {
  const { port, store } = makeHarness();
  port.seed('c1', '{}');
  await store.open('c1');

  const first = store.save('c1', '{"n":1}');
  const second = store.save('c1', '{"n":2}');
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(port.writeCalls.length, 2);
  assert.equal(port.writeCalls[0]?.expectedSha, sha('{}'), '第一次用 open 读到的 sha');
  assert.equal(
    port.writeCalls[1]?.expectedSha,
    firstResult.sha256,
    '第二次必须看到第一次落盘后的 sha',
  );
  assert.equal(secondResult.sha256, sha('{"n":2}'));
  assert.equal(port.files.get('c1')?.text, '{"n":2}');
});

void test('跨 id 无全局锁且真交错：A 被 gate 卡住时 B 先完成', async () => {
  const { port, store } = makeHarness();
  port.seed('a', '{}');
  port.seed('b', '{}');
  await Promise.all([store.open('a'), store.open('b')]);

  const release = port.holdWrite('a');
  const slow = store.save('a', '{"a":1}');
  const fast = store.save('b', '{"b":1}');
  assert.deepEqual(
    port.writeCalls.map((call) => call.id),
    ['a', 'b'],
    '两个 id 的写已在同一轮微任务内并发提交',
  );

  const fastResult = await fast;
  assert.equal(fastResult.sha256, sha('{"b":1}'), 'b 不应等待 a');
  assert.equal(port.files.get('a')?.text, '{}', '此时 a 仍被 gate 卡住：B 先完成、A 后完成');

  release();
  const slowResult = await slow;
  assert.equal(slowResult.sha256, sha('{"a":1}'));
});

void test('save 结算时机：写盘完成后才 resolve，不是入队即 resolve', async () => {
  const { port, store } = makeHarness();
  port.seed('c1', '{}');
  await store.open('c1');

  const release = port.holdWrite('c1');
  let state = 'pending';
  const saving = store.save('c1', '{"n":1}');
  void saving.then(
    () => {
      state = 'resolved';
    },
    () => {
      state = 'rejected';
    },
  );

  await settle();
  assert.equal(state, 'pending', '写盘未完成前不得结算');
  assert.equal(port.files.get('c1')?.text, '{}');

  release();
  await saving;
  assert.equal(state, 'resolved');
  assert.equal(port.files.get('c1')?.text, '{"n":1}');
});

void test('save 未 open：立即 E_INVALID_ARG，不触盘', async () => {
  const { port, store } = makeHarness();

  await assert.rejects(
    store.save('never-opened', '{}'),
    (error: unknown) => hasCode(error, 'E_INVALID_ARG'),
  );
  assert.equal(port.writeCalls.length, 0);
});

void test('open 缺失画布返回 exists:false 与空 sha 哨兵', async () => {
  const { port, store } = makeHarness();

  const opened = await store.open('missing');
  assert.deepEqual(opened, { exists: false, text: null, sha256: '', modifiedMs: null });

  const saved = await store.save('missing', '{}');
  assert.equal(port.writeCalls[0]?.expectedSha, '', '期望不存在用空串哨兵');
  assert.equal(saved.sha256, sha('{}'));
});

// ------------------------------------------------------------------ 关窗

void test('beginClosing：已入队继续执行，新 save 立即 E_CLOSING，cancelClosing 可恢复', async () => {
  const { port, store } = makeHarness();
  port.seed('c1', '{}');
  await store.open('c1');

  const release = port.holdWrite('c1');
  const queued = store.save('c1', '{"n":1}');
  store.beginClosing();

  await assert.rejects(
    store.save('c1', '{"n":2}'),
    (error: unknown) => hasCode(error, 'E_CLOSING'),
  );
  assert.equal(port.writeCalls.length, 1, '被拒绝的 save 不得触盘');

  release();
  await queued;
  assert.equal(port.files.get('c1')?.text, '{"n":1}', '已入队任务必须跑完');
  const report = await store.flush();
  assert.equal(report.ok, true);
  assert.equal(report.results.length, 1, '已入队任务必须由 flush 汇总');

  store.cancelClosing();
  const resumed = await store.save('c1', '{"n":2}');
  assert.equal(resumed.sha256, sha('{"n":2}'));
});

// ------------------------------------------------------------------ flush

void test('flush 排空：返回逐项结果，pendingIds 为空', async () => {
  const { port, store } = makeHarness();
  port.seed('c1', '{}');
  port.seed('c2', '{}');
  await Promise.all([store.open('c1'), store.open('c2')]);

  const first = store.save('c1', '{"n":1}');
  const second = store.save('c2', '{"n":2}');
  const report = await store.flush();

  assert.equal(report.ok, true);
  assert.equal(report.timedOut, false);
  assert.equal(report.error, null);
  assert.deepEqual(report.pendingIds, []);
  assert.equal(report.results.length, 2);
  assert.deepEqual(
    report.results.map((result) => result.id).sort(),
    ['c1', 'c2'],
  );
  await Promise.all([first, second]);
});

void test('flush 超时：返回 E_FLUSH_TIMEOUT 且不误报成功，后续 flush 能收到迟到结果', async () => {
  const { port, clock, store } = makeHarness();
  port.seed('c1', '{}');
  await store.open('c1');

  const release = port.holdWrite('c1');
  const saving = store.save('c1', '{"n":1}');
  const flush = store.flush();

  await settle();
  let flushSettled = false;
  void flush.then(() => {
    flushSettled = true;
  });
  await settle();
  assert.equal(flushSettled, false, '未超时前 flush 不得返回');

  await clock.advance(CANVAS_FLUSH_TIMEOUT_MS);
  const report = await flush;
  assert.equal(report.ok, false);
  assert.equal(report.timedOut, true);
  assert.equal(report.error?.code, 'E_FLUSH_TIMEOUT');
  assert.deepEqual(report.pendingIds, ['c1']);
  assert.deepEqual(report.results, [], '未结算的 save 不得伪造成成功');

  release();
  await saving;

  const next = await store.flush();
  assert.equal(next.timedOut, false);
  assert.equal(next.ok, true, '迟到结果必须被下一次 flush 收走');
  assert.equal(next.results.length, 1);
});

void test('flush 失败不静默：失败的 save 出现在 results 中并带原始错误码', async () => {
  const { port, store } = makeHarness();
  port.seed('c1', '{}');
  await store.open('c1');

  port.failNext('write', new EmberIpcError('canvas_write', 'E_IO', 'disk exploded', 'E_IO'));
  await assert.rejects(
    store.save('c1', '{"n":1}'),
    (error: unknown) => hasCode(error, 'E_IO'),
  );

  const report = await store.flush();
  assert.equal(report.ok, false);
  assert.equal(report.timedOut, false, '失败不是超时');
  assert.equal(report.error?.code, 'E_IO');
  assert.equal(report.results.length, 1);
  const [failure] = report.results;
  assert.equal(failure?.ok, false);
  assert.equal(failure?.ok === false ? failure.error.code : null, 'E_IO');
});

void test('E_DISK_FULL 可恢复：不重试、不降级、不丢弃，重试仍用旧 sha', async () => {
  const { port, store } = makeHarness();
  port.seed('c1', '{}');
  await store.open('c1');

  port.failNext(
    'write',
    new EmberIpcError('canvas_write', 'E_DISK_FULL', 'no space left', 'E_DISK_FULL'),
  );
  await assert.rejects(
    store.save('c1', '{"n":1}'),
    (error: unknown) => hasCode(error, 'E_DISK_FULL'),
  );
  assert.equal(port.writeCalls.length, 1, '不得静默重试');

  const report = await store.flush();
  const failure = report.results.find((result) => !result.ok);
  assert.ok(failure, '失败的 save 必须出现在 flush.results');
  assert.equal(failure?.ok === false ? failure.error.code : null, 'E_DISK_FULL', '不得降级为 E_IO');

  // 失败后 sha 未推进：重试仍以 open 时的 sha 作为 expectedSha，可恢复。
  const retried = await store.save('c1', '{"n":1}');
  assert.equal(port.writeCalls[1]?.expectedSha, sha('{}'));
  assert.equal(retried.sha256, sha('{"n":1}'));
});

// ------------------------------------------------------- 冲突与 list 透传

void test('E_CONFLICT 保留 currentSha，且不推进本地 sha', async () => {
  const { port, store } = makeHarness();
  port.seed('c1', '{}');
  await store.open('c1');
  // 模拟外部写入：磁盘版本前进了，本地仍记着旧 sha。
  port.seed('c1', '{"external":true}');

  const error = await store.save('c1', '{"local":1}').then(
    () => null,
    (rejection: unknown) => rejection,
  );
  assert.ok(error instanceof EmberIpcError);
  assert.equal(error.code, 'E_CONFLICT');
  assert.equal(error.currentSha, sha('{"external":true}'));

  const report = await store.flush();
  assert.equal(report.results.length, 1);
  assert.equal(report.ok, false);

  const reopened = await store.open('c1');
  assert.equal(reopened.sha256, sha('{"external":true}'));
  const applied = await store.save('c1', '{"local":1}');
  assert.equal(applied.sha256, sha('{"local":1}'));
});

void test('flush 不被已重试成功覆盖的旧失败污染：E_CONFLICT 后重试成功 → flush ok', async () => {
  const { port, store } = makeHarness();
  port.seed('c1', '{}');
  await store.open('c1');

  // 模拟外部写入推进磁盘版本，本地 save 触发 E_CONFLICT。
  port.seed('c1', '{"external":true}');
  await assert.rejects(
    store.save('c1', '{"local":1}'),
    (error: unknown) => hasCode(error, 'E_CONFLICT'),
  );
  // 关键：此处不调用 flush()，复现 resolveConflict('keep-local') 路径——
  // 旧失败结果留在 settled，等待下一次 flush 消费。

  // 重试：open 刷新 core 内部 sha 后用本地文档覆盖外部版本（同 document-controller）。
  await store.open('c1');
  const retried = await store.save('c1', '{"local":1}');
  assert.equal(retried.sha256, sha('{"local":1}'));

  const report = await store.flush();
  assert.equal(report.ok, true, '重试成功后旧冲突不得污染 flush 判定');
  assert.equal(report.timedOut, false);
  assert.equal(report.error, null);
  // 失败不静默：旧失败结果仍在 results 可查，且成功结果也在。
  const failure = report.results.find((result) => !result.ok);
  assert.ok(failure, '旧失败结果必须仍出现在 results（禁止静默丢弃）');
  assert.equal(failure?.ok === false ? failure.error.code : null, 'E_CONFLICT');
  assert.ok(report.results.some((result) => result.ok), '重试成功结果必须在 results');
});

void test('flush 失败判定按 id 隔离：他 id 成功不得覆盖本 id 未重试的失败', async () => {
  const { port, store } = makeHarness();
  port.seed('a', '{}');
  port.seed('b', '{}');
  await Promise.all([store.open('a'), store.open('b')]);

  // a 失败（E_IO）且无后续成功；b 成功。a 的失败不得被 b 的成功覆盖。
  port.failNext('write', new EmberIpcError('canvas_write', 'E_IO', 'a disk exploded', 'E_IO'));
  await assert.rejects(
    store.save('a', '{"a":1}'),
    (error: unknown) => hasCode(error, 'E_IO'),
  );
  const bResult = await store.save('b', '{"b":1}');
  assert.equal(bResult.sha256, sha('{"b":1}'));

  const report = await store.flush();
  assert.equal(report.ok, false, 'a 的失败未被同 id 成功覆盖，必须仍报失败');
  assert.equal(report.timedOut, false);
  assert.equal(report.error?.code, 'E_IO');
});

void test('list 透传 valid:false 条目，不做过滤', async () => {
  const { port, store } = makeHarness();
  port.entries = [
    {
      id: 'good',
      valid: true,
      path: '.workbench/canvas/good.canvas.json',
      bytes: 2,
      modifiedMs: 1,
    },
    { id: 'bad.id', valid: false, reason: 'bad_id', modifiedMs: 2 },
  ];

  const entries = await store.list();
  assert.equal(port.listCalls, 1);
  assert.equal(entries.length, 2);
  const invalid = entries.find((entry) => entry.id === 'bad.id');
  assert.equal(invalid?.valid, false);
  assert.equal(invalid?.reason, 'bad_id');
  assert.equal(invalid?.path, undefined);
});
