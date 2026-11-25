/**
 * 多库安全切换的纯状态机（T13 CR-B）。
 *
 * 所有 I/O 副作用由 app 层注入 effects 参数，本模块零 @tauri-apps / 零 app 依赖。
 * 仅负责：状态转移、超时、回滚路径、二次 library_current 原子切回（F4a 已核）。
 */

// ─── 状态 ────────────────────────────────────────────────────────────────

export type SwitchState =
  | 'idle'
  | 'confirm'
  | 'flushing'
  | 'locking'
  | 'closing'
  | 'switching'
  | 'reloading'
  | 'done'
  | 'cancelled'
  | 'failed'
  | 'rolling_back';

export type SwitchFailurePhase =
  | 'confirm'
  | 'flushing'
  | 'locking'
  | 'closing'
  | 'switching'
  | 'reloading';

export interface SwitchStateSnapshot {
  readonly state: SwitchState;
  /** 目标库 id；CONFIRM 之后、SWITCHING 之前设为 non-null。 */
  readonly targetId: string | null;
  /** 旧库 id，用于 RELOADING 失败时二次 library_current 原子切回。 */
  readonly oldId: string | null;
  /** 当前失败阶段（failed / rolling_back 时 non-null）。 */
  readonly failurePhase: SwitchFailurePhase | null;
  /** 失败消息（toast 用）。 */
  readonly failureMessage: string | null;
  /** 是否可取消（仅 CONFIRM / FLUSHING 期间）。 */
  readonly cancellable: boolean;
  /** 只读标记：RELOADING 完成后 identity.readonly=true。 */
  readonly readonly: boolean;
}

// ─── Effects（由 app 层注入） ─────────────────────────────────────────────

export interface SwitchEffects {
  /** flush 全部文档到 Rust（Promise）。 */
  flushDocs(): Promise<void>;
  /** flush 全部画布到 Rust（Promise）。 */
  flushCanvases(): Promise<void>;
  /** 锁定所有编辑器（阻止新输入）。 */
  lockEditors(): void;
  /** 解锁所有编辑器。 */
  resumeEditors(): void;
  /** 画布 seal（beginCanvasClosing）。 */
  sealCanvases(): void;
  /** 取消画布 seal。 */
  unsealCanvases(): void;
  /** Rust library_current 切换。 */
  libraryCurrent(id: string): Promise<void>;
  /** dispose 旧 core（退订 + dispose + 重建空 registry）。 */
  disposeCore(): Promise<void>;
  /** rebuild 新 core + start()。 */
  rebuildCore(): Promise<void>;
  /** library_list 刷新（切换后 current 标记更新）。 */
  reloadLibraryList(): Promise<void>;
  /** 状态更新通知（switchCoordinator 每次状态转移都调）。 */
  onStateChange(snapshot: SwitchStateSnapshot): void;
}

// ─── Coordinator ──────────────────────────────────────────────────────────

/** 默认超时（ms）。可由调用方覆盖。 */
const DEFAULT_TIMEOUTS = Object.freeze({
  flushing: 15000,
  locking: 100,
  closing: 5000,
  switching: 10000,
  reloading: 10000,
});

export interface SwitchCoordinator {
  /** 当前状态快照。 */
  getState(): SwitchStateSnapshot;
  /**
   * 发起切换。内部会自动把状态从 idle → confirm → … → done 驱动完整流程。
   * @param targetId 目标库 id
   * @param oldId 当前库 id（用于 RELOADING 失败时二次 library_current 原子切回）
   * 返回 Promise：成功时 resolve，失败 / 取消时 reject（调用方自行 toast）。
   */
  start(targetId: string, oldId: string): Promise<void>;
  /** CONFIRM / FLUSHING 阶段取消。 */
  cancel(): void;
  /** 读库只读标记（reloadCore 完成后由 app 层 updateReadonly 调用）。 */
  updateReadonly(readonly: boolean): void;
}

export interface CreateSwitchCoordinatorOptions {
  readonly effects: SwitchEffects;
  /** 超时覆盖（可选）。 */
  readonly timeouts?: Partial<typeof DEFAULT_TIMEOUTS>;
}

export function createSwitchCoordinator(
  options: CreateSwitchCoordinatorOptions,
): SwitchCoordinator {
  const effects = options.effects;
  const timeouts = Object.freeze({ ...DEFAULT_TIMEOUTS, ...(options.timeouts ?? {}) });

  let state: SwitchStateSnapshot = Object.freeze({
    state: 'idle',
    targetId: null,
    oldId: null,
    failurePhase: null,
    failureMessage: null,
    cancellable: false,
    readonly: false,
  });

  let currentAbort: (() => void) | null = null;

  function emit(): void {
    effects.onStateChange(state);
  }

  function transition(next: Partial<SwitchStateSnapshot>): void {
    state = Object.freeze({ ...state, ...next });
    emit();
  }

  function cancelled(): boolean {
    return currentAbort !== null;
  }

  // ── 带超时的 Promise 包装 ──

  async function withTimeout<T>(
    promise: Promise<T>,
    phase: SwitchFailurePhase,
    timeoutMs: number,
  ): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`[switch.${phase}] 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((reason) => {
          clearTimeout(timer);
          reject(reason instanceof Error ? reason : new Error(String(reason)));
        });
    });
  }

  // ── 主流程 ──

  async function runFlow(targetId: string): Promise<void> {
    // ── FLUSHING ──
    transition({
      state: 'flushing',
      targetId,
      oldId: state.oldId, // 保留进入前存的 oldId
      failurePhase: null,
      failureMessage: null,
      cancellable: true,
    });
    try {
      await withTimeout(effects.flushDocs(), 'flushing', timeouts.flushing);
      if (cancelled()) return;
      await withTimeout(effects.flushCanvases(), 'flushing', timeouts.flushing);
      if (cancelled()) return;
    } catch (e) {
      failFlow('flushing', '切库失败：有内容未落盘，请手动保存后重试', e);
      return;
    }

    // ── LOCKING ──
    transition({ state: 'locking', cancellable: false });
    try {
      effects.lockEditors();
    } catch (e) {
      failFlow('locking', '切库失败：编辑器锁异常', e);
      return;
    }

    // ── CLOSING ──
    transition({ state: 'closing' });
    try {
      effects.sealCanvases();
    } catch (e) {
      effects.resumeEditors();
      failFlow('closing', '切库失败：画布关闭中断', e);
      return;
    }

    // ── SWITCHING（Rust 原子） ──
    transition({ state: 'switching' });
    try {
      await withTimeout(effects.libraryCurrent(targetId), 'switching', timeouts.switching);
    } catch (e) {
      effects.unsealCanvases();
      effects.resumeEditors();
      failFlow('switching', '切库失败：无法打开目标库', e);
      return;
    }

    // ── RELOADING（核心） ──
    transition({ state: 'reloading' });
    try {
      await withTimeout(effects.disposeCore(), 'reloading', timeouts.reloading);
      await withTimeout(effects.rebuildCore(), 'reloading', timeouts.reloading);
      await withTimeout(effects.reloadLibraryList(), 'reloading', timeouts.reloading);
    } catch (e) {
      // RELOADING 失败：二次 library_current(oldId) 原子切回
      await rollbackToOld(e);
      return;
    }

    // ── DONE ──
    effects.resumeEditors();
    transition({
      state: 'done',
      cancellable: false,
      failurePhase: null,
      failureMessage: null,
    });
  }

  // ── 失败回滚 ──

  function failFlow(
    phase: SwitchFailurePhase,
    message: string,
    originalError: unknown,
  ): void {
    const detail = originalError instanceof Error ? originalError.message : String(originalError);
    transition({
      state: 'failed',
      failurePhase: phase,
      failureMessage: `${message}（${detail}）`,
      cancellable: false,
    });
    currentAbort = null; // 重置 abort 标记
  }

  async function rollbackToOld(originalError: unknown): Promise<void> {
    const oldId = state.oldId;
    if (oldId === null) {
      // 没有旧库 id → 直接 FAILED
      failFlow(
        'reloading',
        '切库失败：新库加载中断，旧库信息丢失，请重启应用',
        originalError,
      );
      return;
    }
    transition({ state: 'rolling_back', failureMessage: '正在恢复到之前的库…' });
    try {
      // disposeCore 可能已经执行过了；rebuildCore 失败后 store 处于半初始化状态
      // 这里走二次 library_current 让 Rust 原子切回
      await effects.libraryCurrent(oldId);
      // 切回后重建一次 core（指向刚切回的旧库 identity）
      await effects.rebuildCore();
      await effects.reloadLibraryList();
      effects.resumeEditors();
      transition({
        state: 'done',
        failureMessage: null,
      });
    } catch (rollbackError) {
      // 二次切回也失败 → FAILED + 提示重启
      effects.resumeEditors();
      failFlow(
        'reloading',
        '切库失败：新库加载中断，恢复旧库也失败，请重启应用',
        rollbackError,
      );
    }
    currentAbort = null;
  }

  // ── 公共接口 ──

  return Object.freeze({
    getState(): SwitchStateSnapshot {
      return state;
    },
    async start(targetId: string, oldId: string): Promise<void> {
      if (state.state !== 'idle' && state.state !== 'failed' && state.state !== 'done') {
        throw new Error(`switchCoordinator.start() 在 state=${state.state} 时不可调用`);
      }
      currentAbort = null;
      transition({
        state: 'confirm',
        targetId,
        oldId,
        failurePhase: null,
        failureMessage: null,
        cancellable: true,
      });
      await runFlow(targetId);
    },
    cancel(): void {
      if (state.state !== 'confirm' && state.state !== 'flushing') {
        return;
      }
      currentAbort = () => {
        // runFlow 内部每步检查 cancelled()
      };
      transition({
        state: 'cancelled',
        cancellable: false,
        failureMessage: '切库已取消',
      });
      // 重置 abort 标记，下次 start 不受影响
      setTimeout(() => {
        currentAbort = null;
      }, 0);
    },
    updateReadonly(readonly: boolean): void {
      if (state.state === 'done' || state.state === 'reloading') {
        transition({ readonly });
      }
    },
  });
}
