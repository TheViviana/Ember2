/**
 * C3 写队列与冲突矩阵测试。
 *
 * 全部走内存 VaultPort + FakeClock：防抖只推进假时间，写盘的并发时序由手工 gate 控制。
 * 断言重点：单飞 / 同路径合并、回声抑制、冲突矩阵（绝不覆盖 dirty 正文）、
 * 事件路径永不写盘、E_READONLY 全局锁写。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createEmberCore, type EmberCore } from '../../src/core/core.ts';
import { EmberIpcError } from '../../src/core/errors.ts';
import { conflictCopyPath, conflictStamp } from '../../src/core/conflict.ts';
import { migrateDocumentPath } from '../../src/core/doc-migrate.ts';
import type { FileChangeDto } from '../../src/types/ipc.ts';
import { createWriter } from '../../src/core/writer.ts';
import { FakeClock, FakeEventPort, FakeVaultPort } from '../kernel/fakes.ts';

interface Harness {
  core: EmberCore;
  vault: FakeVaultPort;
  events: FakeEventPort;
  clock: FakeClock;
}

function makeHarness(autoSaveDelayMs = 1000): Harness {
  const vault = new FakeVaultPort();
  const events = new FakeEventPort();
  // 固定起点让冲突副本时间戳可预期；时区差异只影响具体数字，不影响断言。
  const clock = new FakeClock(1_700_000_000_000);
  const core = createEmberCore({ vault, events, clock, autoSaveDelayMs });
  return { core, vault, events, clock };
}

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function size(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function updated(path: string, text: string, modifiedMs = 99): FileChangeDto {
  return { kind: 'updated', path, bytes: size(text), sha256: sha(text), modifiedMs };
}

/** 排空微任务链（读盘 / 写盘完成回调）；不消耗真实时间。 */
function settle(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settleGate) => {
    resolve = settleGate;
  });
  return { promise, resolve };
}

// ------------------------------------------------------------------ 打开

void test('open：并发打开复用一次读盘，正文与 baseSha 对齐', async () => {
  const { core, vault } = makeHarness();
  vault.seed('notes/a.md', 'A');
  await core.start();

  const [first, second] = await Promise.all([
    core.openDoc('notes/a.md'),
    core.openDoc('notes/a.md'),
  ]);

  assert.equal(vault.readCalls.length, 1);
  assert.equal(first.text, 'A');
  assert.equal(second.text, 'A');
  assert.equal(first.dirty, false);
  assert.equal(first.baseSha, sha('A'));
  assert.equal(core.getDocuments().size, 1);
});

// -------------------------------------------------------------- 写盘与防抖

void test('edit：防抖窗口内多次编辑只写一次，写入最新正文并同步索引', async () => {
  const { core, vault, clock } = makeHarness(1000);
  vault.seed('a.md', 'v0');
  await core.start();
  await core.openDoc('a.md');

  core.editDoc('a.md', 'v1');
  core.editDoc('a.md', 'v2');
  assert.equal(core.getDocument('a.md')?.dirty, true);
  assert.equal(vault.writeCalls.length, 0);

  await clock.advance(999);
  assert.equal(vault.writeCalls.length, 0);

  await clock.advance(1);
  assert.equal(vault.writeCalls.length, 1);
  assert.equal(vault.writeCalls[0]?.text, 'v2');

  const doc = core.getDocument('a.md');
  assert.equal(doc?.dirty, false);
  assert.equal(doc?.baseSha, sha('v2'));
  assert.equal(vault.files.get('a.md')?.text, 'v2');
  assert.equal(core.getIndex().docs.get('a.md')?.sha256, sha('v2'));
});

void test('save：显式保存立即写盘并取消防抖，不会二次写', async () => {
  const { core, vault, clock } = makeHarness(1000);
  vault.seed('a.md', 'v0');
  await core.start();
  await core.openDoc('a.md');

  core.editDoc('a.md', 'v1');
  const outcome = await core.saveDoc('a.md');
  assert.equal(outcome.ok, true);
  assert.equal(vault.writeCalls.length, 1);

  await clock.advance(2000);
  assert.equal(vault.writeCalls.length, 1);
});

void test('flush：立即提交防抖期脏文档，排空后 clean 且不重复写', async () => {
  const { core, vault, clock } = makeHarness(1000);
  vault.seed('a.md', 'v0');
  await core.start();
  await core.openDoc('a.md');

  core.editDoc('a.md', 'latest');
  assert.equal(vault.writeCalls.length, 0);
  await core.flushDocs();

  assert.equal(vault.writeCalls.length, 1);
  assert.equal(vault.writeCalls[0]?.text, 'latest');
  assert.equal(core.getDocument('a.md')?.dirty, false);
  await clock.advance(2000);
  assert.equal(vault.writeCalls.length, 1);
});

void test('flush：写盘期间的新输入在第二轮捕捉并落盘', async () => {
  const { core, vault } = makeHarness(1000);
  vault.seed('a.md', 'v0');
  await core.start();
  await core.openDoc('a.md');

  const gate = deferred();
  const started = deferred();
  const original = vault.write.bind(vault);
  let calls = 0;
  vault.write = async (path, text, expectedSha) => {
    calls += 1;
    if (calls === 1) {
      started.resolve();
      await gate.promise;
    }
    return original(path, text, expectedSha);
  };

  core.editDoc('a.md', 'v1');
  const flushing = core.flushDocs();
  await started.promise;
  // 首轮写盘在飞时继续输入：不能因为入口快照已经保存过就关闭窗口。
  core.editDoc('a.md', 'v2');
  gate.resolve();
  await flushing;

  assert.equal(vault.writeCalls.length, 2, '第二轮必须补写新正文');
  assert.equal(vault.files.get('a.md')?.text, 'v2');
  assert.equal(core.getDocument('a.md')?.dirty, false);
});

void test('flush：持续输入三轮后抛错取消关窗，不静默丢字', async () => {
  const { core, vault } = makeHarness(1000);
  vault.seed('a.md', 'v0');
  await core.start();
  await core.openDoc('a.md');

  const original = vault.write.bind(vault);
  vault.write = async (path, text, expectedSha) => {
    const result = await original(path, text, expectedSha);
    // 每次写盘落地后都继续产生新输入，模拟锁生效前的编辑流。
    core.editDoc(path, `${text}+`);
    return result;
  };

  core.editDoc('a.md', 'v1');
  await assert.rejects(core.flushDocs(), (error: unknown) => {
    assert.ok(error instanceof EmberIpcError);
    assert.equal(error.code, 'E_INVALID_ARG');
    return true;
  });
  assert.equal(vault.writeCalls.length, 3, '最多三轮，仍 dirty 就取消关窗');
  assert.equal(core.getDocument('a.md')?.dirty, true);
});

void test('write queue：全局单飞，A 在飞时 B 排队等待', async () => {
  const { core, vault } = makeHarness();
  vault.seed('a.md', 'A0');
  vault.seed('b.md', 'B0');
  await core.start();
  await core.openDoc('a.md');
  await core.openDoc('b.md');

  const gate = deferred();
  const started: string[] = [];
  const original = vault.write.bind(vault);
  vault.write = async (path, text, expectedSha) => {
    started.push(`${path}:${text}`);
    await gate.promise;
    return original(path, text, expectedSha);
  };

  core.editDoc('a.md', 'A1');
  core.editDoc('b.md', 'B1');
  const saveA = core.saveDoc('a.md');
  const saveB = core.saveDoc('b.md');
  await settle();
  assert.deepEqual(started, ['a.md:A1']);

  gate.resolve();
  const [first, second] = await Promise.all([saveA, saveB]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(started, ['a.md:A1', 'b.md:B1']);
});

void test('write queue：排队期间外改必须以入队 baseSha 拒绝并进入冲突', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('a.md', 'A0');
  vault.seed('blocker.md', 'B0');
  await core.start();
  await core.openDoc('a.md');
  await core.openDoc('blocker.md');

  const gate = deferred();
  const original = vault.write.bind(vault);
  vault.write = async (path, text, expectedSha) => {
    if (path === 'blocker.md') await gate.promise;
    return original(path, text, expectedSha);
  };
  core.editDoc('blocker.md', 'B1');
  core.editDoc('a.md', 'A1');
  const blocker = core.saveDoc('blocker.md');
  const saving = core.saveDoc('a.md');
  await settle();

  vault.seed('a.md', 'external-A');
  events.emitFileChanged({ changes: [updated('a.md', 'external-A')] });
  gate.resolve();
  const [blockerOutcome, outcome] = await Promise.all([blocker, saving]);

  assert.equal(blockerOutcome.ok, true);
  assert.ok(outcome.ok === false);
  assert.equal(outcome.error.code, 'E_INVALID_ARG');
  assert.equal(outcome.conflict?.sha256, sha('external-A'));
  assert.equal(vault.writeCalls.find((call) => call.path === 'a.md')?.expectedSha, sha('A0'));
  assert.equal(vault.files.get('a.md')?.text, 'external-A');
  assert.equal(core.getDocument('a.md')?.text, 'A1');
  assert.equal(core.getDocument('a.md')?.dirty, true);
  assert.equal(core.getDocument('a.md')?.external?.sha256, sha('external-A'));
});

void test('rekey：目标待写等待者不丢，目标请求优先落盘', async () => {
  const vault = new FakeVaultPort();
  const clock = new FakeClock();
  const writer = createWriter({
    vault,
    clock,
    ttlMs: () => 1000,
    onSelfWrite: () => undefined,
    redirectError: () => null,
    onError: () => undefined,
  });
  const gate = deferred();
  const original = vault.write.bind(vault);
  vault.write = async (path, text, expectedSha) => {
    if (path === 'blocker.md') await gate.promise;
    return original(path, text, expectedSha);
  };
  const request = (text: string) => ({
    latestText: () => text,
    onStarted: () => undefined,
    onSettled: () => undefined,
  });

  const blocker = writer.submit('blocker.md', request('block'), false);
  const source = writer.submit('old.md', request('source'), false);
  const target = writer.submit('new.md', request('target'), false);
  await settle();
  writer.rekey('old.md', 'new.md');
  gate.resolve();

  const [, sourceOutcome, targetOutcome] = await Promise.all([blocker, source, target]);
  assert.equal(sourceOutcome.ok, true);
  assert.equal(targetOutcome.ok, true);
  assert.equal(vault.files.get('new.md')?.text, 'target');
  assert.deepEqual(vault.writeCalls.map((call) => [call.path, call.text]), [
    ['blocker.md', 'block'],
    ['new.md', 'target'],
  ]);
});

void test('write queue：同路径在飞时只留最新待写', async () => {
  const { core, vault } = makeHarness();
  vault.seed('a.md', 'A0');
  await core.start();
  await core.openDoc('a.md');

  const gate = deferred();
  const started: string[] = [];
  const original = vault.write.bind(vault);
  vault.write = async (path, text, expectedSha) => {
    started.push(`${path}:${text}`);
    await gate.promise;
    return original(path, text, expectedSha);
  };

  core.editDoc('a.md', 'A1');
  const first = core.saveDoc('a.md');
  await settle();
  assert.deepEqual(started, ['a.md:A1']);

  core.editDoc('a.md', 'A2');
  const second = core.saveDoc('a.md');
  const third = core.saveDoc('a.md');
  await settle();
  assert.deepEqual(started, ['a.md:A1']);

  gate.resolve();
  await Promise.all([first, second, third]);
  assert.deepEqual(started, ['a.md:A1', 'a.md:A2']);
  assert.equal(vault.files.get('a.md')?.text, 'A2');
});

void test('write 失败：dirty 保留、error 记录、不自动重试', async () => {
  const { core, vault, clock } = makeHarness(500);
  vault.seed('a.md', 'v0');
  await core.start();
  await core.openDoc('a.md');
  vault.failures.set('write', new EmberIpcError('vault_write', 'E_IO', 'disk gone', 'E_IO'));

  core.editDoc('a.md', 'v1');
  const outcome = await core.saveDoc('a.md');
  assert.equal(outcome.ok, false);

  const doc = core.getDocument('a.md');
  assert.equal(doc?.dirty, true);
  assert.equal(doc?.saving, false);
  assert.equal(doc?.error?.code, 'E_IO');

  await clock.advance(2000);
  assert.equal(vault.writeCalls.length, 1);
  assert.equal(vault.files.get('a.md')?.text, 'v0');
});

void test('E_READONLY：进入全局锁写，后续保存直接失败且不再触碰磁盘', async () => {
  const { core, vault } = makeHarness();
  vault.seed('a.md', 'v0');
  await core.start();
  await core.openDoc('a.md');
  vault.failures.set(
    'write',
    new EmberIpcError('vault_write', 'E_READONLY', 'readonly', 'E_READONLY'),
  );

  core.editDoc('a.md', 'v1');
  const first = await core.saveDoc('a.md');
  assert.equal(first.ok, false);

  vault.failures.delete('write');
  const second = await core.saveDoc('a.md');
  assert.ok(second.ok === false);
  assert.equal(second.error.code, 'E_READONLY');
  assert.equal(vault.writeCalls.length, 1);
});

void test('rename 与在飞写入竞态：旧写入作废清理，最新正文续写到新路径', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('old.md', 'X');
  await core.start();
  await core.openDoc('old.md');

  const gate = deferred();
  const started: string[] = [];
  const original = vault.write.bind(vault);
  vault.write = async (path, text, expectedSha) => {
    started.push(path);
    await gate.promise;
    return original(path, text, expectedSha);
  };

  core.editDoc('old.md', 'local X');
  const saving = core.saveDoc('old.md');
  await settle();
  assert.deepEqual(started, ['old.md']);

  await vault.rename('old.md', 'new.md');
  events.emitFileChanged({
    changes: [
      {
        kind: 'renamed',
        from: 'old.md',
        path: 'new.md',
        bytes: size('X'),
        sha256: sha('X'),
        modifiedMs: 5,
      },
    ],
  });
  gate.resolve();
  const outcome = await saving;

  assert.equal(outcome.ok, true);
  assert.equal(vault.files.has('old.md'), false);
  assert.equal(vault.files.get('new.md')?.text, 'local X');
  assert.equal(core.getIndex().docs.has('old.md'), false);
  assert.equal(core.getIndex().docs.get('new.md')?.sha256, sha('local X'));
  assert.equal(core.getDocument('new.md')?.dirty, false);
  assert.deepEqual(vault.writeCalls.map((call) => call.path), ['old.md', 'new.md']);
});

void test('rename 重定向：目标已有外部冲突时停止写入并保留本地冲突', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('old.md', 'X');
  await core.start();
  await core.openDoc('old.md');

  const gate = deferred();
  const original = vault.write.bind(vault);
  vault.write = async (path, text, expectedSha) => {
    if (path === 'old.md') await gate.promise;
    return original(path, text, expectedSha);
  };

  core.editDoc('old.md', 'local X');
  const saving = core.saveDoc('old.md');
  await settle();
  await vault.rename('old.md', 'new.md');
  events.emitFileChanged({
    changes: [
      {
        kind: 'renamed',
        from: 'old.md',
        path: 'new.md',
        bytes: size('X'),
        sha256: sha('X'),
        modifiedMs: 5,
      },
    ],
  });
  vault.seed('new.md', 'external X');
  events.emitFileChanged({ changes: [updated('new.md', 'external X')] });
  gate.resolve();
  const outcome = await saving;

  assert.ok(outcome.ok === false);
  assert.equal(outcome.error.code, 'E_INVALID_ARG');
  assert.equal(vault.files.get('new.md')?.text, 'external X');
  assert.equal(core.getDocument('new.md')?.text, 'local X');
  assert.equal(core.getDocument('new.md')?.dirty, true);
  assert.equal(core.getDocument('new.md')?.external?.sha256, sha('external X'));
  assert.deepEqual(vault.writeCalls.map((call) => call.path), ['old.md']);
});

void test('rename 重定向：检查后外改必须由目标 SHA 条件写拦截', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('old.md', 'X');
  await core.start();
  await core.openDoc('old.md');

  const gate = deferred();
  const original = vault.write.bind(vault);
  vault.write = async (path, text, expectedSha) => {
    if (path === 'old.md') await gate.promise;
    if (path === 'new.md') vault.seed('new.md', 'external-after-check');
    return original(path, text, expectedSha);
  };
  core.editDoc('old.md', 'local X');
  const saving = core.saveDoc('old.md');
  await settle();
  await vault.rename('old.md', 'new.md');
  events.emitFileChanged({
    changes: [
      {
        kind: 'renamed',
        from: 'old.md',
        path: 'new.md',
        bytes: size('X'),
        sha256: sha('X'),
        modifiedMs: 5,
      },
    ],
  });
  gate.resolve();
  const outcome = await saving;

  const redirected = vault.writeCalls.find((call) => call.path === 'new.md');
  assert.equal(redirected?.expectedSha, sha('X'));
  assert.ok(outcome.ok === false);
  assert.equal(outcome.error.code, 'E_INVALID_ARG');
  assert.equal(outcome.conflict?.sha256, sha('external-after-check'));
  assert.equal(vault.files.get('new.md')?.text, 'external-after-check');
  assert.equal(core.getDocument('new.md')?.text, 'local X');
  assert.equal(core.getDocument('new.md')?.dirty, true);
  assert.equal(core.getDocument('new.md')?.external?.sha256, sha('external-after-check'));
});

void test('连续 rename：重定向 stat 期间二次改名不得写回旧目标', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('old.md', 'X');
  await core.start();
  await core.openDoc('old.md');

  const writeGate = deferred();
  const statGate = deferred();
  const statStarted = deferred();
  const originalWrite = vault.write.bind(vault);
  vault.write = async (path, text, expectedSha) => {
    if (path === 'old.md') await writeGate.promise;
    return originalWrite(path, text, expectedSha);
  };

  core.editDoc('old.md', 'local X');
  const saving = core.saveDoc('old.md');
  await settle();
  await vault.rename('old.md', 'new.md');
  events.emitFileChanged({
    changes: [{
      kind: 'renamed', from: 'old.md', path: 'new.md',
      bytes: size('X'), sha256: sha('X'), modifiedMs: 5,
    }],
  });

  const originalStat = vault.stat.bind(vault);
  let pauseNewStat = true;
  vault.stat = async (path) => {
    if (path === 'new.md' && pauseNewStat) {
      pauseNewStat = false;
      statStarted.resolve();
      await statGate.promise;
    }
    return originalStat(path);
  };
  writeGate.resolve();
  await statStarted.promise;

  await vault.rename('new.md', 'third.md');
  events.emitFileChanged({
    changes: [{
      kind: 'renamed', from: 'new.md', path: 'third.md',
      bytes: size('X'), sha256: sha('X'), modifiedMs: 6,
    }],
  });
  vault.seed('new.md', 'external-new');
  events.emitFileChanged({
    changes: [{ ...updated('new.md', 'external-new'), kind: 'created' }],
  });
  statGate.resolve();
  const outcome = await saving;

  assert.equal(vault.writeCalls.some((call) => call.path === 'new.md'), false);
  assert.ok(outcome.ok === false);
  assert.equal(outcome.error.code, 'E_INVALID_ARG');
  assert.equal(vault.files.get('new.md')?.text, 'external-new');
  assert.equal(vault.files.get('third.md')?.text, 'X');
  assert.equal(core.getDocument('new.md'), null);
  assert.equal(core.getDocument('third.md')?.text, 'local X');
  assert.equal(core.getDocument('third.md')?.dirty, true);
  assert.equal(core.getIndex().docs.has('old.md'), false);
  assert.equal(core.getIndex().docs.get('new.md')?.sha256, sha('external-new'));
  assert.equal(core.getIndex().docs.get('third.md')?.sha256, sha('X'));
});

// ------------------------------------------------------------------ 回声

void test('回声抑制：baseSha 与 recentSelfWrites 命中时不触发重读', async () => {
  const { core, vault, events, clock } = makeHarness();
  vault.seed('a.md', 'v0');
  await core.start();
  await core.openDoc('a.md');
  const reads = vault.readCalls.length;

  core.editDoc('a.md', 'v1');
  await core.saveDoc('a.md');
  events.emitFileChanged({ changes: [updated('a.md', 'v1')] });
  assert.equal(vault.readCalls.length, reads);
  assert.equal(core.getDocument('a.md')?.external, null);

  core.editDoc('a.md', 'v2');
  await core.saveDoc('a.md');
  // baseSha 已是 v2；v1 属于更早的自写，只能靠 recentSelfWrites 命中。
  events.emitFileChanged({ changes: [updated('a.md', 'v1')] });
  assert.equal(vault.readCalls.length, reads);
  assert.equal(core.getDocument('a.md')?.external, null);
  assert.equal(vault.writeCalls.length, 2);

  await clock.advance(1000); // TTL = 2 × watcherDebounceMs(500) 已过
  vault.seed('a.md', 'v3');
  events.emitFileChanged({ changes: [updated('a.md', 'v3')] });
  await settle();

  assert.equal(core.getDocument('a.md')?.text, 'v3');
  assert.equal(core.getDocument('a.md')?.baseSha, sha('v3'));
});

// ------------------------------------------------------------ 冲突矩阵

void test('外部 updated（clean）：自动重读一次；removed（clean）：关闭文档', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('a.md', 'v1');
  await core.start();
  await core.openDoc('a.md');
  const reads = vault.readCalls.length;

  vault.seed('a.md', 'v2');
  events.emitFileChanged({ changes: [updated('a.md', 'v2')] });
  await settle();

  const doc = core.getDocument('a.md');
  assert.equal(doc?.text, 'v2');
  assert.equal(doc?.baseSha, sha('v2'));
  assert.equal(doc?.dirty, false);
  assert.equal(vault.readCalls.length, reads + 1);

  events.emitFileChanged({ changes: [{ kind: 'removed', path: 'a.md' }] });
  assert.equal(core.getDocument('a.md'), null);
  assert.equal(vault.writeCalls.length, 0);
});

void test('自动 reload：读取期间二次外改时保留原正文并提示最新冲突', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('a.md', 'v1');
  await core.start();
  await core.openDoc('a.md');

  const gate = deferred();
  const started = deferred();
  const original = vault.read.bind(vault);
  let blockNext = true;
  vault.read = async (path) => {
    const read = await original(path);
    if (blockNext) {
      blockNext = false;
      started.resolve();
      await gate.promise;
    }
    return read;
  };

  vault.seed('a.md', 'v2');
  events.emitFileChanged({ changes: [updated('a.md', 'v2')] });
  await started.promise;
  vault.seed('a.md', 'v3');
  gate.resolve();
  await settle();

  const doc = core.getDocument('a.md');
  assert.equal(doc?.text, 'v1');
  assert.equal(doc?.baseSha, sha('v1'));
  assert.equal(doc?.external?.sha256, sha('v3'));
});

void test('手工 reload：读取期间二次外改时中止旧裁决并保留本地正文', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('a.md', 'v0');
  await core.start();
  await core.openDoc('a.md');
  core.editDoc('a.md', 'local');
  vault.seed('a.md', 'external-1');
  events.emitFileChanged({ changes: [updated('a.md', 'external-1')] });

  const gate = deferred();
  const started = deferred();
  const original = vault.read.bind(vault);
  vault.read = async (path) => {
    const read = await original(path);
    started.resolve();
    await gate.promise;
    return read;
  };
  const resolving = core.resolveDocConflict('a.md', 'reload');
  await started.promise;
  vault.seed('a.md', 'external-2');
  gate.resolve();

  await assert.rejects(resolving, (error: unknown) => {
    assert.ok(error instanceof EmberIpcError);
    assert.equal(error.code, 'E_INVALID_ARG');
    return true;
  });
  const doc = core.getDocument('a.md');
  assert.equal(doc?.text, 'local');
  assert.equal(doc?.dirty, true);
  assert.equal(doc?.baseSha, sha('v0'));
  assert.equal(doc?.external?.sha256, sha('external-2'));
});

void test('手工 reload：裁决期间继续输入时保留新正文并重新标记冲突', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('a.md', 'v0');
  await core.start();
  await core.openDoc('a.md');
  core.editDoc('a.md', 'local');
  vault.seed('a.md', 'external-1');
  events.emitFileChanged({ changes: [updated('a.md', 'external-1')] });

  const gate = deferred();
  const started = deferred();
  const original = vault.read.bind(vault);
  vault.read = async (path) => {
    const read = await original(path);
    started.resolve();
    await gate.promise;
    return read;
  };
  const resolving = core.resolveDocConflict('a.md', 'reload');
  await started.promise;
  // 点击“重新加载”之后继续输入：读取结果不得覆盖这段新正文。
  core.editDoc('a.md', 'local after click');
  gate.resolve();

  await assert.rejects(resolving, (error: unknown) => {
    assert.ok(error instanceof EmberIpcError);
    assert.equal(error.code, 'E_INVALID_ARG');
    assert.match(error.message, /document changed during reload/);
    return true;
  });
  const doc = core.getDocument('a.md');
  assert.equal(doc?.text, 'local after click');
  assert.equal(doc?.dirty, true);
  assert.equal(doc?.baseSha, sha('v0'));
  assert.equal(doc?.external?.sha256, sha('external-1'), '冲突仍在，等下一次裁决');
});

void test('外部 updated（dirty）：只标记冲突；overwrite 先写冲突副本再覆盖', async () => {
  const { core, vault, events, clock } = makeHarness();
  vault.seed('a.md', 'v0');
  await core.start();
  await core.openDoc('a.md');

  core.editDoc('a.md', 'local');
  await core.saveDoc('a.md');
  core.editDoc('a.md', 'local edit');
  const writes = vault.writeCalls.length;

  vault.seed('a.md', 'external');
  events.emitFileChanged({ changes: [updated('a.md', 'external', 77)] });

  const dirty = core.getDocument('a.md');
  assert.equal(dirty?.text, 'local edit');
  assert.equal(dirty?.dirty, true);
  assert.equal(dirty?.external?.kind, 'updated');
  assert.equal(dirty?.external?.sha256, sha('external'));
  assert.equal(vault.writeCalls.length, writes);
  assert.equal(vault.files.get('a.md')?.text, 'external');

  const blocked = await core.saveDoc('a.md');
  assert.ok(blocked.ok === false);
  assert.equal(blocked.conflict?.kind, 'updated');
  assert.equal(vault.writeCalls.length, writes);

  const resolved = await core.resolveDocConflict('a.md', 'overwrite');
  assert.equal(resolved.dirty, false);
  assert.equal(resolved.external, null);
  assert.equal(resolved.text, 'local edit');

  const copyWrite = vault.writeCalls[writes];
  assert.ok(copyWrite);
  assert.match(copyWrite.path, /^a\.conflict-\d{8}-\d{6}-\d{3}\.md$/);
  assert.equal(copyWrite.path, conflictCopyPath('a.md', clock.now()));
  assert.equal(copyWrite.text, 'external');
  assert.deepEqual(vault.writeCalls[vault.writeCalls.length - 1], {
    path: 'a.md',
    text: 'local edit',
    expectedSha: sha('external'),
  });
  assert.equal(vault.files.get(copyWrite.path)?.text, 'external');
  assert.equal(vault.files.get('a.md')?.text, 'local edit');
  assert.equal(core.getIndex().docs.has(copyWrite.path), true);
  assert.equal(core.getIndex().docs.get('a.md')?.sha256, sha('local edit'));
});

void test('冲突副本：同一毫秒连续冲突追加序号且不覆盖旧副本', async () => {
  const { core, vault, events, clock } = makeHarness();
  vault.seed('a.md', 'v0');
  await core.start();
  await core.openDoc('a.md');

  core.editDoc('a.md', 'local-1');
  vault.seed('a.md', 'external-1');
  events.emitFileChanged({ changes: [updated('a.md', 'external-1')] });
  await core.resolveDocConflict('a.md', 'overwrite');

  core.editDoc('a.md', 'local-2');
  vault.seed('a.md', 'external-2');
  events.emitFileChanged({ changes: [updated('a.md', 'external-2')] });
  await core.resolveDocConflict('a.md', 'overwrite');

  const copies = vault.writeCalls.filter((call) => call.path.includes('.conflict-'));
  assert.equal(copies.length, 2);
  const first = copies[0];
  const second = copies[1];
  assert.ok(first);
  assert.ok(second);
  assert.equal(vault.files.get(first.path)?.text, 'external-1');
  assert.equal(vault.files.get(second.path)?.text, 'external-2');
  assert.match(first.path, /^a\.conflict-\d{8}-\d{6}-\d{3}\.md$/);
  assert.equal(first.path, conflictCopyPath('a.md', clock.now()));
  assert.equal(second.path, first.path.replace(/\.md$/, '-2.md'));
});

// ------------------------------------------------ 冲突副本（.workbench/conflicts）

void test('冲突快照：dirty 收到外部更新时只存一次本地草稿', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('notes/a.md', 'v0');
  await core.start();
  await core.openDoc('notes/a.md');
  core.editDoc('notes/a.md', 'local draft');

  vault.seed('notes/a.md', 'external');
  events.emitFileChanged({ changes: [updated('notes/a.md', 'external')] });
  await settle();

  assert.equal(vault.conflictCopyCalls.length, 1);
  const call = vault.conflictCopyCalls[0];
  assert.ok(call);
  assert.equal(call.path, 'notes/a.md');
  assert.equal(call.text, 'local draft');
  assert.match(call.stamp, /^\d{8}-\d{6}-\d{3}$/);

  const doc = core.getDocument('notes/a.md');
  assert.equal(doc?.external?.kind, 'updated');
  assert.equal(
    doc?.conflictCopy?.path,
    `.workbench/conflicts/notes/a.conflict-${call.stamp}.md`,
  );
  assert.equal(doc?.conflictCopy?.sha256, sha('local draft'));
  assert.equal(doc?.conflictCopy?.bytes, size('local draft'));

  events.emitFileChanged({ changes: [updated('notes/a.md', 'external')] });
  await settle();
  assert.equal(vault.conflictCopyCalls.length, 1, '同一外部 sha 不重复保存');
});

void test('冲突快照：外部再次变化时按新 sha 再存一份', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('a.md', 'v0');
  await core.start();
  await core.openDoc('a.md');
  core.editDoc('a.md', 'local');

  vault.seed('a.md', 'external-1');
  events.emitFileChanged({ changes: [updated('a.md', 'external-1')] });
  await settle();
  vault.seed('a.md', 'external-2');
  events.emitFileChanged({ changes: [updated('a.md', 'external-2')] });
  await settle();

  assert.equal(vault.conflictCopyCalls.length, 2);
  assert.equal(vault.conflictCopyCalls[0]?.text, 'local');
  assert.equal(vault.conflictCopyCalls[1]?.text, 'local');
  assert.equal(
    core.getDocument('a.md')?.conflictCopy?.path,
    `.workbench/conflicts/a.conflict-${vault.conflictCopyCalls[1]?.stamp}.md`,
  );
});

void test('冲突快照：写入失败不阻断裁决且不上报 core:error', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('a.md', 'v0');
  await core.start();
  await core.openDoc('a.md');
  core.editDoc('a.md', 'local');

  const errors: EmberIpcError[] = [];
  const unsubscribe = core.events.subscribe((event) => {
    if (event.type === 'core:error') errors.push(event.error);
  });
  vault.failures.set(
    'saveConflictCopy',
    new EmberIpcError('conflict_save', 'E_IO', 'copy failed', 'E_IO'),
  );

  vault.seed('a.md', 'external');
  events.emitFileChanged({ changes: [updated('a.md', 'external')] });
  await settle();
  unsubscribe();

  const doc = core.getDocument('a.md');
  assert.equal(doc?.external?.kind, 'updated');
  assert.equal(doc?.conflictCopy, null);
  assert.equal(doc?.conflictCopyFailed, true, '副本失败必须显式标记');
  assert.equal(errors.length, 0, '副本失败不得上升为 core:error');

  const blocked = await core.saveDoc('a.md');
  assert.equal(blocked.ok, false, '冲突仍照常阻断普通保存');

  const resolved = await core.resolveDocConflict('a.md', 'reload');
  assert.equal(resolved.conflictCopyFailed, false, '冲突解除后清空失败标记');
});

void test('冲突快照：reload 解除冲突后清空副本', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('a.md', 'v0');
  await core.start();
  await core.openDoc('a.md');
  core.editDoc('a.md', 'local');

  vault.seed('a.md', 'external');
  events.emitFileChanged({ changes: [updated('a.md', 'external')] });
  await settle();
  assert.ok(core.getDocument('a.md')?.conflictCopy);

  const resolved = await core.resolveDocConflict('a.md', 'reload');
  assert.equal(resolved.text, 'external');
  assert.equal(resolved.external, null);
  assert.equal(resolved.conflictCopy, null);
});

void test('冲突快照：外部删除 dirty 文档时也另存本地草稿', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('a.md', 'v0');
  await core.start();
  await core.openDoc('a.md');
  core.editDoc('a.md', 'local');

  events.emitFileChanged({ changes: [{ kind: 'removed', path: 'a.md' }] });
  await settle();

  assert.equal(vault.conflictCopyCalls.length, 1);
  const call = vault.conflictCopyCalls[0];
  assert.ok(call);
  assert.equal(call.text, 'local');
  const doc = core.getDocument('a.md');
  assert.equal(doc?.external?.kind, 'removed');
  assert.equal(
    doc?.conflictCopy?.path,
    `.workbench/conflicts/a.conflict-${call.stamp}.md`,
  );
});

void test('conflictStamp：形状固定且与 conflictCopyPath 同源', () => {
  const now = Date.UTC(2026, 10, 27, 2, 15, 30, 123);
  assert.match(conflictStamp(now), /^\d{8}-\d{6}-\d{3}$/);
  assert.equal(conflictCopyPath('a.md', now), `a.conflict-${conflictStamp(now)}.md`);
});

void test('overwrite 期间二次外部修改：中止覆盖并保留最新磁盘内容', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('a.md', 'v0');
  await core.start();
  await core.openDoc('a.md');

  core.editDoc('a.md', 'local edit');
  vault.seed('a.md', 'external-1');
  events.emitFileChanged({ changes: [updated('a.md', 'external-1')] });

  const original = vault.write.bind(vault);
  vault.write = async (path, text, expectedSha) => {
    const result = await original(path, text, expectedSha);
    if (path.includes('.conflict-')) vault.seed('a.md', 'external-2');
    return result;
  };

  await assert.rejects(core.resolveDocConflict('a.md', 'overwrite'), (error: unknown) => {
    assert.ok(error instanceof EmberIpcError);
    assert.equal(error.code, 'E_INVALID_ARG');
    return true;
  });

  assert.equal(vault.files.get('a.md')?.text, 'external-2');
  assert.equal(core.getDocument('a.md')?.text, 'local edit');
  assert.equal(core.getDocument('a.md')?.external?.sha256, sha('external-2'));
  assert.equal(vault.writeCalls.some((call) => call.path === 'a.md'), false);
  const copyWrite = vault.writeCalls.find((call) => call.path.includes('.conflict-'));
  assert.equal(copyWrite?.text, 'external-1');
});

void test('overwrite 条件写：stat 后外改必须拒绝并刷新冲突', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('a.md', 'v0');
  await core.start();
  await core.openDoc('a.md');
  core.editDoc('a.md', 'local');
  vault.seed('a.md', 'external-1');
  events.emitFileChanged({ changes: [updated('a.md', 'external-1')] });

  const original = vault.stat.bind(vault);
  let inject = true;
  vault.stat = async (path) => {
    const current = await original(path);
    if (path === 'a.md' && inject) {
      inject = false;
      vault.seed('a.md', 'external-2');
    }
    return current;
  };

  await assert.rejects(core.resolveDocConflict('a.md', 'overwrite'), (error: unknown) => {
    assert.ok(error instanceof EmberIpcError);
    assert.equal(error.code, 'E_INVALID_ARG');
    return true;
  });
  const doc = core.getDocument('a.md');
  assert.equal(vault.files.get('a.md')?.text, 'external-2');
  assert.equal(doc?.text, 'local');
  assert.equal(doc?.dirty, true);
  assert.equal(doc?.external?.sha256, sha('external-2'));
  const attempted = vault.writeCalls.find((call) => call.path === 'a.md');
  assert.equal(attempted?.expectedSha, sha('external-1'));
});

void test('overwrite 写失败：保留 dirty 与 external，后续普通保存仍被阻断', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('a.md', 'v0');
  await core.start();
  await core.openDoc('a.md');

  core.editDoc('a.md', 'local edit');
  vault.seed('a.md', 'external');
  events.emitFileChanged({ changes: [updated('a.md', 'external', 77)] });
  const original = vault.write.bind(vault);
  vault.write = async (path, text, expectedSha) => {
    if (path === 'a.md') {
      throw new EmberIpcError('vault_write', 'E_IO', 'disk gone', 'E_IO');
    }
    return original(path, text, expectedSha);
  };

  await assert.rejects(core.resolveDocConflict('a.md', 'overwrite'), (error: unknown) => {
    assert.ok(error instanceof EmberIpcError);
    assert.equal(error.code, 'E_IO');
    return true;
  });

  const failed = core.getDocument('a.md');
  assert.equal(failed?.text, 'local edit');
  assert.equal(failed?.dirty, true);
  assert.equal(failed?.saving, false);
  assert.equal(failed?.external?.sha256, sha('external'));
  assert.equal(vault.files.get('a.md')?.text, 'external');

  const blocked = await core.saveDoc('a.md');
  assert.ok(blocked.ok === false);
  assert.equal(blocked.conflict?.sha256, sha('external'));
  assert.equal(vault.files.get('a.md')?.text, 'external');
});

void test('overwrite 写盘期间的新冲突不被旧裁决清除', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('a.md', 'v0');
  await core.start();
  await core.openDoc('a.md');
  core.editDoc('a.md', 'local-1');
  vault.seed('a.md', 'external-1');
  events.emitFileChanged({ changes: [updated('a.md', 'external-1')] });

  const gate = deferred();
  const started = deferred();
  let targetStarted = false;
  const original = vault.write.bind(vault);
  vault.write = async (path, text, expectedSha) => {
    if (path === 'a.md') {
      targetStarted = true;
      started.resolve();
      await gate.promise;
    }
    return original(path, text, expectedSha);
  };
  const resolving = core.resolveDocConflict('a.md', 'overwrite');
  await Promise.race([started.promise, resolving]);
  assert.ok(targetStarted);
  core.editDoc('a.md', 'local-2');
  events.emitFileChanged({ changes: [updated('a.md', 'external-2')] });
  gate.resolve();
  const resolved = await resolving;

  assert.equal(resolved.text, 'local-2');
  assert.equal(resolved.dirty, true);
  assert.equal(resolved.external?.sha256, sha('external-2'));
});

void test('overwrite 期望缺失：stat 后外部重建必须拒绝覆盖', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('a.md', 'v0');
  await core.start();
  await core.openDoc('a.md');
  core.editDoc('a.md', 'local');
  vault.files.delete('a.md');
  events.emitFileChanged({ changes: [{ kind: 'removed', path: 'a.md' }] });

  const original = vault.stat.bind(vault);
  let inject = true;
  vault.stat = async (path) => {
    try {
      return await original(path);
    } catch (error) {
      if (path === 'a.md' && inject) {
        inject = false;
        vault.seed('a.md', 'external-recreated');
      }
      throw error;
    }
  };

  await assert.rejects(core.resolveDocConflict('a.md', 'overwrite'), (error: unknown) => {
    assert.ok(error instanceof EmberIpcError);
    assert.equal(error.code, 'E_INVALID_ARG');
    return true;
  });
  assert.equal(vault.writeCalls.find((call) => call.path === 'a.md')?.expectedSha, '');
  assert.equal(vault.files.get('a.md')?.text, 'external-recreated');
  assert.equal(core.getDocument('a.md')?.text, 'local');
  assert.equal(core.getDocument('a.md')?.dirty, true);
  assert.equal(core.getDocument('a.md')?.external?.sha256, sha('external-recreated'));
});

void test('外部 removed（dirty）：保留本地并标记；overwrite 重建文件且不生成副本', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('a.md', 'v0');
  await core.start();
  await core.openDoc('a.md');

  core.editDoc('a.md', 'local');
  vault.files.delete('a.md');
  events.emitFileChanged({ changes: [{ kind: 'removed', path: 'a.md' }] });

  const doc = core.getDocument('a.md');
  assert.equal(doc?.text, 'local');
  assert.equal(doc?.external?.kind, 'removed');

  const resolved = await core.resolveDocConflict('a.md', 'overwrite');
  assert.equal(resolved.external, null);
  assert.equal(resolved.dirty, false);
  assert.equal(vault.files.get('a.md')?.text, 'local');
  assert.equal(vault.writeCalls.length, 1);
});

void test('外部 renamed：迁移打开中的文档，保留正文与 dirty', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('old.md', 'X');
  await core.start();
  await core.openDoc('old.md');
  core.editDoc('old.md', 'local X');

  events.emitFileChanged({
    changes: [
      {
        kind: 'renamed',
        from: 'old.md',
        path: 'new.md',
        bytes: size('X'),
        sha256: sha('X'),
        modifiedMs: 5,
      },
    ],
  });

  assert.equal(core.getDocument('old.md'), null);
  const moved = core.getDocument('new.md');
  assert.ok(moved);
  assert.equal(moved.path, 'new.md');
  assert.equal(moved.text, 'local X');
  assert.equal(moved.dirty, true);
  assert.equal(moved.external, null);
  assert.equal(vault.writeCalls.length, 0);
});

void test('路径迁移：源文档移动到新路径并保留文档数据', () => {
  const source = { path: 'old.md', text: 'local' };
  const docs = new Map([['old.md', source]]);

  const moved = migrateDocumentPath(docs, 'old.md', 'new.md');

  assert.equal(moved, source);
  assert.equal(source.path, 'new.md');
  assert.equal(docs.has('old.md'), false);
  assert.equal(docs.get('new.md'), source);
});

void test('路径迁移：源不存在时不动索引，目标已打开时保留目标', () => {
  const docs = new Map([
    ['old.md', { path: 'old.md', text: 'source' }],
    ['new.md', { path: 'new.md', text: 'target' }],
  ]);
  const target = docs.get('new.md');

  assert.equal(migrateDocumentPath(docs, 'missing.md', 'other.md'), null);
  assert.equal(docs.size, 2);

  const moved = migrateDocumentPath(docs, 'old.md', 'new.md');
  assert.equal(moved, target);
  assert.equal(docs.has('old.md'), false);
  assert.deepEqual([...docs.values()], [{ path: 'new.md', text: 'target' }]);
});

void test('外部改名配对：sha 匹配时迁移 dirty 文档并记录别名，created 不重复应用', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('old.md', 'X');
  await core.start();
  await core.openDoc('old.md');
  core.editDoc('old.md', 'local X');
  const readsBefore = vault.readCalls.length;
  let documentNotifications = 0;
  core.subscribeDocuments(() => {
    documentNotifications += 1;
  });

  await vault.rename('old.md', 'new.md');
  events.emitFileChanged({
    changes: [
      { kind: 'removed', path: 'old.md' },
      {
        kind: 'created',
        path: 'new.md',
        bytes: size('X'),
        sha256: sha('X'),
        modifiedMs: 5,
      },
    ],
  });

  const moved = core.getDocument('new.md');
  assert.equal(core.getDocument('old.md'), null);
  assert.equal(moved?.text, 'local X');
  assert.equal(moved?.dirty, true);
  assert.equal(moved?.external, null, '不得把改名误报为删除');
  assert.equal(core.resolveDocPath('old.md'), 'new.md');
  assert.equal(core.resolveDocPath('unknown.md'), null);
  assert.equal(vault.readCalls.length, readsBefore, '合成事件与 created 不得触发重复读取');
  assert.equal(documentNotifications, 1, 'sha 匹配只发布迁移，不重复应用 created');
  assert.equal(vault.writeCalls.length, 0);
});

void test('外部改名配对：sha 不匹配时不推断，维持 removed 冲突且不迁移路径', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('old.md', 'X');
  await core.start();
  await core.openDoc('old.md');
  core.editDoc('old.md', 'local X');

  await vault.rename('old.md', 'new.md');
  vault.seed('new.md', 'external Y');
  events.emitFileChanged({
    changes: [
      { kind: 'removed', path: 'old.md' },
      {
        kind: 'created',
        path: 'new.md',
        bytes: size('external Y'),
        sha256: sha('external Y'),
        modifiedMs: 6,
      },
    ],
  });

  const kept = core.getDocument('old.md');
  assert.equal(core.getDocument('new.md'), null, '不得把无关 created 合成改名');
  assert.equal(kept?.text, 'local X');
  assert.equal(kept?.dirty, true);
  assert.equal(kept?.external?.kind, 'removed');
  assert.equal(core.resolveDocPath('old.md'), null);
  assert.equal(vault.writeCalls.length, 0);
});

void test('外部改名配对：跨目录同名同 sha 也不推断，维持 removed 冲突', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('notes/old.md', 'X');
  await core.start();
  await core.openDoc('notes/old.md');
  core.editDoc('notes/old.md', 'local X');

  vault.files.delete('notes/old.md');
  vault.seed('archive/new.md', 'X');
  events.emitFileChanged({
    changes: [
      { kind: 'removed', path: 'notes/old.md' },
      {
        kind: 'created',
        path: 'archive/new.md',
        bytes: size('X'),
        sha256: sha('X'),
        modifiedMs: 5,
      },
    ],
  });

  assert.equal(core.getDocument('archive/new.md'), null);
  assert.equal(core.getDocument('notes/old.md')?.external?.kind, 'removed');
  assert.equal(core.resolveDocPath('notes/old.md'), null);
});

void test('外部改名配对：created 缺 sha256 时不推断', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('old.md', 'X');
  await core.start();
  await core.openDoc('old.md');
  core.editDoc('old.md', 'local X');

  vault.files.delete('old.md');
  vault.seed('new.md', 'X');
  events.emitFileChanged({
    changes: [
      { kind: 'removed', path: 'old.md' },
      { kind: 'created', path: 'new.md', bytes: size('X'), modifiedMs: 5 },
    ],
  });

  assert.equal(core.getDocument('new.md'), null);
  assert.equal(core.getDocument('old.md')?.external?.kind, 'removed');
  assert.equal(core.resolveDocPath('old.md'), null);
});

void test('外部改名配对：多个 created 候选时不推断，维持 removed 冲突', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('old.md', 'X');
  await core.start();
  await core.openDoc('old.md');
  core.editDoc('old.md', 'local X');

  vault.files.delete('old.md');
  vault.seed('new-a.md', 'X');
  vault.seed('new-b.md', 'X');
  events.emitFileChanged({
    changes: [
      { kind: 'removed', path: 'old.md' },
      { kind: 'created', path: 'new-a.md', bytes: 1, sha256: sha('X'), modifiedMs: 5 },
      { kind: 'created', path: 'new-b.md', bytes: 1, sha256: sha('X'), modifiedMs: 5 },
    ],
  });

  assert.equal(core.getDocument('old.md')?.text, 'local X');
  assert.equal(core.getDocument('old.md')?.external?.kind, 'removed');
  assert.equal(core.getDocument('new-a.md'), null);
  assert.equal(core.getDocument('new-b.md'), null);
  assert.equal(core.resolveDocPath('old.md'), null);
});

void test('外部改名配对：renamed 先于 removed 处理，clean 文档不被提前关闭', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('old.md', 'X');
  await core.start();
  await core.openDoc('old.md');
  const readsBefore = vault.readCalls.length;

  await vault.rename('old.md', 'new.md');
  events.emitFileChanged({
    changes: [
      { kind: 'removed', path: 'old.md' },
      {
        kind: 'renamed',
        from: 'old.md',
        path: 'new.md',
        bytes: size('X'),
        sha256: sha('X'),
        modifiedMs: 5,
      },
    ],
  });

  assert.equal(core.getDocument('old.md'), null);
  assert.equal(core.getDocument('new.md')?.text, 'X');
  assert.equal(core.getDocument('new.md')?.dirty, false);
  assert.equal(vault.readCalls.length, readsBefore);
});

void test('路径别名：连续改名压缩到终点，dispose 后解析失效', async () => {
  const { core, vault, events } = makeHarness();
  vault.seed('old.md', 'X');
  await core.start();
  await core.openDoc('old.md');

  await vault.rename('old.md', 'new.md');
  events.emitFileChanged({
    changes: [{
      kind: 'renamed', from: 'old.md', path: 'new.md',
      bytes: size('X'), sha256: sha('X'), modifiedMs: 5,
    }],
  });
  await vault.rename('new.md', 'third.md');
  events.emitFileChanged({
    changes: [{
      kind: 'renamed', from: 'new.md', path: 'third.md',
      bytes: size('X'), sha256: sha('X'), modifiedMs: 6,
    }],
  });

  assert.equal(core.resolveDocPath('old.md'), 'third.md');
  assert.equal(core.resolveDocPath('new.md'), 'third.md');
  assert.equal(core.resolveDocPath('third.md'), null);
  assert.equal(core.resolveDocPath('missing.md'), null);
  core.dispose();
  assert.equal(core.resolveDocPath('old.md'), null);
});

// ------------------------------------------------------------ 带外写后对齐

void test('reconcilePaths：规范化去重，索引先于干净文档 reload 发布', async () => {
  const { core, vault } = makeHarness();
  vault.seed('notes/a.md', 'v1');
  await core.start();
  await core.openDoc('notes/a.md');
  vault.seed('notes/a.md', 'v2');

  const statPaths: string[] = [];
  const originalStat = vault.stat.bind(vault);
  vault.stat = async (path) => {
    statPaths.push(path);
    return originalStat(path);
  };
  const order: string[] = [];
  core.subscribeIndex(() => order.push('index'));
  core.subscribeDocuments(() => order.push('documents'));

  await core.reconcilePaths([
    'notes\\a.md',
    './notes/a.md',
    'notes//a.md',
    'notes/x/../a.md',
  ]);

  assert.deepEqual(statPaths, ['notes/a.md', 'notes/a.md'], '一次 reconcile stat + 一次 reload 复核');
  assert.deepEqual(order, ['index', 'documents']);
  assert.equal(core.getIndex().docs.get('notes/a.md')?.sha256, sha('v2'));
  assert.equal(core.getDocument('notes/a.md')?.text, 'v2');
  assert.equal(core.getDocument('notes/a.md')?.baseSha, sha('v2'));
});

void test('reconcilePaths：干净文档等待实际 reload 完成后才返回', async () => {
  const { core, vault } = makeHarness();
  vault.seed('a.md', 'v1');
  await core.start();
  await core.openDoc('a.md');
  vault.seed('a.md', 'v2');

  const gate = deferred();
  const started = deferred();
  const originalRead = vault.read.bind(vault);
  vault.read = async (path) => {
    const read = await originalRead(path);
    started.resolve();
    await gate.promise;
    return read;
  };

  let returned = false;
  const reconciling = core.reconcilePaths(['a.md']).then(() => {
    returned = true;
  });
  await started.promise;
  assert.equal(returned, false);
  assert.equal(core.getDocument('a.md')?.text, 'v1');

  gate.resolve();
  await reconciling;
  assert.equal(returned, true);
  assert.equal(core.getDocument('a.md')?.text, 'v2');
  assert.equal(core.getDocument('a.md')?.baseSha, sha('v2'));
});

void test('reconcilePaths：dirty 文档只标 external conflict，不重读或覆盖本地正文', async () => {
  const { core, vault } = makeHarness();
  vault.seed('a.md', 'v1');
  await core.start();
  await core.openDoc('a.md');
  core.editDoc('a.md', 'local');
  vault.seed('a.md', 'external');
  const reads = vault.readCalls.length;

  await core.reconcilePaths(['a.md']);

  const doc = core.getDocument('a.md');
  assert.equal(doc?.text, 'local');
  assert.equal(doc?.dirty, true);
  assert.equal(doc?.external?.kind, 'updated');
  assert.equal(doc?.external?.sha256, sha('external'));
  assert.equal(core.getIndex().docs.get('a.md')?.sha256, sha('external'));
  assert.equal(vault.readCalls.length, reads);
  assert.equal(vault.writeCalls.length, 0);
  assert.equal(vault.files.get('a.md')?.text, 'external');
});

void test('reconcilePaths：saving 文档沿用 pendingExternal，写盘结算后标冲突且不覆盖', async () => {
  const { core, vault } = makeHarness();
  vault.seed('a.md', 'v1');
  await core.start();
  await core.openDoc('a.md');

  const gate = deferred();
  const started = deferred();
  const originalWrite = vault.write.bind(vault);
  vault.write = async (path, text, expectedSha) => {
    started.resolve();
    await gate.promise;
    return originalWrite(path, text, expectedSha);
  };
  core.editDoc('a.md', 'local');
  const saving = core.saveDoc('a.md');
  await started.promise;
  vault.seed('a.md', 'external');
  const reads = vault.readCalls.length;

  await core.reconcilePaths(['a.md']);
  assert.equal(core.getDocument('a.md')?.saving, true);
  assert.equal(core.getDocument('a.md')?.text, 'local');

  gate.resolve();
  const outcome = await saving;
  assert.equal(outcome.ok, false);
  const doc = core.getDocument('a.md');
  assert.equal(doc?.text, 'local');
  assert.equal(doc?.dirty, true);
  assert.equal(doc?.saving, false);
  assert.equal(doc?.external?.kind, 'updated');
  assert.equal(doc?.external?.sha256, sha('external'));
  assert.equal(vault.readCalls.length, reads);
  assert.equal(vault.files.get('a.md')?.text, 'external');
});
