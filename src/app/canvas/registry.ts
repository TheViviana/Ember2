/**
 * C0-B B5：当前挂载引擎的实例注册表（纯逻辑，不碰 DOM）。
 *
 * 只保留一个有效实例；`register` 返回递增 token，`unregister(token)` 仅在
 * token 仍匹配时生效，旧 cleanup 或迟到的异步 mount 不得注销/覆盖新实例。
 */
export interface CanvasEngineHooks {
  /** 非破坏锁定：阻止新输入并取消活动手势，保留 DOM/rAF/observer。 */
  readonly lockInteraction: () => void;
  readonly resumeInteraction: () => void;
  /** 未发保存（controller.flushSave），不含 core 队列 flush。 */
  readonly flush: () => Promise<void>;
  /** 破坏性清理；调用方必须已确认该实例不再复用。 */
  readonly dispose: () => Promise<void>;
}

export interface CanvasEngineRegistration {
  readonly token: number;
  readonly hooks: CanvasEngineHooks;
}

export interface CanvasEngineRegistry {
  register(hooks: CanvasEngineHooks): number;
  /** token 不匹配时静默忽略（旧实例不得注销新实例）。 */
  unregister(token: number): void;
  current(): CanvasEngineRegistration | null;
}

export function createCanvasEngineRegistry(): CanvasEngineRegistry {
  let nextToken = 0;
  let active: CanvasEngineRegistration | null = null;

  return {
    register(hooks: CanvasEngineHooks): number {
      nextToken += 1;
      active = { token: nextToken, hooks };
      return nextToken;
    },
    unregister(token: number): void {
      if (active !== null && active.token === token) active = null;
    },
    current(): CanvasEngineRegistration | null {
      return active;
    },
  };
}
