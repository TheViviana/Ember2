/**
 * CR-20261119-13：命令总线（Command 类型 + Registry + Executor）。
 *
 * 本文件 **不引 react / src/app / src/stores**（gate:layers 要求）。
 * 命令的 execute 闭包由 AppShell（app 层）构造后通过 registry.register 注入。
 *
 * 执行器重入策略：**忽略**（isRunning 时再次触发返回 E_COMMAND_BUSY，不 pushNotice、不排队）。
 * 理由：命令多异步（新建文档需写盘、切模式需 flush），排队易产生顺序错乱；忽略是确定性策略。
 */

import type { CommandContext, CommandContextSnapshot } from './context.js';

export type CommandId = string;

export interface KeyBinding {
  readonly key: string;
  readonly meta?: boolean;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

export interface CommandEnableResult {
  /** true → 可执行；false → 禁用 */
  readonly enabled: boolean;
  /** disabled 时给的原因（显示给用户） */
  readonly reason?: string;
}

export interface Command {
  readonly id: CommandId;
  readonly title: string;
  readonly category: string; // CommandCategory 定义在 context.ts
  readonly keywords: readonly string[];
  readonly isEnabled: (ctx: CommandContextSnapshot) => CommandEnableResult;
  /** 执行；async 或 sync；失败必须 reject */
  readonly execute: (ctx: CommandContext) => Promise<void> | void;
  readonly defaultKeybinding?: ReadonlyArray<KeyBinding>;
}

export interface EnabledCommand extends Command {
  readonly enabled: boolean;
  readonly disabledReason?: string;
}

export interface CommandRegistry {
  register(commands: ReadonlyArray<Command>): void;
  unregister(id: CommandId): void;
  clear(): void;
  readonly ids: ReadonlySet<CommandId>;
  /** 按 category 分组返回所有已注册命令，带 enabled/disabled 状态 */
  list(ctx: CommandContextSnapshot): ReadonlyArray<EnabledCommand>;
  /** registry 内部查找（不做 enabled 检查） */
  getById(id: CommandId): Command | null;
}

export type CommandExecuteResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | 'E_COMMAND_NOT_FOUND'
        | 'E_COMMAND_DISABLED'
        | 'E_COMMAND_BUSY'
        | 'E_COMMAND_EXEC_FAILED';
      readonly message?: string;
    };

export interface CommandExecutor {
  execute(id: CommandId, ctx: CommandContext): Promise<CommandExecuteResult>;
  readonly isRunning: boolean;
}

// ─── Registry 实现 ───────────────────────────────────────────────

export function createCommandRegistry(): CommandRegistry {
  const map = new Map<CommandId, Command>();

  function register(commands: ReadonlyArray<Command>): void {
    for (const cmd of commands) {
      if (map.has(cmd.id)) {
        throw new Error(
          `[CommandRegistry] duplicate command id: "${cmd.id}". ` +
            `Each command must have a unique id; check for double-registration.`,
        );
      }
      map.set(cmd.id, cmd);
    }
  }

  function unregister(id: CommandId): void {
    map.delete(id);
  }

  function clear(): void {
    map.clear();
  }

  function getById(id: CommandId): Command | null {
    return map.get(id) ?? null;
  }

  function list(ctx: CommandContextSnapshot): ReadonlyArray<EnabledCommand> {
    const out: EnabledCommand[] = [];
    for (const cmd of map.values()) {
      const result = cmd.isEnabled(ctx);
      out.push({
        ...cmd,
        enabled: result.enabled,
        disabledReason: result.reason,
      });
    }
    return out;
  }

  return {
    register,
    unregister,
    clear,
    getById,
    get ids(): ReadonlySet<CommandId> {
      return new Set(map.keys());
    },
    list,
  };
}

// ─── Executor 实现 ───────────────────────────────────────────────

export interface CommandExecutorWithClose extends CommandExecutor {
  /** palette 注册其 close 回调；executor 在执行前调用 */
  setPaletteClose(fn: () => void): void;
}

export function createCommandExecutor(
  registry: CommandRegistry,
): CommandExecutorWithClose {
  let _isRunning = false;
  let _paletteClose: (() => void) | null = null;

  function setPaletteClose(fn: () => void): void {
    _paletteClose = fn;
  }

  async function execute(
    id: CommandId,
    ctx: CommandContext,
  ): Promise<CommandExecuteResult> {
    // 1. not found
    const cmd = registry.getById(id);
    if (cmd === null) {
      ctx.abilities.pushNotice(
        `命令未找到（已从注册表移除或未注册）`,
        'warning',
      );
      return { ok: false, code: 'E_COMMAND_NOT_FOUND' };
    }

    // 2. enabled 二次校验（registry.list 已做一次，executor 再做一次防止 race）
    const enabled = cmd.isEnabled(ctx.snapshot);
    if (!enabled.enabled) {
      ctx.abilities.pushNotice(enabled.reason ?? '此命令当前不可用', 'warning');
      return {
        ok: false,
        code: 'E_COMMAND_DISABLED',
        message: enabled.reason,
      };
    }

    // 3. busy check → ignore（不 pushNotice、不排队）
    if (_isRunning) {
      return { ok: false, code: 'E_COMMAND_BUSY' };
    }

    // 4. 执行前同步关闭 palette
    _paletteClose?.();

    // 5. execute
    _isRunning = true;
    try {
      const result = cmd.execute(ctx);
      if (result && typeof (result as PromiseLike<void>).then === 'function') {
        await result;
      }
      _isRunning = false;
      return { ok: true };
    } catch (err) {
      _isRunning = false;
      const message = err instanceof Error ? err.message : String(err);
      ctx.abilities.pushNotice(`命令执行失败：${message}`, 'error');
      return { ok: false, code: 'E_COMMAND_EXEC_FAILED', message };
    }
  }

  return {
    execute,
    get isRunning(): boolean {
      return _isRunning;
    },
    setPaletteClose,
  };
}
