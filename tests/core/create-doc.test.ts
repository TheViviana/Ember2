/**
 * CR-20261119-08：core.createDoc 单元测试。
 *
 * 全部 FakeVaultPort 注入；FakeVaultPort.write(expectedSha='') 已实现 create-only 语义
 * （目标已存在 → 抛 E_INVALID_ARG），无需额外增强。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEmberCore, type CreateDocResult, type EmberCore } from '../../src/core/core.ts';
import { EmberIpcError } from '../../src/core/errors.ts';
import { FakeClock, FakeEventPort, FakeVaultPort } from '../kernel/fakes.ts';

interface Harness {
  core: EmberCore;
  vault: FakeVaultPort;
  clock: FakeClock;
}

function makeHarness(): Harness {
  const vault = new FakeVaultPort();
  const events = new FakeEventPort();
  const clock = new FakeClock();
  const core = createEmberCore({ vault, events, clock });
  return { core, vault, clock };
}

function startReady(core: EmberCore): Promise<void> {
  return core.start();
}

// ------------------------------------------------------------------ 预检腿

void test('createDoc：预检腿 stat 命中 → EXISTS，write 不被调用', async () => {
  const { core, vault } = makeHarness();
  await startReady(core);
  vault.seed('exists.md', 'hello');

  const result = await core.createDoc('exists.md');

  assert.deepEqual(result, { ok: false, reason: 'EXISTS', message: '文件已存在，请换一个名字' });
  assert.equal(vault.writeCalls.length, 0, '预检腿不应发起 write');
});

void test('createDoc：预检腿 stat 未命中 → write expectedSha=""', async () => {
  const { core, vault } = makeHarness();
  await startReady(core);

  const result = await core.createDoc('brand-new.md');

  assert.deepEqual(result, { ok: true, rel: 'brand-new.md' });
  assert.equal(vault.writeCalls.length, 1);
  assert.equal(vault.writeCalls[0]?.expectedSha, '', '必须是 create-only');
});

// ------------------------------------------------------------------ 兜底腿（竞态窗口）

void test('createDoc：write 抛 E_INVALID_ARG + 二次 stat 命中 → EXISTS', async () => {
  const { core, vault } = makeHarness();
  await startReady(core);

  // 让 write 总是抛 E_INVALID_ARG，模拟竞态窗口
  vault.failures.set(
    'write',
    new EmberIpcError('vault_write', 'E_INVALID_ARG', 'document changed before write', 'E_INVALID_ARG'),
  );
  // 让 stat 返回已存在（兜底腿二次 stat 命中）
  vault.seed('race.md', 'stale');

  const result = await core.createDoc('race.md');

  assert.deepEqual(result, { ok: false, reason: 'EXISTS', message: '文件已存在，请换一个名字' });
});

void test('createDoc：write 抛 E_INVALID_ARG + 二次 stat 未命中 → BAD_REQUEST（极罕见）', async () => {
  const { core, vault } = makeHarness();
  await startReady(core);

  vault.failures.set(
    'write',
    new EmberIpcError('vault_write', 'E_INVALID_ARG', 'document changed before write', 'E_INVALID_ARG'),
  );
  // 让 stat 抛 E_NOT_FOUND（二次 stat 也 miss）
  vault.failures.set('stat', new EmberIpcError('vault_stat', 'E_NOT_FOUND', 'not found', 'E_NOT_FOUND'));

  const result = await core.createDoc('ghost.md');

  assert.equal(result.ok, false);
  if (result.ok === false) {
    assert.equal(result.reason, 'BAD_REQUEST');
  }
});

// ------------------------------------------------------------------ 并发双请求

void test('createDoc：并发双请求同一目标 → 恰好一条 ok、一条 EXISTS', async () => {
  const { core } = makeHarness();
  await startReady(core);

  const results = await Promise.all([core.createDoc('same.md'), core.createDoc('same.md')]);

  const oks = results.filter((r): r is Extract<CreateDocResult, { ok: true }> => r.ok);
  const exists = results.filter(
    (r): r is Extract<CreateDocResult, { ok: false }> => !r.ok && r.reason === 'EXISTS',
  );
  assert.equal(oks.length, 1);
  assert.equal(exists.length, 1);
});

// ------------------------------------------------------------------ 写入成功四条契约

void test('createDoc 成功：四条契约同时成立（docs.has / tree / subscribeIndex / modifiedMs）', async () => {
  const { core, vault } = makeHarness();
  await startReady(core);

  let notifiedSnapshot: unknown = null;
  let notifiedCount = 0;
  const unsubscribe = core.subscribeIndex((snapshot) => {
    notifiedCount += 1;
    notifiedSnapshot = snapshot;
  });

  const result = await core.createDoc('contract.md');
  assert.deepEqual(result, { ok: true, rel: 'contract.md' });

  const index = core.getIndex();

  // 契约 1：docs.has
  assert.equal(index.docs.has('contract.md'), true);

  // 契约 2：快照不含 tree 字段
  assert.deepEqual(Object.keys(index).sort(), ['docs']);

  // 契约 3：subscribeIndex 被通知**恰好一次**，且快照等于 getIndex()
  assert.equal(notifiedCount, 1, `subscribeIndex 应被通知恰好 1 次，实际 ${notifiedCount} 次`);
  assert.equal(notifiedSnapshot, index, '通知快照应等于 getIndex()');

  // 契约 4：modifiedMs 精确等于 vault.stat 返回值（不回退 clock.now）
  const expectedStat = await vault.stat('contract.md');
  const meta = index.docs.get('contract.md');
  assert.ok(meta, 'contract.md 元数据应存在');
  assert.equal(meta.modifiedMs, expectedStat.modifiedMs, `modifiedMs 必须等于 vault.stat 精确值：期望 ${expectedStat.modifiedMs}，实际 ${meta.modifiedMs}`);

  unsubscribe();
});

// ------------------------------------------------------------------ IPC 错误码映射表

void test('createDoc：E_VAULT_LOCKED → VAULT_LOCKED，文案区分 READONLY', async () => {
  const { core, vault } = makeHarness();
  await startReady(core);
  vault.failures.set(
    'stat',
    new EmberIpcError('vault_stat', 'E_VAULT_LOCKED', 'library locked', 'E_VAULT_LOCKED'),
  );
  const r = await core.createDoc('whatever.md');
  assert.deepEqual(r, { ok: false, reason: 'VAULT_LOCKED', message: '知识库被其他进程占用，请关闭后重试' });
});

void test('createDoc：E_READONLY → READONLY', async () => {
  const { core, vault } = makeHarness();
  await startReady(core);
  vault.failures.set(
    'stat',
    new EmberIpcError('vault_stat', 'E_READONLY', 'readonly', 'E_READONLY'),
  );
  const r = await core.createDoc('x.md');
  assert.deepEqual(r, { ok: false, reason: 'READONLY', message: '知识库当前为只读状态' });
});

void test('createDoc：E_PATH_ESCAPE / E_RESERVED_PATH → PATH_ESCAPE_VAULT', async () => {
  const { core, vault } = makeHarness();
  await startReady(core);
  vault.failures.set(
    'write',
    new EmberIpcError('vault_write', 'E_PATH_ESCAPE', 'escape', 'E_PATH_ESCAPE'),
  );
  // 让 stat 返回不存在
  vault.failures.set('stat', new EmberIpcError('vault_stat', 'E_NOT_FOUND', 'nf', 'E_NOT_FOUND'));
  const r = await core.createDoc('out-of-bounds.md');
  assert.deepEqual(r, { ok: false, reason: 'PATH_ESCAPE_VAULT', message: '路径越出知识库边界' });
});

void test('createDoc：E_PERM / E_DISK_FULL / E_IO → IO（message 原文透传）', async () => {
  for (const code of ['E_PERM', 'E_DISK_FULL', 'E_IO'] as const) {
    const { core, vault } = makeHarness();
    await startReady(core);
    vault.failures.set('stat', new EmberIpcError('vault_stat', code, `msg-${code}`, code));
    const r = await core.createDoc('x.md');
    assert.equal(r.ok, false);
    if (r.ok === false) {
      assert.equal(r.reason, 'IO', `${code} 应映射 IO，实际 ${r.reason}`);
      assert.equal(r.message, `新建失败：msg-${code}`);
    }
  }
});

void test('createDoc：未知错误码 → BAD_REQUEST + 原文 message', async () => {
  const { core, vault } = makeHarness();
  await startReady(core);
  // 用 write 失败，stat 返回不存在让它过预检
  vault.failures.set('stat', new EmberIpcError('vault_stat', 'E_NOT_FOUND', 'nf', 'E_NOT_FOUND'));
  vault.write = () => {
    throw new EmberIpcError('vault_write', 'E_AI_KEY_MISSING', 'no key', 'E_AI_KEY_MISSING');
  };
  const r = await core.createDoc('weird.md');
  assert.equal(r.ok, false);
  if (r.ok === false) {
    assert.equal(r.reason, 'BAD_REQUEST');
    assert.equal(r.message, '新建失败：no key');
  }
});

