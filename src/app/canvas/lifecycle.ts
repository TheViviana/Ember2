/**
 * 画布 dispose 编排（纯逻辑，不碰 DOM，便于 node --test 覆盖）。
 *
 * 两种语义严格分开：
 * - `createCanvasSwitchDisposer`：普通切换/最终卸载。lockInteraction → beforeFlush
 *   → store.flush；成功后才破坏性 dispose，**绝不调用 beginClosing**；任一失败
 *   resumeInteraction、保留 dirty 并抛错，调用方留在旧画布。
 * - `createCanvasDisposer`：只用于确定不再复用的实例（应用退出 seal 前的最后清理）：
 *   stop → beforeFlush → store.flush → 成功 beginClosing。不要再把它当通用 disposer。
 * 幂等：重复调用返回同一个 Promise。
 */

export interface CanvasFlushFailure {
  readonly message: string;
}

export interface CanvasFlushReportLike {
  readonly ok: boolean;
  readonly timedOut: boolean;
  readonly error: CanvasFlushFailure | null;
}

/** 只约束 dispose 需要的两个方法，避免依赖 core 的具体类型。 */
export interface DisposableCanvasStore {
  flush(options?: { readonly timeoutMs?: number }): Promise<CanvasFlushReportLike>;
  beginClosing(): void;
}

export interface CanvasDisposeHooks {
  readonly store: DisposableCanvasStore;
  /** 停监听、取消 rAF、断开 ResizeObserver；必须同步完成。 */
  readonly stop: () => void;
  /** C4：flush 前取消防抖并立即发未保存文档；失败则不进入 store.flush。 */
  readonly beforeFlush?: () => Promise<void>;
  /** 缺省 5000ms（CR-20261117-01 §4.3）。 */
  readonly timeoutMs?: number;
}

export type CanvasFlushErrorCode = 'E_FLUSH_TIMEOUT' | 'E_FLUSH_FAILED';

export class CanvasFlushError extends Error {
  readonly code: CanvasFlushErrorCode;

  constructor(code: CanvasFlushErrorCode, message: string) {
    super(message);
    this.name = 'CanvasFlushError';
    this.code = code;
  }
}

export function createCanvasDisposer(hooks: CanvasDisposeHooks): () => Promise<void> {
  let pending: Promise<void> | null = null;

  return (): Promise<void> => {
    if (pending !== null) return pending;

    const run = async (): Promise<void> => {
      hooks.stop();
      await hooks.beforeFlush?.();
      const report = await hooks.store.flush({ timeoutMs: hooks.timeoutMs ?? 5000 });
      if (!report.ok) {
        throw new CanvasFlushError(
          report.timedOut ? 'E_FLUSH_TIMEOUT' : 'E_FLUSH_FAILED',
          report.error?.message ?? (report.timedOut ? '画布保存超时' : '画布保存失败'),
        );
      }
      hooks.store.beginClosing();
    };

    pending = run();
    return pending;
  };
}

export interface CanvasSwitchHooks {
  readonly lockInteraction: () => void;
  readonly resumeInteraction: () => void;
  /** C4：flush 前取消防抖并立即发未保存文档。 */
  readonly beforeFlush?: () => Promise<void>;
  readonly flush: () => Promise<CanvasFlushReportLike>;
  /** 仅在 flush 成功后调用；破坏性清理。 */
  readonly dispose: () => Promise<void> | void;
  /** 缺省 5000ms。 */
  readonly timeoutMs?: number;
}

/**
 * 普通切换/最终卸载：可恢复的 lock → beforeFlush → flush，成功后才破坏性 dispose。
 * 失败时恢复交互并抛错，调用方不得关闭旧视图或挂载新视图。
 */
export function createCanvasSwitchDisposer(hooks: CanvasSwitchHooks): () => Promise<void> {
  let pending: Promise<void> | null = null;

  return (): Promise<void> => {
    if (pending !== null) return pending;

    const run = async (): Promise<void> => {
      hooks.lockInteraction();
      let destructiveStarted = false;
      try {
        await hooks.beforeFlush?.();
        const report = await hooks.flush();
        if (!report.ok) {
          throw new CanvasFlushError(
            report.timedOut ? 'E_FLUSH_TIMEOUT' : 'E_FLUSH_FAILED',
            report.error?.message ?? (report.timedOut ? '画布保存超时' : '画布保存失败'),
          );
        }
        destructiveStarted = true;
        await hooks.dispose();
      } catch (error) {
        if (!destructiveStarted) hooks.resumeInteraction();
        throw error;
      }
    };

    pending = run();
    return pending;
  };
}
