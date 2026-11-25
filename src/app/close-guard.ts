/**
 * 关窗守卫：先 flush 所有防抖中的脏文档与当前画布，成功后才放行关闭。
 * 不依赖 React 与 Tauri，用 Fake port 即可在 Node 环境覆盖失败分支。
 *
 * C0-B B5：文档 flush 与画布 lock→beforeFlush→store.flush 两阶段都尝试并收集
 * 全部错误；任一失败恢复画布交互、不 seal。seal 后首次 close / unlisten /
 * 二次 close 任一路径失败都取消 seal 并恢复画布。
 *
 * 2026-11-19：flush 前同时锁定编辑器（`editors`），避免“旧正文保存完、新输入
 * 还在防抖窗口”时关窗丢字；取消关闭时恢复输入。
 */
import { formatUnknownError } from '../core/errors.ts';

export interface CloseRequestLike {
  preventDefault(): void;
}

export interface CloseGuardPort {
  /** 返回退订函数，允许返回 Promise（Tauri 的 unlisten 是异步 IPC）。 */
  onCloseRequested(
    handler: (event: CloseRequestLike) => void | Promise<void>,
  ): Promise<() => void | Promise<void>>;
  /** 请求关闭；会再次触发 closeRequested，由本模块自行处理。 */
  close(): Promise<void>;
}

/** 画布侧关窗钩子：由 app 装配层用 registry + core canvas store 组装。 */
export interface CloseGuardCanvas {
  lock(): void;
  resume(): void;
  flush(): Promise<void>;
  seal(): void;
  cancelSeal(): void;
}

/** 编辑器侧关窗锁：flush 前锁住正文输入，取消关闭时恢复。 */
export interface CloseGuardEditors {
  lock(): void;
  resume(): void;
}

export interface CloseGuardHandlers {
  readonly flush: () => Promise<void>;
  /** flush 失败：窗口保持打开。 */
  readonly onFlushError: (message: string) => void;
  /** 监听注册失败：必须向用户持久提示，不能静默丢字。 */
  readonly onRegisterError: (message: string) => void;
  readonly canvas?: CloseGuardCanvas;
  /** 不传表示没有已就绪的编辑器；实现见 app/editor-lock-registry.ts。 */
  readonly editors?: CloseGuardEditors;
}

/**
 * 安装关窗拦截，返回退订函数。
 * 注册失败只上报，不影响调用方后续流程（后端继续启动）。
 */
export function installCloseGuard(
  port: CloseGuardPort,
  handlers: CloseGuardHandlers,
): () => void {
  let disposed = false;
  let released = false;
  let unlisten: (() => void | Promise<void>) | null = null;
  let flushing = false;
  let closing = false;

  const releaseListener = async (): Promise<void> => {
    if (released) return;
    const off = unlisten;
    if (off === null) {
      released = true;
      return;
    }
    // 先等 unlisten 真正完成，再落标记；失败时保持可重试状态。
    await off();
    unlisten = null;
    released = true;
  };

  /** seal 后任一路径失败：取消全局闩锁、恢复画布与编辑器输入并提示。 */
  const abortSeal = (message: string): void => {
    closing = false;
    flushing = false;
    const failures: string[] = [];
    try {
      handlers.canvas?.cancelSeal();
    } catch (error: unknown) {
      failures.push(`取消画布关闭失败：${formatUnknownError(error, '未知错误')}`);
    }
    try {
      handlers.canvas?.resume();
    } catch (error: unknown) {
      failures.push(`恢复画布交互失败：${formatUnknownError(error, '未知错误')}`);
    }
    try {
      handlers.editors?.resume();
    } catch (error: unknown) {
      failures.push(`恢复编辑器输入失败：${formatUnknownError(error, '未知错误')}`);
    }
    handlers.onRegisterError(
      failures.length === 0 ? message : `${message}（${failures.join('；')}）`,
    );
  };

  void port
    .onCloseRequested(async (event) => {
      if (closing) {
        // 二次事件来自自己的 close()。Tauri 包装层在“不 preventDefault”时会走
        // destroy()，而 ACL 未授予 allow-destroy；因此这里继续阻止默认行为，
        // 先摘掉监听，再 close：Rust 侧没有 JS 监听器时直接执行原生关闭。
        event.preventDefault();
        try {
          await releaseListener();
        } catch {
          // unlisten 失败时绝不能 close()，否则会反复触发二次事件形成死循环。
          abortSeal('窗口关闭失败，请手动保存');
          return;
        }
        try {
          await port.close();
        } catch {
          // 监听已摘除但关闭失败：守卫已无法拦截下一次原生关闭，必须持久告警。
          abortSeal('自动保存已失效，请手动保存后再关闭');
        }
        return;
      }

      event.preventDefault();
      if (flushing) return;
      flushing = true;
      // 先锁画布与编辑器，阻止关窗过程中出现新手势/新命令/新输入。
      handlers.canvas?.lock();
      try {
        handlers.editors?.lock();
      } catch {
        // 锁失败不能阻断 flush：兜底由 store.flush 的多轮收集完成。
      }
      const failures: string[] = [];
      try {
        await handlers.flush();
      } catch (error: unknown) {
        failures.push(formatUnknownError(error, '未知错误'));
      }
      try {
        await handlers.canvas?.flush();
      } catch (error: unknown) {
        failures.push(formatUnknownError(error, '未知错误'));
      }
      if (failures.length > 0) {
        flushing = false;
        handlers.canvas?.resume();
        try {
          handlers.editors?.resume();
        } catch (error: unknown) {
          failures.push(`恢复编辑器输入失败：${formatUnknownError(error, '未知错误')}`);
        }
        handlers.onFlushError(failures.join('；'));
        return;
      }
      // 两阶段全成功后才 seal；此后失败必须 cancelClosing。
      handlers.canvas?.seal();
      closing = true;
      try {
        await port.close();
      } catch {
        abortSeal('窗口关闭失败，请手动保存');
      }
    })
    .then((off) => {
      if (disposed || released) void off();
      else unlisten = off;
    })
    .catch((error: unknown) => {
      if (disposed) return;
      handlers.onRegisterError(error instanceof Error ? error.message : '未知错误');
    });

  return () => {
    disposed = true;
    const off = unlisten;
    unlisten = null;
    void off?.();
  };
}
