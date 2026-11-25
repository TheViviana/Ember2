/**
 * P5-C4：关窗协调器与卸载清理（端口注入，无 DOM）。
 *
 * 覆盖：正常排空、打开超时、T_CLOSE 同刻优先、E_NOT_FOUND 复核、
 * 强制关闭观察在途写入、接受删除四分支、确认前锁定、重复请求幂等、
 * 目标缺失不得直关、卸载 release 失败上报。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCloseFlow,
  releaseOnUnmount,
  type CloseFlow,
  type CloseFlowPorts,
  type CloseFlowView,
  type CloseSaveOutcome,
  type CloseTarget,
} from '../../src/app/window-close-flow.ts';
import type { BudgetClock, CancelTimer } from '../../src/editor/save-phases.ts';

const ID = 'notes/a.md';

interface FakeTimer {
  readonly at: number;
  readonly callback: () => void;
}

interface FakeClock extends BudgetClock {
  advanceTo(target: number): void;
}

function createFakeClock(start = 0): FakeClock {
  const holder = { now: start, timers: [] as FakeTimer[] };
  return {
    now: () => holder.now,
    setTimer: (ms: number, callback: () => void): CancelTimer => {
      const timer: FakeTimer = { at: holder.now + ms, callback };
      holder.timers.push(timer);
      return () => {
        holder.timers = holder.timers.filter((candidate) => candidate !== timer);
      };
    },
    advanceTo: (target: number) => {
      holder.now = target;
      const due = holder.timers.filter((timer) => timer.at <= target);
      holder.timers = holder.timers.filter((timer) => timer.at > target);
      for (const timer of due) timer.callback();
    },
  };
}

interface FakeDoc {
  dirty: boolean;
  saving: boolean;
  externalKind: 'updated' | 'removed' | null;
  errorMessage: string | null;
}

const DIRTY: FakeDoc = {
  dirty: true,
  saving: false,
  externalKind: null,
  errorMessage: null,
};

interface Harness {
  readonly flow: CloseFlow;
  readonly calls: string[];
  readonly notices: ReadonlyArray<{ readonly message: string; readonly tone?: string }>;
  readonly clock: FakeClock;
  readonly state: { doc: FakeDoc | null };
  readonly stats: { openCalls: number; lockCalls: number };
}

function harness(config: {
  readonly doc: FakeDoc | null;
  readonly onSave?: (
    state: { doc: FakeDoc | null },
  ) => CloseSaveOutcome | Promise<CloseSaveOutcome>;
  readonly awaitOpen?: () => Promise<void>;
  readonly lockEditing?: () => Promise<void>;
}): Harness {
  const state: { doc: FakeDoc | null } = { doc: config.doc };
  const calls: string[] = [];
  const notices: Array<{ message: string; tone?: string }> = [];
  const stats = { openCalls: 0, lockCalls: 0 };
  const clock = createFakeClock(0);

  const ports: CloseFlowPorts = {
    getDoc: () => state.doc,
    hasDoc: () => state.doc !== null,
    saveDoc: () => {
      calls.push('save');
      if (config.onSave) return Promise.resolve(config.onSave(state));
      return Promise.resolve({ ok: true });
    },
    closeDoc: () => {
      calls.push('closeDoc');
    },
    closeWindow: () => {
      calls.push('closeWindow');
    },
    notice: (message, tone) => {
      notices.push({ message, tone });
    },
    now: clock.now,
    setTimer: clock.setTimer,
  };

  const flow = createCloseFlow(ports);
  const target: CloseTarget = {
    path: ID,
    token: 7,
    awaitOpen: () => {
      stats.openCalls += 1;
      return config.awaitOpen ? config.awaitOpen() : Promise.resolve();
    },
    awaitEditor: () => Promise.resolve(),
    lockEditing: () => {
      calls.push('lock');
      stats.lockCalls += 1;
      return config.lockEditing ? config.lockEditing() : Promise.resolve();
    },
    handoff: () => {
      calls.push('handoff');
    },
    resume: () => {
      calls.push('resume');
    },
  };
  flow.register(ID, target);
  return { flow, calls, notices, clock, state, stats };
}

/** 等待第一个终态视图：null（关闭完成）或 failed / confirming。 */
function terminalView(flow: CloseFlow, windowId: string): Promise<CloseFlowView | null> {
  return new Promise((resolve) => {
    const stop = flow.subscribe((id, view) => {
      if (id !== windowId) return;
      if (view !== null && view.phase === 'working') return;
      stop();
      resolve(view);
    });
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 让已 resolve 的 Promise 链走完（打开 / 句柄 / 锁定阶段）。 */
function flushMicrotasks(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

void test('关窗：接管即 handoff，dirty 保存成功后关闭窗口与文档', async () => {
  const h = harness({
    doc: { ...DIRTY },
    onSave: (state) => {
      state.doc = { ...state.doc!, dirty: false };
      return { ok: true };
    },
  });

  h.flow.requestClose(ID);
  const view = await terminalView(h.flow, ID);

  assert.equal(view, null);
  assert.deepEqual(h.calls, ['handoff', 'lock', 'save', 'closeWindow', 'closeDoc']);
  assert.equal(h.calls[0], 'handoff', '接管必须先于任何保存/卸载清理');
});

void test('关窗：openDoc 超时 → 保留窗口，失败原因 open-timeout', async () => {
  const h = harness({
    doc: { ...DIRTY },
    awaitOpen: () => new Promise<void>(() => undefined),
  });

  h.flow.requestClose(ID);
  const pending = terminalView(h.flow, ID);
  h.clock.advanceTo(5000);
  const view = await pending;

  assert.equal(view?.phase, 'failed');
  assert.equal(view?.reason, 'open-timeout');
  assert.deepEqual(h.calls, ['handoff'], '超时中止时不得锁定、保存或关窗');
});

void test('关窗：阶段计时器与 T_CLOSE 同刻触发 → end-to-end-timeout 优先', async () => {
  const h = harness({
    doc: { ...DIRTY },
    awaitOpen: () => new Promise<void>(() => undefined),
  });

  h.flow.requestClose(ID);
  const pending = terminalView(h.flow, ID);
  // 阶段计时器原定 5000ms，但时钟直接跳到 23000ms：同刻边界必须归因端到端。
  h.clock.advanceTo(23000);
  const view = await pending;

  assert.equal(view?.reason, 'end-to-end-timeout');
  assert.ok(!h.calls.includes('closeWindow'));
});

void test('关窗：E_NOT_FOUND 保存失败且 Core 仍为 removed → 冲突失败，不快速关闭', async () => {
  const h = harness({
    doc: { ...DIRTY },
    onSave: (state) => {
      state.doc = { ...state.doc!, externalKind: 'removed' };
      return { ok: false, error: { message: 'E_NOT_FOUND: file removed' } };
    },
  });

  h.flow.requestClose(ID);
  const view = await terminalView(h.flow, ID);

  assert.equal(view?.phase, 'failed');
  assert.equal(view?.reason, 'conflict-removed');
  assert.ok(!h.calls.includes('closeDoc'), '仍有 Core 文档时不得按快关丢弃');
  assert.ok(!h.calls.includes('closeWindow'));
});

void test('关窗：保存超时后强制关闭，保留 dirty 并上报在途写入失败', async () => {
  const gate = deferred<CloseSaveOutcome>();
  const h = harness({ doc: { ...DIRTY }, onSave: () => gate.promise });

  h.flow.requestClose(ID);
  const pending = terminalView(h.flow, ID);
  // 先让 open / 句柄 / 锁定落定，进入保存阶段后再推进时钟，确保触发的是保存超时。
  await flushMicrotasks();
  h.clock.advanceTo(5000);
  const view = await pending;

  assert.equal(view?.reason, 'save-timeout');
  assert.deepEqual(h.calls, ['handoff', 'lock', 'save']);

  h.flow.forceClose(ID);
  assert.deepEqual(h.calls, ['handoff', 'lock', 'save', 'closeWindow']);
  assert.ok(!h.calls.includes('closeDoc'), '强制关闭必须保留 Core dirty');

  gate.resolve({ ok: false, error: { message: '磁盘已满' } });
  await flushMicrotasks();

  const errors = h.notices.filter((notice) => notice.tone === 'error');
  assert.equal(errors.length, 1, '在途写入失败必须显式上报一次');
  assert.match(errors[0]?.message ?? '', /notes\/a\.md/);
  assert.match(errors[0]?.message ?? '', /磁盘已满/);
});

void test('关窗：编辑器目标未注册 → 中止并保留窗口，不得直接关闭', () => {
  const h = harness({ doc: { ...DIRTY } });
  // 模拟首次挂载：目标尚未注册（注册表为空）。
  const flow = createCloseFlow({
    getDoc: () => h.state.doc,
    hasDoc: () => h.state.doc !== null,
    saveDoc: () => Promise.resolve({ ok: true }),
    closeDoc: () => {
      h.calls.push('closeDoc');
    },
    closeWindow: () => {
      h.calls.push('closeWindow');
    },
    notice: () => undefined,
    now: h.clock.now,
    setTimer: h.clock.setTimer,
  });

  flow.requestClose(ID);

  const view = flow.view(ID);
  assert.equal(view?.phase, 'failed');
  assert.equal(view?.reason, 'handle-timeout');
  assert.deepEqual(h.calls, [], '目标缺失时不得关窗或触碰 Core');

  flow.forceClose(ID);
  assert.deepEqual(h.calls, ['closeWindow'], '失败面板的强制关闭是唯一逃生口');
});

void test('关窗：working / confirming 中的重复请求被忽略（幂等）', async () => {
  const gate = deferred<void>();
  const h = harness({
    doc: { ...DIRTY },
    awaitOpen: () => gate.promise,
    onSave: (state) => {
      state.doc = { ...state.doc!, dirty: false };
      return { ok: true };
    },
  });

  h.flow.requestClose(ID);
  h.flow.requestClose(ID);
  h.flow.requestClose(ID);
  assert.equal(h.stats.openCalls, 1, '重复请求不得启动第二个关闭流程');

  gate.resolve();
  const view = await terminalView(h.flow, ID);
  assert.equal(view, null);
  assert.equal(h.stats.openCalls, 1);
});

void test('接受删除：文档已不在 Core → 快关，不调用 closeDoc', () => {
  const h = harness({ doc: null });

  h.flow.requestClose(ID, 'accept-deletion');

  assert.equal(h.flow.view(ID), null);
  assert.deepEqual(h.calls, ['handoff', 'closeWindow']);
});

void test('接受删除：确认前先锁定编辑，确认后丢弃并 closeDoc（无保存）', async () => {
  const h = harness({ doc: { ...DIRTY, externalKind: 'removed' } });

  h.flow.requestClose(ID, 'accept-deletion');
  await flushMicrotasks();

  const confirming = h.flow.view(ID);
  assert.equal(confirming?.phase, 'confirming');
  assert.deepEqual(h.calls, ['handoff', 'lock'], '确认态必须已经锁定编辑');

  h.flow.confirmDiscard(ID);
  assert.deepEqual(h.calls, ['handoff', 'lock', 'closeWindow', 'closeDoc']);
  assert.equal(h.notices.some((notice) => notice.tone === 'info'), true);

  // 重复确认：视图已清除，不得第二次 closeDoc。
  h.flow.confirmDiscard(ID);
  assert.equal(h.calls.filter((call) => call === 'closeDoc').length, 1);
});

void test('接受删除：确认前磁盘变为 updated → 转冲突失败，不按旧确认丢弃', async () => {
  const h = harness({ doc: { ...DIRTY, externalKind: 'removed' } });

  h.flow.requestClose(ID, 'accept-deletion');
  await flushMicrotasks();
  assert.equal(h.flow.view(ID)?.phase, 'confirming');

  h.state.doc = { ...h.state.doc!, externalKind: 'updated' };
  h.flow.confirmDiscard(ID);

  const view = h.flow.view(ID);
  assert.equal(view?.phase, 'failed');
  assert.equal(view?.reason, 'conflict-updated');
  assert.ok(!h.calls.includes('closeDoc'));
  assert.ok(!h.calls.includes('closeWindow'));
});

void test('接受删除：确认前冲突解除 → 回正常关闭（保存后关闭，不重复加锁）', async () => {
  const h = harness({
    doc: { ...DIRTY, externalKind: 'removed' },
    onSave: (state) => {
      state.doc = { ...state.doc!, dirty: false, externalKind: null };
      return { ok: true };
    },
  });

  h.flow.requestClose(ID, 'accept-deletion');
  await flushMicrotasks();
  assert.equal(h.flow.view(ID)?.phase, 'confirming');

  h.state.doc = { ...h.state.doc!, externalKind: null };
  const pending = terminalView(h.flow, ID);
  h.flow.confirmDiscard(ID);
  const view = await pending;

  assert.equal(view, null);
  assert.deepEqual(h.calls, ['handoff', 'lock', 'save', 'closeWindow', 'closeDoc']);
  assert.equal(h.stats.lockCalls, 1, '确认态已锁定，回正常关闭不再等待句柄');
});

void test('接受删除：锁定失败 → 不进入确认态，保留窗口', async () => {
  const h = harness({
    doc: { ...DIRTY, externalKind: 'removed' },
    lockEditing: () => Promise.reject(new Error('句柄丢失')),
  });

  h.flow.requestClose(ID, 'accept-deletion');
  await flushMicrotasks();

  const view = h.flow.view(ID);
  assert.equal(view?.phase, 'failed');
  assert.equal(view?.reason, 'lock-failed');
  assert.ok(!h.calls.includes('closeDoc'));
  assert.ok(!h.calls.includes('closeWindow'));
});

void test('接受删除：确认态下的标题栏 × / 重复发起被忽略', async () => {
  const h = harness({ doc: { ...DIRTY, externalKind: 'removed' } });

  h.flow.requestClose(ID, 'accept-deletion');
  await flushMicrotasks();

  h.flow.requestClose(ID);
  h.flow.requestClose(ID, 'accept-deletion');

  assert.equal(h.flow.view(ID)?.phase, 'confirming');
  assert.equal(h.stats.lockCalls, 1, '确认态不得被重复请求打断或重复加锁');
});

void test('关窗：失败后取消 → 撤销接管、解锁并清除失败态', async () => {
  const h = harness({
    doc: { ...DIRTY },
    awaitOpen: () => new Promise<void>(() => undefined),
  });

  h.flow.requestClose(ID);
  const pending = terminalView(h.flow, ID);
  h.clock.advanceTo(5000);
  await pending;

  h.flow.cancel(ID);
  assert.equal(h.flow.view(ID), null);
  assert.ok(h.calls.includes('resume'), '取消必须恢复编辑并撤销 handoff');
});

void test('卸载清理：等待 open 落定后才 release；失败/rejection 显式上报', async () => {
  const openGate = deferred<void>();
  const order: string[] = [];
  const reported: string[] = [];

  const pending = releaseOnUnmount({
    path: ID,
    awaitOpen: openGate.promise,
    release: () => {
      order.push('release');
      return Promise.resolve({ status: 'closed' });
    },
    report: (message) => reported.push(message),
  });

  await Promise.resolve();
  assert.deepEqual(order, [], 'open 未落定时不得提前 release');

  openGate.resolve();
  await pending;
  assert.deepEqual(order, ['release']);
  assert.equal(reported.length, 0);

  await releaseOnUnmount({
    path: ID,
    awaitOpen: Promise.reject(new Error('open failed')),
    release: () => Promise.reject(new Error('磁盘只读')),
    report: (message) => reported.push(message),
  });
  assert.equal(reported.length, 1);
  assert.match(reported[0] ?? '', /notes\/a\.md/);
  assert.match(reported[0] ?? '', /磁盘只读/);

  reported.length = 0;
  await releaseOnUnmount({
    path: ID,
    awaitOpen: Promise.resolve(),
    release: () =>
      Promise.resolve({ status: 'failed', error: { message: '外部冲突' }, conflict: null }),
    report: (message) => reported.push(message),
  });
  assert.equal(reported.length, 1);
  assert.match(reported[0] ?? '', /外部冲突/);
});

void test('关窗：在飞写与后续保存统一计入 15 秒 drain 预算', async () => {
  const saveGates: Array<ReturnType<typeof deferred<CloseSaveOutcome>>> = [];
  const h = harness({
    doc: { ...DIRTY, dirty: false, saving: true },
    onSave: () => {
      const gate = deferred<CloseSaveOutcome>();
      saveGates.push(gate);
      return gate.promise;
    },
  });

  h.flow.requestClose(ID);
  await flushMicrotasks();
  assert.equal(saveGates.length, 0, '已有在飞写时先等待，不重复发起保存');

  h.state.doc = { ...DIRTY };
  h.clock.advanceTo(5000);
  await flushMicrotasks();
  assert.equal(saveGates.length, 1, '在飞写落定后进入第一轮保存');

  h.clock.advanceTo(9999);
  h.state.doc = { ...DIRTY, errorMessage: '第一轮后仍有新改动' };
  saveGates[0]?.resolve({ ok: true });
  await flushMicrotasks();
  assert.equal(saveGates.length, 2);

  h.clock.advanceTo(14998);
  h.state.doc = { ...DIRTY };
  saveGates[1]?.resolve({ ok: true });
  await flushMicrotasks();
  assert.equal(saveGates.length, 3);

  h.clock.advanceTo(15000);
  await flushMicrotasks();
  const view = h.flow.view(ID);
  assert.equal(view?.phase, 'failed');
  assert.equal(view?.reason, 'save-timeout', 'drain 到期不是端到端超时');
  assert.equal(h.clock.now(), 15000);
  assert.ok(!h.calls.includes('closeWindow'));
  assert.ok(!h.calls.includes('closeDoc'));
});
