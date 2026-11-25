import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CANVAS_SAVE_DEBOUNCE_MS,
  CanvasInteractionController,
  createCanvasHistory,
  pushCanvasHistory,
  translateCanvasHistory,
} from '../../../src/app/canvas/document-controller.ts';
import {
  createEmptyCanvasDocument,
  serializeCanvasDocument,
  type CanvasDocument,
} from '../../../src/app/canvas/format.ts';
import type { CanvasMoveCommand } from '../../../src/app/canvas/interaction.ts';

/** C6 delta 编码：dx = toX - fromX，dy 固定 10（模拟 y 方向位移）。 */
function move(id: string, fromX: number, toX: number): CanvasMoveCommand {
  return {
    kind: 'move',
    entries: [{ id, dx: toX - fromX, dy: 10 }],
  };
}

function documentWith(x = 0): CanvasDocument {
  return {
    ...createEmptyCanvasDocument(),
    lastOrigin: { x: 17, y: -29 },
    nodes: [{ id: 'a', label: 'A', x, y: 0, custom: { kept: true } }],
    edges: [
      {
        id: 'untouched',
        from: { nodeId: 'a', portId: 'out' },
        to: { nodeId: 'a', portId: 'in' },
        custom: true,
      },
    ],
    unknown: { kept: true },
  };
}

function scheduler(): {
  schedule: (callback: () => void, delayMs: number) => number;
  cancel: (handle: unknown) => void;
  run: () => void;
  delays: readonly number[];
  size: () => number;
} {
  let next = 0;
  const callbacks = new Map<number, () => void>();
  const delays: number[] = [];
  return {
    schedule(callback, delayMs): number {
      next += 1;
      callbacks.set(next, callback);
      delays.push(delayMs);
      return next;
    },
    cancel(handle): void {
      callbacks.delete(handle as number);
    },
    run(): void {
      const first = callbacks.entries().next().value;
      if (first === undefined) return;
      callbacks.delete(first[0]);
      first[1]();
    },
    delays,
    size: () => callbacks.size,
  };
}

void test('一次拖拽一条 move，undo/redo 往返且未知字段原样保留', async () => {
  const patches: string[] = [];
  const controller = new CanvasInteractionController({
    canvasId: 'c4',
    document: documentWith(),
    store: {
      save: () => Promise.resolve({}),
      open: () => Promise.resolve({ exists: true, text: null, sha256: 'sha', modifiedMs: null }),
    },
    applyPositions: (positions) => patches.push(JSON.stringify(positions)),
    onConflict: () => undefined,
    schedule: () => 1,
    cancelSchedule: () => undefined,
  });

  assert.equal(controller.commit(move('a', 0, 40)), true);
  assert.deepEqual(controller.getDocument().nodes[0], {
    id: 'a',
    label: 'A',
    x: 40,
    y: 10,
    custom: { kept: true },
  });
  assert.equal(controller.getDocument().unknown !== undefined, true);
  assert.equal(controller.getHistory().past.length, 1);

  assert.equal(controller.undo(), true);
  assert.deepEqual(controller.getDocument().nodes[0], {
    id: 'a',
    label: 'A',
    x: 0,
    y: 0,
    custom: { kept: true },
  });
  assert.equal(controller.redo(), true);
  assert.equal((controller.getDocument().nodes[0] as { x: number }).x, 40);
  assert.equal(patches.length, 3);
  await controller.flushSave();
});

void test('历史上限 100，超出丢最旧；选中没有入口、不会入栈', () => {
  let history = createCanvasHistory();
  // dx 随 index 递增，便于区分最旧/最新命令
  for (let index = 0; index <= 100; index += 1) {
    history = pushCanvasHistory(history, move('a', 0, index));
  }

  assert.equal(history.past.length, 100);
  // 最旧保留的是 index=1（dx=1），index=0 被挤出
  assert.equal(history.past[0]?.entries[0]?.dx, 1);
  // 最新是 index=100（dx=100）
  assert.equal(history.past.at(-1)?.entries[0]?.dx, 100);
});

void test('300ms 防抖合并提交，dispose 前 flushSave 立即发最新文档', async () => {
  const timers = scheduler();
  const saved: string[] = [];
  const controller = new CanvasInteractionController({
    canvasId: 'c4',
    document: documentWith(),
    store: {
      save: (_id, text) => {
        saved.push(text);
        return Promise.resolve({});
      },
      open: () => Promise.resolve({ exists: true, text: null, sha256: 'sha', modifiedMs: null }),
    },
    applyPositions: () => undefined,
    onConflict: () => undefined,
    schedule: timers.schedule,
    cancelSchedule: timers.cancel,
  });

  controller.commit(move('a', 0, 10));
  controller.commit(move('a', 10, 20));
  assert.deepEqual(timers.delays, [CANVAS_SAVE_DEBOUNCE_MS, CANVAS_SAVE_DEBOUNCE_MS]);
  assert.equal(saved.length, 0);
  assert.equal(timers.size(), 1);

  timers.run();
  await controller.flushSave();
  assert.equal(saved.length, 1);
  assert.match(saved[0] ?? '', /"x": 20/);

  controller.undo();
  assert.equal(timers.size(), 1);
  await controller.flushSave();
  assert.equal(timers.size(), 0, 'flushSave 取消防抖');
  assert.equal(saved.length, 2);
  assert.match(saved[1] ?? '', /"x": 10/);
});

void test('E_CONFLICT：只读 + 一次性提示，禁新提交/保存，undo/redo 仍可用', async () => {
  const timers = scheduler();
  let saves = 0;
  let notices = 0;
  const conflict = Object.assign(new Error('conflict'), { code: 'E_CONFLICT' });
  const controller = new CanvasInteractionController({
    canvasId: 'c4',
    document: documentWith(),
    store: {
      save: () => {
        saves += 1;
        return Promise.reject(conflict);
      },
      open: () => Promise.resolve({ exists: true, text: null, sha256: 'sha', modifiedMs: null }),
    },
    applyPositions: () => undefined,
    onConflict: () => {
      notices += 1;
    },
    schedule: timers.schedule,
    cancelSchedule: timers.cancel,
  });

  controller.commit(move('a', 0, 40));
  await assert.rejects(controller.flushSave(), /conflict/);
  assert.equal(controller.isReadOnly(), true);
  assert.equal(notices, 1);
  assert.equal(controller.commit(move('a', 40, 80)), false, '冲突后禁止新编辑');
  assert.equal(controller.undo(), true, '冲突后允许撤销');
  assert.equal(controller.redo(), true);
  await controller.flushSave();
  await controller.flushSave();
  assert.equal(saves, 1, '只读期间不再调用 save，不覆盖外部修改');
  assert.equal(notices, 1);
});

void test('rebase 平移文档但 past/future 的 delta 不变（delta 是相对位移），不产生新命令', async () => {
  const controller = new CanvasInteractionController({
    canvasId: 'c4',
    document: documentWith(),
    store: {
      save: () => Promise.resolve({}),
      open: () => Promise.resolve({ exists: true, text: null, sha256: 'sha', modifiedMs: null }),
    },
    applyPositions: () => undefined,
    onConflict: () => undefined,
    schedule: () => 1,
    cancelSchedule: () => undefined,
  });
  // 两次 move 都是 dx=40, dy=10；undo 后节点回到 (40, 10)
  controller.commit(move('a', 0, 40));
  controller.commit(move('a', 40, 80));
  controller.undo();
  const depth = controller.getHistory().past.length + controller.getHistory().future.length;

  controller.rebase({ x: 24, y: -48 });
  assert.equal(controller.getHistory().past.length + controller.getHistory().future.length, depth);
  assert.deepEqual(controller.getDocument().lastOrigin, { x: 41, y: -77 });
  // undo 后节点在 (40, 10)，rebase {24,-48} → (64, -38)
  assert.deepEqual(controller.getDocument().nodes[0], {
    id: 'a',
    label: 'A',
    x: 64,
    y: -38,
    custom: { kept: true },
  });
  // delta 编码：past/future 的 dx/dy 不受整体平移影响，保持不变
  assert.deepEqual(controller.getHistory().past[0]?.entries[0], { id: 'a', dx: 40, dy: 10 });
  assert.deepEqual(controller.getHistory().future[0]?.entries[0], { id: 'a', dx: 40, dy: 10 });

  // translateCanvasHistory 退化为 identity
  const translated = translateCanvasHistory(controller.getHistory(), { x: -24, y: 48 });
  assert.deepEqual(translated.past[0]?.entries[0], { id: 'a', dx: 40, dy: 10 });
  await controller.flushSave();
});

void test('C5 resolveConflict keep-local：刷新 sha 后覆盖外部，readOnly 解除', async () => {
  const conflict = Object.assign(new Error('conflict'), { code: 'E_CONFLICT' });
  let saveCalls = 0;
  let openCalls = 0;
  const saved: string[] = [];
  const controller = new CanvasInteractionController({
    canvasId: 'c5',
    document: documentWith(0),
    store: {
      open: () => {
        openCalls += 1;
        return Promise.resolve({ exists: true, text: 'external', sha256: 'sha-ext', modifiedMs: 1 });
      },
      save: (_id, text) => {
        saveCalls += 1;
        saved.push(text);
        // 第一次冲突，resolve 后重试成功
        if (saveCalls === 1) return Promise.reject(conflict);
        return Promise.resolve({});
      },
    },
    applyPositions: () => undefined,
    onConflict: () => undefined,
    schedule: () => 1,
    cancelSchedule: () => undefined,
  });

  controller.commit(move('a', 0, 40));
  await assert.rejects(controller.flushSave(), /conflict/);
  assert.equal(controller.isReadOnly(), true, '冲突后进入只读');

  const ok = await controller.resolveConflict('keep-local');
  assert.equal(ok, true);
  assert.equal(controller.isReadOnly(), false, '保留本地成功后解除只读');
  assert.equal(openCalls, 1, 'keep-local 先 open 刷新 core sha');
  assert.equal(saveCalls, 2, '重试一次 save');
  assert.match(saved[1] ?? '', /"x": 40/, '保存的是本地版本（x=40），覆盖外部');
});

void test('C5 resolveConflict keep-local 重试仍冲突时保持只读', async () => {
  const conflict = Object.assign(new Error('conflict'), { code: 'E_CONFLICT' });
  let saveCalls = 0;
  const controller = new CanvasInteractionController({
    canvasId: 'c5',
    document: documentWith(0),
    store: {
      open: () => Promise.resolve({ exists: true, text: 'ext', sha256: 'sha-ext', modifiedMs: 1 }),
      save: () => {
        saveCalls += 1;
        return Promise.reject(conflict);
      },
    },
    applyPositions: () => undefined,
    onConflict: () => undefined,
    schedule: () => 1,
    cancelSchedule: () => undefined,
  });

  controller.commit(move('a', 0, 40));
  await assert.rejects(controller.flushSave(), /conflict/);
  const ok = await controller.resolveConflict('keep-local');
  assert.equal(ok, false);
  assert.equal(controller.isReadOnly(), true, '重试仍冲突，保持只读');
  assert.equal(saveCalls, 2);
});

void test('C5 resolveConflict accept-external：加载外部版本，清空历史', async () => {
  const conflict = Object.assign(new Error('conflict'), { code: 'E_CONFLICT' });
  let openCalls = 0;
  const externalDoc = serializeCanvasDocument({
    ...createEmptyCanvasDocument(),
    nodes: [{ id: 'ext', label: 'External', x: 999, y: 888 }],
  });
  const controller = new CanvasInteractionController({
    canvasId: 'c5',
    document: documentWith(0),
    store: {
      open: () => {
        openCalls += 1;
        return Promise.resolve({
          exists: true,
          text: externalDoc,
          sha256: 'sha-ext',
          modifiedMs: 1,
        });
      },
      save: () => Promise.reject(conflict),
    },
    applyPositions: () => undefined,
    onConflict: () => undefined,
    schedule: () => 1,
    cancelSchedule: () => undefined,
  });

  controller.commit(move('a', 0, 40));
  await assert.rejects(controller.flushSave(), /conflict/);
  assert.equal(controller.getHistory().past.length, 1, '冲突前已有一条历史');

  const ok = await controller.resolveConflict('accept-external');
  assert.equal(ok, true);
  assert.equal(controller.isReadOnly(), false);
  assert.equal(openCalls, 1);
  assert.equal((controller.getDocument().nodes[0] as { id: string }).id, 'ext', '文档替换为外部版本');
  assert.equal((controller.getDocument().nodes[0] as { x: number }).x, 999);
  assert.equal(controller.getHistory().past.length, 0, '接受外部后历史清空');
  assert.equal(controller.getHistory().future.length, 0);
});

void test('C5 resolveConflict 非冲突态返回 false', async () => {
  const controller = new CanvasInteractionController({
    canvasId: 'c5',
    document: documentWith(0),
    store: {
      save: () => Promise.resolve({}),
      open: () => Promise.resolve({ exists: true, text: null, sha256: 'sha', modifiedMs: null }),
    },
    applyPositions: () => undefined,
    onConflict: () => undefined,
    schedule: () => 1,
    cancelSchedule: () => undefined,
  });
  assert.equal(controller.isReadOnly(), false);
  assert.equal(await controller.resolveConflict('keep-local'), false);
  assert.equal(await controller.resolveConflict('accept-external'), false);
});

void test('C5 冲突后 undo/redo 仍可用且不触盘（3A 不回归）', async () => {
  const conflict = Object.assign(new Error('conflict'), { code: 'E_CONFLICT' });
  let saves = 0;
  const controller = new CanvasInteractionController({
    canvasId: 'c5',
    document: documentWith(0),
    store: {
      save: () => {
        saves += 1;
        return Promise.reject(conflict);
      },
      open: () => Promise.resolve({ exists: true, text: null, sha256: 'sha', modifiedMs: null }),
    },
    applyPositions: () => undefined,
    onConflict: () => undefined,
    schedule: () => 1,
    cancelSchedule: () => undefined,
  });

  controller.commit(move('a', 0, 40));
  await assert.rejects(controller.flushSave(), /conflict/);
  assert.equal(controller.isReadOnly(), true);
  assert.equal(controller.undo(), true, '冲突后允许 undo');
  assert.equal(controller.redo(), true, '冲突后允许 redo');
  assert.equal(controller.commit(move('a', 40, 80)), false, '冲突后禁止新 commit');
  assert.equal(saves, 1, 'undo/redo 不触发 save，不触盘');
});

/**
 * C6 delta 编码专项测试
 */

void test('C6 delta：连续 undo/redo 往返坐标精确（1e-9 等价）', () => {
  const controller = new CanvasInteractionController({
    canvasId: 'c6',
    document: documentWith(0),
    store: {
      save: () => Promise.resolve({}),
      open: () => Promise.resolve({ exists: true, text: null, sha256: 'sha', modifiedMs: null }),
    },
    applyPositions: () => undefined,
    onConflict: () => undefined,
    schedule: () => 1,
    cancelSchedule: () => undefined,
  });

  // 浮点数位移，验证 delta 累加不引入额外误差（1e-9 容差）
  const approx = (actual: number, expected: number) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} !≈ ${expected}`);
  controller.commit({ kind: 'move', entries: [{ id: 'a', dx: 0.1, dy: 0.2 }] });
  controller.commit({ kind: 'move', entries: [{ id: 'a', dx: 0.3, dy: 0.4 }] });
  // 当前：0 + 0.1 + 0.3 = 0.4, 0 + 0.2 + 0.4 = 0.6
  approx((controller.getDocument().nodes[0] as { x: number; y: number }).x, 0.4);
  approx((controller.getDocument().nodes[0] as { x: number; y: number }).y, 0.6);

  controller.undo(); // 0.4 - 0.3 = 0.1
  controller.undo(); // 0.1 - 0.1 = 0
  approx((controller.getDocument().nodes[0] as { x: number }).x, 0);
  approx((controller.getDocument().nodes[0] as { x: number; y: number }).y, 0);

  controller.redo(); // 0 + 0.1 = 0.1
  controller.redo(); // 0.1 + 0.3 = 0.4
  approx((controller.getDocument().nodes[0] as { x: number }).x, 0.4);
});

void test('C6 delta：多节点交错移动后 undo/redo 不错位（S1 风险）', () => {
  const doc = {
    ...createEmptyCanvasDocument(),
    lastOrigin: { x: 0, y: 0 },
    nodes: [
      { id: 'a', label: 'A', x: 0, y: 0 },
      { id: 'b', label: 'B', x: 100, y: 100 },
    ],
    edges: [],
  };
  const controller = new CanvasInteractionController({
    canvasId: 'c6',
    document: doc,
    store: {
      save: () => Promise.resolve({}),
      open: () => Promise.resolve({ exists: true, text: null, sha256: 'sha', modifiedMs: null }),
    },
    applyPositions: () => undefined,
    onConflict: () => undefined,
    schedule: () => 1,
    cancelSchedule: () => undefined,
  });

  // 交错移动：先 a，再 b，再 a
  controller.commit({ kind: 'move', entries: [{ id: 'a', dx: 10, dy: 0 }] }); // a→(10,0)
  controller.commit({ kind: 'move', entries: [{ id: 'b', dx: 0, dy: 20 }] }); // b→(100,120)
  controller.commit({ kind: 'move', entries: [{ id: 'a', dx: 5, dy: 5 }] }); // a→(15,5)

  const ax = () => (controller.getDocument().nodes[0] as { x: number; y: number }).x;
  const ay = () => (controller.getDocument().nodes[0] as { x: number; y: number }).y;
  const bx = () => (controller.getDocument().nodes[1] as { x: number; y: number }).x;
  const by = () => (controller.getDocument().nodes[1] as { x: number; y: number }).y;

  assert.equal(ax(), 15);
  assert.equal(ay(), 5);
  assert.equal(bx(), 100);
  assert.equal(by(), 120);

  // undo 第三次（a 的第二次移动）：a 回到 (10, 0)
  controller.undo();
  assert.equal(ax(), 10);
  assert.equal(ay(), 0);
  assert.equal(bx(), 100); // b 不受影响
  assert.equal(by(), 120);

  // undo 第二次（b 的移动）：b 回到 (100, 100)
  controller.undo();
  assert.equal(bx(), 100);
  assert.equal(by(), 100);
  assert.equal(ax(), 10); // a 不受影响

  // undo 第一次（a 的第一次移动）：a 回到 (0, 0)
  controller.undo();
  assert.equal(ax(), 0);
  assert.equal(ay(), 0);

  // redo 全部回来
  controller.redo();
  controller.redo();
  controller.redo();
  assert.equal(ax(), 15);
  assert.equal(ay(), 5);
  assert.equal(bx(), 100);
  assert.equal(by(), 120);
});

void test('C6 delta：序列化后 JSON 长度比 from/to 结构减少约 50%（数值载荷）', () => {
  const entries = 500;
  const deltaCommand = {
    kind: 'move',
    entries: Array.from({ length: entries }, (_, i) => ({ id: `n${i}`, dx: i + 1, dy: i + 2 })),
  };
  // 模拟 from/to 结构（旧格式）做对比
  const fromToCommand = {
    kind: 'move',
    entries: Array.from({ length: entries }, (_, i) => ({
      id: `n${i}`,
      from: { x: i, y: i },
      to: { x: i + 1, y: i + 2 },
    })),
  };

  const deltaLen = JSON.stringify(deltaCommand).length;
  const fromToLen = JSON.stringify(fromToCommand).length;
  // delta 去掉 from/to 两个 Point（4 个 number）→ 保留 2 个 number，数值载荷压缩约 50%
  // 含 id 字符串后整体压缩约 30–40%
  assert.ok(deltaLen < fromToLen, 'delta 序列化长度必须小于 from/to');
  const ratio = deltaLen / fromToLen;
  assert.ok(ratio < 0.7, `压缩比应 < 0.7，实际 ${ratio.toFixed(3)}`);
  assert.ok(ratio > 0.4, `压缩比应 > 0.4（id 不可压），实际 ${ratio.toFixed(3)}`);
});

void test('防抖保存 E_IO：显式上报一次，dirty 保留且可显式重试成功', async () => {
  const timers = scheduler();
  const errors: { readonly code: string; readonly message: string }[] = [];
  let conflicts = 0;
  let saves = 0;
  const controller = new CanvasInteractionController({
    canvasId: 'c4',
    document: documentWith(),
    store: {
      save: () => {
        saves += 1;
        if (saves === 1) {
          return Promise.reject(Object.assign(new Error('disk unavailable'), { code: 'E_IO' }));
        }
        return Promise.resolve({});
      },
      open: () => Promise.resolve({ exists: true, text: null, sha256: 'sha', modifiedMs: null }),
    },
    applyPositions: () => undefined,
    onConflict: () => {
      conflicts += 1;
    },
    onSaveError: (error) => errors.push(error),
    schedule: timers.schedule,
    cancelSchedule: timers.cancel,
  });

  controller.commit(move('a', 0, 40));
  timers.run();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  assert.deepEqual(errors, [{ code: 'E_IO', message: 'disk unavailable' }]);
  assert.equal(conflicts, 0);
  assert.equal(saves, 1, '失败后不自动重试');
  await controller.flushSave();
  assert.equal(saves, 2, 'dirty 未丢失，显式 flushSave 会重试');
  assert.deepEqual(errors, [{ code: 'E_IO', message: 'disk unavailable' }]);
});

void test('防抖保存 E_CONFLICT：只走一次性冲突通知，不重复上报保存错误', async () => {
  const timers = scheduler();
  const errors: { readonly code: string; readonly message: string }[] = [];
  let conflicts = 0;
  let saves = 0;
  const controller = new CanvasInteractionController({
    canvasId: 'c4',
    document: documentWith(),
    store: {
      save: () => {
        saves += 1;
        return Promise.reject(Object.assign(new Error('conflict'), { code: 'E_CONFLICT' }));
      },
      open: () => Promise.resolve({ exists: true, text: null, sha256: 'sha', modifiedMs: null }),
    },
    applyPositions: () => undefined,
    onConflict: () => {
      conflicts += 1;
    },
    onSaveError: (error) => errors.push(error),
    schedule: timers.schedule,
    cancelSchedule: timers.cancel,
  });

  controller.commit(move('a', 0, 40));
  timers.run();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  assert.equal(conflicts, 1);
  assert.deepEqual(errors, []);
  assert.equal(controller.isReadOnly(), true);
  assert.equal(saves, 1);
  await controller.flushSave();
  assert.equal(conflicts, 1);
  assert.deepEqual(errors, []);
});
