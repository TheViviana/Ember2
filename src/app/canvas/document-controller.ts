/**
 * C4 可写文档、统一可逆历史与保存编排。只依赖 format 的结构化类型与
 * `#canvas-format` 的公共 API；错误文案经 core/errors 收敛。
 *
 * C0-B B4：所有文档变更（含 move）统一经 `mutate` 应用并进入同一 past/future 栈；
 * move 仍沿用 C6 delta 与 rebase 语义。一次 pointerup commit 至多入栈一条记录，
 * 300ms 防抖保存不变。
 */
import {
  mutate,
  type CanvasCommand,
  type CanvasSchemaIssue,
} from '#canvas-format';
import { parseCanvasDocument, serializeCanvasDocument, type CanvasDocument } from './format.ts';
import type { CanvasMoveCommand, CanvasMoveEntry } from './interaction.ts';
import { inspectCanvasDocument } from './schema-adapter.ts';
import { extractNodes, readOrigin } from './node-layout.ts';
import type { Point } from './viewport.ts';
import { formatUnknownError } from '../../core/errors.ts';
import type { CanvasStore } from '../../core/canvas/ports.ts';

export const CANVAS_HISTORY_LIMIT = 100;
export const CANVAS_SAVE_DEBOUNCE_MS = 300;

export interface CanvasOpenResult {
  readonly exists: boolean;
  readonly text: string | null;
  readonly sha256: string;
  readonly modifiedMs: number | null;
}

/** CR-R2-6：保存契约单源——open 取自 core，save 只 await 不读返回值。 */
export type CanvasSaveStore = Pick<CanvasStore, 'open'> & {
  readonly save: (id: string, text: string) => Promise<unknown>;
};

/** 一条可逆历史：forward 按原序 redo，inverse 已按整批 undo 顺序排列。 */
export interface CanvasHistoryEntry {
  readonly kind: CanvasCommand['kind'];
  /** 仅 move 携带 delta；非 move 恒为空数组（保持既有 move 历史读取契约）。 */
  readonly entries: readonly CanvasMoveEntry[];
  readonly commands: readonly CanvasCommand[];
  readonly inverse: readonly CanvasCommand[];
}

export interface CanvasHistory {
  /** 从旧到新；最新记录在末尾。 */
  readonly past: readonly CanvasHistoryEntry[];
  /** 从新到旧；下一条 redo 在开头。 */
  readonly future: readonly CanvasHistoryEntry[];
}

export interface CanvasPositionPatch {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

export interface CanvasCommandFailure {
  readonly commandIndex: number;
  readonly code: string;
  readonly message: string;
}

export interface CanvasInteractionControllerOptions {
  readonly canvasId: string;
  readonly store: CanvasSaveStore;
  readonly document: CanvasDocument;
  readonly applyPositions: (positions: readonly CanvasPositionPatch[]) => void;
  readonly onConflict: () => void;
  readonly onSaveError?: (error: {
    readonly code: string;
    readonly message: string;
  }) => void;
  readonly onCommandError?: (error: CanvasCommandFailure) => void;
  /** R8=A：挂载前 inspection 已判定整幅只读。 */
  readonly readOnly?: boolean;
  readonly issues?: readonly CanvasSchemaIssue[];
  readonly schedule?: (callback: () => void, delayMs: number) => unknown;
  readonly cancelSchedule?: (handle: unknown) => void;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createCanvasHistory(): CanvasHistory {
  return { past: [], future: [] };
}

function pushHistoryEntry(history: CanvasHistory, entry: CanvasHistoryEntry): CanvasHistory {
  return {
    past: [...history.past, entry].slice(-CANVAS_HISTORY_LIMIT),
    future: [],
  };
}

function moveInverse(entries: readonly CanvasMoveEntry[]): CanvasCommand {
  return {
    kind: 'move',
    entries: entries.map(({ id, dx, dy }) => ({ id, dx: -dx, dy: -dy })),
  };
}

/** 保留既有 move 入口：写入统一历史，inverse 由 delta 取反得到。 */
export function pushCanvasHistory(history: CanvasHistory, command: CanvasMoveCommand): CanvasHistory {
  return pushHistoryEntry(history, {
    kind: 'move',
    entries: command.entries,
    commands: [command],
    inverse: [moveInverse(command.entries)],
  });
}

function pushCommandHistory(
  history: CanvasHistory,
  commands: readonly CanvasCommand[],
  inverse: readonly CanvasCommand[],
): CanvasHistory {
  const first = commands[0];
  return pushHistoryEntry(history, {
    kind: first?.kind ?? 'move',
    entries: first?.kind === 'move' ? first.entries : [],
    commands,
    inverse,
  });
}

export function undoCanvasHistory(
  history: CanvasHistory,
): { readonly history: CanvasHistory; readonly entry: CanvasHistoryEntry } | null {
  const entry = history.past.at(-1);
  if (entry === undefined) return null;
  return {
    history: { past: history.past.slice(0, -1), future: [entry, ...history.future] },
    entry,
  };
}

export function redoCanvasHistory(
  history: CanvasHistory,
): { readonly history: CanvasHistory; readonly entry: CanvasHistoryEntry } | null {
  const entry = history.future[0];
  if (entry === undefined) return null;
  return {
    history: { past: [...history.past, entry], future: history.future.slice(1) },
    entry,
  };
}

/**
 * C6 delta 编码下，move 命令存的是相对位移 dx/dy，文档整体平移（rebase）不改变 delta。
 * 因此 translateCanvasHistory 退化为 identity：past/future 无需平移。
 * 保留函数签名与导出以兼容调用方与测试。
 */
export function translateCanvasHistory(history: CanvasHistory, _offset: Point): CanvasHistory {
  return history;
}

function errorCode(error: unknown): string | null {
  if (!isRecord(error)) return null;
  if (typeof error.code === 'string') return error.code;
  return isRecord(error.error) && typeof error.error.code === 'string' ? error.error.code : null;
}

export class CanvasInteractionController {
  readonly canvasId: string;
  private readonly store: CanvasSaveStore;
  private readonly applyPositions: (positions: readonly CanvasPositionPatch[]) => void;
  private readonly onConflict: () => void;
  private readonly onSaveError: CanvasInteractionControllerOptions['onSaveError'];
  private readonly onCommandError: CanvasInteractionControllerOptions['onCommandError'];
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancelSchedule: (handle: unknown) => void;
  private document: CanvasDocument;
  private issues: readonly CanvasSchemaIssue[];
  private history = createCanvasHistory();
  private timer: unknown = null;
  private inFlight: Promise<void> | null = null;
  private dirty = false;
  private readOnly: boolean;
  private conflictNotified = false;

  constructor(options: CanvasInteractionControllerOptions) {
    this.canvasId = options.canvasId;
    this.store = options.store;
    this.document = options.document;
    this.issues = options.issues ?? [];
    this.readOnly = options.readOnly ?? false;
    this.applyPositions = options.applyPositions;
    this.onConflict = options.onConflict;
    this.onSaveError = options.onSaveError;
    this.onCommandError = options.onCommandError;
    this.schedule =
      options.schedule ??
      ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.cancelSchedule =
      options.cancelSchedule ??
      ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>));
  }

  getDocument(): CanvasDocument {
    return this.document;
  }

  getHistory(): CanvasHistory {
    return this.history;
  }

  getIssues(): readonly CanvasSchemaIssue[] {
    return this.issues;
  }

  isReadOnly(): boolean {
    return this.readOnly;
  }

  serialize(): string {
    return serializeCanvasDocument(this.document);
  }

  /** 统一命令入口：任一失败整批不应用，history 不推进。 */
  execute(commands: readonly CanvasCommand[]): boolean {
    if (this.readOnly || commands.length === 0) return false;
    const result = mutate(this.document, commands);
    if (!result.ok) {
      if (result.kind === 'document') {
        this.issues = result.issues;
        this.readOnly = true;
        return false;
      }
      const first = result.errors[0];
      if (first !== undefined) {
        this.onCommandError?.({
          commandIndex: first.commandIndex,
          code: first.code,
          message: first.message,
        });
      }
      return false;
    }
    this.document = result.document;
    this.issues = result.inspection.issues;
    this.history = pushCommandHistory(this.history, commands, result.inverse);
    this.applyPositions(extractNodes(this.document));
    this.markDirty();
    return true;
  }

  /** 既有 move 入口；空 entries 不产生历史（保持 C4 契约）。 */
  commit(command: CanvasMoveCommand): boolean {
    if (command.entries.length === 0) return false;
    return this.execute([command]);
  }

  undo(): boolean {
    const result = undoCanvasHistory(this.history);
    if (result === null) return false;
    const applied = mutate(this.document, result.entry.inverse);
    if (!applied.ok) return false;
    this.document = applied.document;
    this.issues = applied.inspection.issues;
    this.history = result.history;
    this.applyPositions(extractNodes(this.document));
    this.markDirty();
    return true;
  }

  redo(): boolean {
    const result = redoCanvasHistory(this.history);
    if (result === null) return false;
    const applied = mutate(this.document, result.entry.commands);
    if (!applied.ok) return false;
    this.document = applied.document;
    this.issues = applied.inspection.issues;
    this.history = result.history;
    this.applyPositions(extractNodes(this.document));
    this.markDirty();
    return true;
  }

  /**
   * C5 冲突合并 C：二选一解决 E_CONFLICT 只读态。
   * - keep-local：open 刷新 core sha 后用本地文档重试 save，覆盖外部版本。
   * - accept-external：丢弃本地改动，加载外部版本并清空历史栈；
   *   外部版本若仍含 schema issues，按 R8=A 保持整幅只读。
   * 仅在 readOnly 态有效；非冲突态返回 false。
   */
  async resolveConflict(action: 'keep-local' | 'accept-external'): Promise<boolean> {
    if (!this.readOnly) return false;
    if (this.timer !== null) {
      this.cancelSchedule(this.timer);
      this.timer = null;
    }
    try {
      if (action === 'keep-local') {
        // open 刷新 core 内部 state.sha256 为外部版本 sha；
        // 随后 flushSave 用本地文档 + 新 expectedSha 写入，覆盖外部。
        await this.store.open(this.canvasId);
        this.readOnly = false;
        this.conflictNotified = false;
        await this.flushSave();
        return !this.readOnly;
      }
      // accept-external
      const opened = await this.store.open(this.canvasId);
      const document = parseCanvasDocument(opened.text ?? '');
      const schema = inspectCanvasDocument(document);
      this.document = document;
      this.issues = schema.issues;
      this.history = createCanvasHistory();
      this.readOnly = schema.readOnly;
      this.conflictNotified = false;
      this.dirty = false;
      this.applyPositions(extractNodes(this.document));
      return true;
    } catch {
      // keep-local 重试失败时 flushSave 已将 readOnly 置回 true；
      // accept-external 的 open 失败时保持只读。
      return false;
    }
  }

  /** 自动 rebase 不新增命令；文档、lastOrigin、past/future 一次性同步平移。 */
  rebase(offset: Point): void {
    if (this.readOnly) return;
    const origin = readOrigin(this.document);
    this.document = {
      ...this.document,
      lastOrigin: { x: origin.x + offset.x, y: origin.y + offset.y },
      nodes: this.document.nodes.map((raw) => {
        if (!isRecord(raw) || typeof raw.x !== 'number' || typeof raw.y !== 'number') return raw;
        if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return raw;
        return { ...raw, x: raw.x + offset.x, y: raw.y + offset.y };
      }),
    };
    this.history = translateCanvasHistory(this.history, offset);
    this.applyPositions(extractNodes(this.document));
    this.markDirty();
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.readOnly) return;
    if (this.timer !== null) this.cancelSchedule(this.timer);
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.flushSave().catch((error: unknown) => {
        const code = errorCode(error);
        if (code === 'E_CONFLICT') return;
        this.onSaveError?.({
          code: code ?? 'E_UNKNOWN',
          message: formatUnknownError(error, '未知保存错误'),
        });
      });
    }, CANVAS_SAVE_DEBOUNCE_MS);
  }

  /** 取消防抖并保存最新文档；保存期间的新修改在同一条 drain 中继续落盘。 */
  flushSave(): Promise<void> {
    if (this.timer !== null) {
      this.cancelSchedule(this.timer);
      this.timer = null;
    }
    if (this.readOnly) return Promise.resolve();
    if (this.inFlight !== null) return this.inFlight;
    if (!this.dirty) return Promise.resolve();

    const run = Promise.resolve().then(async () => {
      try {
        while (this.dirty && !this.readOnly) {
          const text = this.serialize();
          this.dirty = false;
          try {
            await this.store.save(this.canvasId, text);
          } catch (error: unknown) {
            this.dirty = true;
            if (errorCode(error) === 'E_CONFLICT') {
              this.readOnly = true;
              if (!this.conflictNotified) {
                this.conflictNotified = true;
                this.onConflict();
              }
            }
            throw error;
          }
        }
      } finally {
        this.inFlight = null;
      }
    });
    this.inFlight = run;
    return run;
  }
}

export type CanvasConflictResolution =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * 冲突面板动作协调：keep-local 必须先复查当前本地文档，任何 schema issue
 * 都阻止覆盖外部版本；accept-external 不做此前置检查，始终可放弃本地改动。
 * resolveConflict 的异常由调用方显式上报，不在此吞掉。
 */
export async function resolveCanvasConflictAfterInspection(
  controller: Pick<CanvasInteractionController, 'getDocument' | 'resolveConflict'>,
  action: 'keep-local' | 'accept-external',
): Promise<CanvasConflictResolution> {
  if (action === 'keep-local') {
    const inspection = inspectCanvasDocument(controller.getDocument());
    if (inspection.issues.length > 0) {
      return {
        ok: false,
        reason: `本地画布含 ${inspection.issues.length} 处 schema 问题，不能覆盖外部版本`,
      };
    }
  }
  const resolved = await controller.resolveConflict(action);
  return resolved
    ? { ok: true }
    : { ok: false, reason: '冲突处理未完成，请重试' };
}
