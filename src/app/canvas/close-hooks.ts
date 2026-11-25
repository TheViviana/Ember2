/**
 * C0-B B5：把 registry 中的当前实例与 core 画布队列组装成关窗钩子（纯逻辑）。
 *
 * close-guard 只通过本模块触达当前有效实例：
 * lock → beforeFlush（实例 controller）→ core canvas.flush；成功结束。
 * 任一失败先 resumeInteraction 再抛错，调用方不得 seal。
 */
import { CanvasFlushError, type CanvasFlushReportLike } from './lifecycle.ts';
import type { CanvasEngineRegistry } from './registry.ts';

export interface CanvasCloseStore {
  flush(options?: { readonly timeoutMs?: number }): Promise<CanvasFlushReportLike>;
  beginClosing(): void;
  cancelClosing(): void;
}

export interface CanvasCloseHooks {
  lock(): void;
  resume(): void;
  flush(): Promise<void>;
  seal(): void;
  cancelSeal(): void;
}

export const CANVAS_CLOSE_FLUSH_TIMEOUT_MS = 5000;

export function createCanvasCloseHooks(
  registry: CanvasEngineRegistry,
  store: CanvasCloseStore,
  timeoutMs = CANVAS_CLOSE_FLUSH_TIMEOUT_MS,
): CanvasCloseHooks {
  return {
    lock(): void {
      registry.current()?.hooks.lockInteraction();
    },
    resume(): void {
      registry.current()?.hooks.resumeInteraction();
    },
    async flush(): Promise<void> {
      const instance = registry.current();
      instance?.hooks.lockInteraction();
      try {
        await instance?.hooks.flush();
        const report = await store.flush({ timeoutMs });
        if (!report.ok) {
          throw new CanvasFlushError(
            report.timedOut ? 'E_FLUSH_TIMEOUT' : 'E_FLUSH_FAILED',
            report.error?.message ?? (report.timedOut ? '画布保存超时' : '画布保存失败'),
          );
        }
      } catch (error) {
        instance?.hooks.resumeInteraction();
        throw error;
      }
    },
    seal(): void {
      store.beginClosing();
    },
    cancelSeal(): void {
      store.cancelClosing();
    },
  };
}
