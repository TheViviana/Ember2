/**
 * P5-C3：绑定注册表单测（纯逻辑，端口注入，无 DOM）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBindingRegistry,
  type BindingPorts,
  type BindingSaveOutcome,
} from '../../src/editor/binding.ts';

interface FakePorts extends BindingPorts {
  readonly calls: string[];
}

function fakePorts(options: {
  readonly hasDoc?: boolean;
  readonly save?: () => Promise<BindingSaveOutcome>;
} = {}): FakePorts {
  const calls: string[] = [];
  return {
    calls,
    hasDoc: () => options.hasDoc ?? true,
    saveDoc: () => {
      calls.push('save');
      return options.save ? options.save() : Promise.resolve({ ok: true });
    },
    closeDoc: () => {
      calls.push('close');
    },
  };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

void test('binding：claim 记录 windowId→path，重复 claim 同一窗幂等（StrictMode 安全）', () => {
  const registry = createBindingRegistry();
  const first = registry.claim('a.md', 'a.md');
  assert.equal(first.ok, true);
  assert.ok(first.ok);
  assert.equal(registry.getPath('a.md'), 'a.md');
  assert.equal(registry.getWindowFor('a.md'), 'a.md');
  assert.equal(registry.isOwner('a.md', 'a.md'), true);
  assert.equal(registry.size(), 1);

  const second = registry.claim('a.md', 'a.md');
  assert.ok(second.ok);
  assert.equal(second.token, first.token, '同一窗重复 claim 应复用原 token');
  assert.equal(registry.size(), 1);
});

void test('binding：过期 token 的 release 不释放当前绑定（双挂载守卫）', async () => {
  const registry = createBindingRegistry();
  const claimed = registry.claim('a.md', 'a.md');
  assert.ok(claimed.ok);

  const ports = fakePorts();
  const stale = await registry.release('a.md', claimed.token - 1, ports);
  assert.equal(stale.status, 'ignored');
  assert.equal(registry.getPath('a.md'), 'a.md', '过期 token 不得解绑');
  assert.deepEqual(ports.calls, [], '过期 token 不得触碰文档');

  // 保存期间发生重挂载（新实例以新 token 重新 claim）：save 成功后不得 closeDoc。
  const gate = deferred<BindingSaveOutcome>();
  const slowPorts = fakePorts({ save: () => gate.promise });
  const pending = registry.release('a.md', claimed.token, slowPorts);
  const reclaimed = registry.claim('a.md', 'a.md');
  assert.ok(reclaimed.ok);
  gate.resolve({ ok: true });

  const result = await pending;
  assert.equal(result.status, 'saved', '重挂载后只保存不关闭');
  assert.deepEqual(slowPorts.calls, ['save']);
  assert.equal(registry.getPath('a.md'), 'a.md', '新绑定的归属保持不变');
});

void test('binding：同一 path 第二次 claim 被拒绝，不产生第二个绑定', () => {
  const registry = createBindingRegistry();
  const first = registry.claim('a.md', 'a.md');
  assert.ok(first.ok);

  const conflict = registry.claim('other-window', 'a.md');
  assert.equal(conflict.ok, false);
  assert.ok(!conflict.ok);
  assert.equal(conflict.reason, 'doc-already-bound');
  assert.equal(conflict.windowId, 'a.md');
  assert.equal(registry.size(), 1);
  assert.equal(registry.getWindowFor('a.md'), 'a.md');
});

void test('binding：release 时 save 成功 → closeDoc 恰好调用一次', async () => {
  const registry = createBindingRegistry();
  const claimed = registry.claim('a.md', 'a.md');
  assert.ok(claimed.ok);

  const ports = fakePorts();
  const result = await registry.release('a.md', claimed.token, ports);

  assert.equal(result.status, 'closed');
  assert.deepEqual(ports.calls, ['save', 'close']);
  assert.equal(registry.size(), 0);
  assert.equal(registry.getPath('a.md'), null);
  assert.equal(registry.getWindowFor('a.md'), null);
});

void test('binding：release 时 save 失败（非冲突）→ 不 closeDoc，dirty 文档保留', async () => {
  const registry = createBindingRegistry();
  const claimed = registry.claim('a.md', 'a.md');
  assert.ok(claimed.ok);

  const ports = fakePorts({
    save: () => Promise.resolve({ ok: false, error: { message: '磁盘只读' }, conflict: null }),
  });
  const result = await registry.release('a.md', claimed.token, ports);

  assert.equal(result.status, 'failed');
  assert.equal(result.status === 'failed' ? result.error?.message : null, '磁盘只读');
  assert.deepEqual(ports.calls, ['save'], '失败时不得 closeDoc');
  assert.equal(registry.size(), 0, '绑定本身仍需释放，避免窗口复用时残留');
});

void test('binding：release 时 save 返回冲突 → 不 closeDoc，保留冲突信息', async () => {
  const registry = createBindingRegistry();
  const claimed = registry.claim('a.md', 'a.md');
  assert.ok(claimed.ok);

  const conflict = { kind: 'updated' as const, sha256: 'sha-2' };
  const ports = fakePorts({
    save: () => Promise.resolve({ ok: false, error: { message: '外部已修改' }, conflict }),
  });
  const result = await registry.release('a.md', claimed.token, ports);

  assert.equal(result.status, 'failed');
  assert.equal(result.status === 'failed' ? result.conflict : null, conflict);
  assert.deepEqual(ports.calls, ['save'], '有冲突时不得 closeDoc');
});

void test('binding：未认领的 windowId release 为空操作，不调用 save/close', async () => {
  const registry = createBindingRegistry();
  const ports = fakePorts();

  const result = await registry.release('ghost.md', 1, ports);

  assert.equal(result.status, 'ignored');
  assert.deepEqual(ports.calls, []);
  assert.equal(registry.size(), 0);
});

void test('binding：两窗绑定不同 path，释放 A 不影响 B', async () => {
  const registry = createBindingRegistry();
  const a = registry.claim('a.md', 'a.md');
  const b = registry.claim('b.md', 'b.md');
  assert.ok(a.ok);
  assert.ok(b.ok);
  assert.equal(registry.size(), 2);

  const ports = fakePorts();
  const result = await registry.release('a.md', a.token, ports);

  assert.equal(result.status, 'closed');
  assert.equal(registry.getPath('b.md'), 'b.md', 'B 的绑定不得被 A 的释放影响');
  assert.equal(registry.isOwner('b.md', 'b.md'), true);
  assert.equal(registry.size(), 1);

  const second = await registry.release('b.md', b.token, ports);
  assert.equal(second.status, 'closed');
  assert.deepEqual(ports.calls, ['save', 'close', 'save', 'close']);
});

void test('binding：handoff 后 release 只注销归属，不再 save/close（C4 协调器接管）', async () => {
  const registry = createBindingRegistry();
  const claimed = registry.claim('a.md', 'a.md');
  assert.ok(claimed.ok);

  assert.equal(registry.handoff('a.md', claimed.token - 1), false, '过期 token 不得移交代记');
  assert.equal(registry.handoff('a.md', claimed.token), true);

  const ports = fakePorts();
  const result = await registry.release('a.md', claimed.token, ports);

  assert.equal(result.status, 'handed-off');
  assert.deepEqual(ports.calls, [], '移交后卸载清理不得再次写盘/关文档');
  assert.equal(registry.size(), 0, '归属仍需注销，避免 windowId 复用残留');
  assert.equal(registry.getPath('a.md'), null);
});

void test('binding：handoff 后同窗重新 claim 清除代记，新一轮 release 恢复 save/close', async () => {
  const registry = createBindingRegistry();
  const first = registry.claim('a.md', 'a.md');
  assert.ok(first.ok);
  assert.equal(registry.handoff('a.md', first.token), true);

  // StrictMode 式重挂载：同一 windowId 重新 claim 视为新的收尾职责。
  const again = registry.claim('a.md', 'a.md');
  assert.ok(again.ok);
  assert.equal(again.token, first.token);

  const ports = fakePorts();
  const result = await registry.release('a.md', again.token, ports);
  assert.equal(result.status, 'closed');
  assert.deepEqual(ports.calls, ['save', 'close']);
});

void test('binding：revokeHandoff 撤销接管（取消关闭），release 恢复 save/close', async () => {
  const registry = createBindingRegistry();
  const claimed = registry.claim('a.md', 'a.md');
  assert.ok(claimed.ok);
  assert.equal(registry.handoff('a.md', claimed.token), true);
  assert.equal(registry.revokeHandoff('a.md', claimed.token - 1), false, '过期 token 不得撤销');
  assert.equal(registry.revokeHandoff('a.md', claimed.token), true);

  const ports = fakePorts();
  const result = await registry.release('a.md', claimed.token, ports);
  assert.equal(result.status, 'closed');
  assert.deepEqual(ports.calls, ['save', 'close']);
});

void test('binding：旧清理等待 open 时同窗重挂载 → 旧 release 不得释放新绑定（StrictMode 竞态）', async () => {
  const registry = createBindingRegistry();
  const first = registry.claim('a.md', 'a.md');
  assert.ok(first.ok);

  // 旧实例卸载：同步 retire，随后等待 openDoc 落定（模拟 releaseOnUnmount 的 await）。
  assert.equal(registry.retire('a.md', first.token), true);
  const openGate = deferred<void>();
  const ports = fakePorts();
  const delayedRelease = (async () => {
    await openGate.promise;
    return registry.release('a.md', first.token, ports);
  })();

  // StrictMode 立即重挂载：退休绑定的 claim 必须换新 token。
  const second = registry.claim('a.md', 'a.md');
  assert.ok(second.ok);
  assert.notEqual(second.token, first.token, '新实例必须被识别为新的所有者');

  openGate.resolve();
  const result = await delayedRelease;

  assert.equal(result.status, 'ignored');
  assert.deepEqual(ports.calls, [], '旧清理不得 save/close 新实例的文档');
  assert.equal(registry.isOwner('a.md', 'a.md'), true);
  assert.equal(registry.getPath('a.md'), 'a.md');
  assert.equal(registry.size(), 1);

  // 新实例仍可正常释放。
  const final = await registry.release('a.md', second.token, ports);
  assert.equal(final.status, 'closed');
  assert.deepEqual(ports.calls, ['save', 'close']);
});

void test('binding：retire 后没有新挂载，旧实例仍按常规 save/close 释放', async () => {
  const registry = createBindingRegistry();
  const claimed = registry.claim('a.md', 'a.md');
  assert.ok(claimed.ok);

  assert.equal(registry.retire('a.md', claimed.token - 1), false, '过期 token 不得退休当前实例');
  assert.equal(registry.retire('a.md', claimed.token), true);
  assert.equal(registry.retire('a.md', claimed.token), false, '重复退休返回 false');

  const ports = fakePorts();
  const result = await registry.release('a.md', claimed.token, ports);
  assert.equal(result.status, 'closed');
  assert.deepEqual(ports.calls, ['save', 'close']);
});
