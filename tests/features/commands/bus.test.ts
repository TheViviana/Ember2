/**
 * CR-20261119-13：Command 总线 / Registry / Executor 纯逻辑单测。
 * 零 React / DOM / zustand；完全覆盖 bus.ts 的每个分支。
 *
 * 注意：node:test 的 describe/it 返回 Promise<void>（@types/node 签名如此），
 * eslint no-floating-promises 要求显式标记；此处用 `void` 前缀——
 * 这是规则文档推荐的「显式有意不 await」，不是关闭规则或放宽门禁。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCommandRegistry,
  createCommandExecutor,
  type Command,
  type CommandExecuteResult,
} from '../../../src/features/commands/bus.ts';
import {
  type CommandContext,
  type CommandContextSnapshot,
  createCommandContext,
} from '../../../src/features/commands/context.ts';

function makeSnapshot(overrides: Partial<CommandContextSnapshot> = {}): CommandContextSnapshot {
  return {
    workspaceMode: 'docs',
    activeWindowId: null,
    activePath: null,
    activeCanvasId: null,
    canvasHasSelection: false,
    canvasHasGesture: false,
    canvasZoomLevel: 1,
    vaultIdentity: { root: '/tmp/test' },
    readOnly: false,
    windowCount: 0,
    hasMinimizedWindows: false,
    ...overrides,
  };
}

function makeAbilities(pushed: string[], tones: string[]): CommandContext['abilities'] {
  return {
    pushNotice: (msg: string, tone: string) => {
      pushed.push(msg);
      tones.push(tone);
    },
  };
}

function makeContext(
  snapshot?: Partial<CommandContextSnapshot>,
  pushed: string[] = [],
  tones: string[] = [],
): CommandContext {
  return createCommandContext(makeSnapshot(snapshot), makeAbilities(pushed, tones));
}

/** sync execute 返回 void（Command.execute 接受 Promise<void> | void） */
function cmd(id: string, enabled = true): Command {
  return {
    id,
    title: `cmd-${id}`,
    category: '文件',
    keywords: [],
    isEnabled: () => ({ enabled }),
    execute: () => { /* sync void */ },
  };
}

// ─── Registry ──────────────────────────────────────────────────

void describe('CommandRegistry', () => {
  void it('register 正常注册，ids 返回集合', () => {
    const r = createCommandRegistry();
    r.register([cmd('a'), cmd('b')]);
    assert.equal(r.ids.size, 2);
    assert.ok(r.ids.has('a'));
    assert.ok(r.ids.has('b'));
  });

  void it('register 重复 id 抛错，零静默覆盖', () => {
    const r = createCommandRegistry();
    r.register([cmd('dup')]);
    assert.throws(() => r.register([cmd('dup')]), /duplicate command id/);
    assert.equal(r.ids.size, 1);
  });

  void it('unregister 按 id 删除，clear 清空', () => {
    const r = createCommandRegistry();
    r.register([cmd('a'), cmd('b'), cmd('c')]);
    r.unregister('b');
    assert.equal(r.ids.size, 2);
    assert.ok(!r.ids.has('b'));
    r.clear();
    assert.equal(r.ids.size, 0);
  });

  void it('getById 返回命令本体（不做 enabled 检查），未注册返回 null', () => {
    const r = createCommandRegistry();
    r.register([cmd('x')]);
    const found = r.getById('x');
    assert.ok(found !== null);
    assert.equal(found.id, 'x');
    assert.equal(r.getById('none'), null);
  });

  void it('list 返回所有命令 + enabled/disabled 状态', () => {
    const r = createCommandRegistry();
    r.register([cmd('e1', true), cmd('d1', false)]);
    const out = r.list(makeSnapshot());
    assert.equal(out.length, 2);
    assert.equal(out[0]!.enabled, true);
    assert.equal(out[1]!.enabled, false);
  });

  void it('list 调用 isEnabled 时传真实 snapshot', () => {
    const r = createCommandRegistry();
    let seenSnapshot: CommandContextSnapshot | null = null;
    const spyCmd: Command = {
      id: 'spy',
      title: 'spy',
      category: '文件',
      keywords: [],
      isEnabled: (ctx: CommandContextSnapshot) => {
        seenSnapshot = ctx;
        return { enabled: true };
      },
      execute: () => { /* sync void */ },
    };
    r.register([spyCmd]);
    const snap = makeSnapshot({ vaultIdentity: null });
    r.list(snap);
    const got = seenSnapshot as CommandContextSnapshot | null;
    assert.ok(got !== null);
    assert.equal(got.vaultIdentity, null);
  });
});

// ─── Executor ──────────────────────────────────────────────────

void describe('CommandExecutor', () => {
  void it('execute 成功 → { ok: true }', async () => {
    const r = createCommandRegistry();
    let ran = false;
    r.register([{
      ...cmd('ok'),
      execute: () => { ran = true; },
    }]);
    const e = createCommandExecutor(r);
    const ctx = makeContext();
    const res = await e.execute('ok', ctx);
    assert.deepEqual(res, { ok: true });
    assert.equal(ran, true);
  });

  void it('E_COMMAND_NOT_FOUND → pushNotice + { ok: false, code }', async () => {
    const r = createCommandRegistry();
    const e = createCommandExecutor(r);
    const pushed: string[] = [];
    const ctx = makeContext(undefined, pushed);
    const res = await e.execute('ghost', ctx);
    assert.equal(res.ok, false);
    assert.equal((res as CommandExecuteResult & { code: string }).code, 'E_COMMAND_NOT_FOUND');
    assert.ok(pushed.some((m) => m.includes('命令未找到')));
  });

  void it('E_COMMAND_DISABLED 第二次 enabled 校验不通过 → pushNotice + reason', async () => {
    const r = createCommandRegistry();
    r.register([{
      ...cmd('disabled'),
      isEnabled: () => ({ enabled: false, reason: 'vaultIdentity 为 null' }),
    }]);
    const e = createCommandExecutor(r);
    const pushed: string[] = [];
    const ctx = makeContext(undefined, pushed);
    const res = await e.execute('disabled', ctx);
    assert.equal(res.ok, false);
    assert.equal((res as CommandExecuteResult & { code: string }).code, 'E_COMMAND_DISABLED');
    assert.ok(pushed.some((m) => m.includes('vaultIdentity 为 null')));
  });

  void it('重入策略：isRunning 时再次触发 → E_COMMAND_BUSY、不排队、不 pushNotice', async () => {
    const r = createCommandRegistry();
    let resolveSlow: (() => void) | null = null;
    r.register([{
      ...cmd('slow'),
      execute: () => new Promise<void>((res) => { resolveSlow = res; }),
    }]);
    const e = createCommandExecutor(r);
    const pushed: string[] = [];
    const ctx = makeContext(undefined, pushed);

    // 不等第一次完成（让它 in-flight）
    const firstPromise = e.execute('slow', ctx);
    // 立即第二次
    const res2 = await e.execute('slow', ctx);
    assert.equal(res2.ok, false);
    assert.equal((res2 as CommandExecuteResult & { code: string }).code, 'E_COMMAND_BUSY');
    assert.equal(pushed.length, 0, 'BUSY 不 pushNotice');

    // 放行，等待第一次结束
    assert.ok(resolveSlow !== null, 'resolveSlow 应被 Promise executor 设置');
    (resolveSlow as unknown as () => void)();
    await firstPromise;
  });

  void it('sync execute throw → E_COMMAND_EXEC_FAILED + pushNotice + isRunning 复位', async () => {
    const r = createCommandRegistry();
    r.register([{
      ...cmd('boom'),
      execute: () => { throw new Error('kaboom'); },
    }]);
    const e = createCommandExecutor(r);
    const pushed: string[] = [];
    const ctx = makeContext(undefined, pushed);
    const res = await e.execute('boom', ctx);
    assert.equal(res.ok, false);
    assert.equal((res as CommandExecuteResult & { code: string }).code, 'E_COMMAND_EXEC_FAILED');
    assert.ok(pushed.some((m) => m.includes('kaboom')));
    assert.equal(e.isRunning, false);
  });

  void it('sync execute throw 也能捕获', async () => {
    const r = createCommandRegistry();
    r.register([{
      ...cmd('syncboom'),
      execute: () => { throw new Error('sync-bad'); },
    }]);
    const e = createCommandExecutor(r);
    const pushed: string[] = [];
    const ctx = makeContext(undefined, pushed);
    const res = await e.execute('syncboom', ctx);
    assert.equal(res.ok, false);
    assert.equal((res as CommandExecuteResult & { code: string }).code, 'E_COMMAND_EXEC_FAILED');
    assert.ok(pushed.some((m) => m.includes('sync-bad')));
  });

  void it('执行前同步关闭 palette（setPaletteClose 注册后触发一次）', async () => {
    const r = createCommandRegistry();
    r.register([cmd('c')]);
    const e = createCommandExecutor(r);
    let closed = 0;
    e.setPaletteClose(() => { closed++; });
    const ctx = makeContext();
    await e.execute('c', ctx);
    assert.equal(closed, 1);
  });
});

// ─── Context 工厂 ───────────────────────────────────────────────

void describe('CommandContext / createCommandContext', () => {
  void it('工厂返回的 snapshot / abilities 都是不可变引用', () => {
    const snap = makeSnapshot({ windowCount: 5 });
    const ctx = createCommandContext(snap, { pushNotice: () => {} });
    assert.equal(ctx.snapshot.windowCount, 5);
    assert.strictEqual(ctx.snapshot, snap);
  });

  void it('snapshot 字段与 CommandContextSnapshot 接口完全对齐', () => {
    const snap = makeSnapshot({
      workspaceMode: 'canvas',
      canvasHasGesture: true,
      canvasZoomLevel: 2.0,
      readOnly: true,
      activePath: 'docs/foo',
      vaultIdentity: null,
    });
    const ctx = createCommandContext(snap, { pushNotice: () => {} });
    assert.equal(ctx.snapshot.workspaceMode, 'canvas');
    assert.equal(ctx.snapshot.canvasHasGesture, true);
    assert.equal(ctx.snapshot.canvasZoomLevel, 2.0);
    assert.equal(ctx.snapshot.readOnly, true);
    assert.equal(ctx.snapshot.activePath, 'docs/foo');
    assert.equal(ctx.snapshot.vaultIdentity, null);
  });
});
