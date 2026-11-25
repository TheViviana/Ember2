/**
 * P5-C4：保存三态、未落盘聚合、关窗时限与排空轮次（纯逻辑，不引 React / store）。
 *
 * 关窗闭合铁律（CR-20261117-08 附录 A.6）：
 * - 排空判定必须同时满足 `dirty === false && saving === false`；
 * - 最多三轮、单轮超时、连续两轮无进展，任一触发即失败且不 closeDoc；
 * - 端到端预算 23000ms 从关闭请求起算，**阶段计时器与端到端计时器同刻触发时
 *   端到端（T_CLOSE）优先**——`awaitWithBudget` 在计时器胜出后复核 `now() >= deadline`
 *   即归因预算超时，避免 Promise.race 的微任务顺序决定同刻结果。
 */

/** 保存相位（UI 可见三态 + 冲突 / 失败补充态）。 */
export type SavePhase = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';

/** 判定保存相位所需的最小文档快照。 */
export interface SavePhaseInput {
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly externalKind: 'updated' | 'removed' | null;
  readonly errorMessage: string | null;
}

/**
 * 派生保存相位；优先级：冲突 > 失败 > 保存中 > 未保存 > 已保存（A.6）。
 * 写盘失败且仍 dirty 时必须显示失败，不能用“未保存”掩盖错误。
 */
export function deriveSavePhase(doc: SavePhaseInput | null): SavePhase {
  if (doc === null) return 'saved';
  if (doc.externalKind !== null) return 'conflict';
  if (doc.errorMessage !== null) return 'error';
  if (doc.saving) return 'saving';
  if (doc.dirty) return 'dirty';
  return 'saved';
}

/** 全局未落盘文档数（StatusBar 展示）。 */
export function countUnsaved(docs: Iterable<{ readonly dirty: boolean }>): number {
  let count = 0;
  for (const doc of docs) {
    if (doc.dirty) count += 1;
  }
  return count;
}

/** 排空完成判定：文档消失或既无未落盘内容、也没有在飞写。 */
export function isDrained(doc: Pick<SavePhaseInput, 'dirty' | 'saving'> | null): boolean {
  return doc === null || (!doc.dirty && !doc.saving);
}

/** 关窗各阶段时限（ms）。总和 = 5000 + 2000 + 1000 + 3 × 5000 = 23000。 */
export const CLOSE_TIMEOUTS = Object.freeze({
  /** 等待 openDoc 在途完成。 */
  openMs: 5000,
  /** 等待编辑器句柄就绪。 */
  editorHandleMs: 2000,
  /** 等待编辑锁定生效。 */
  lockMs: 1000,
  /** 单轮保存 / 等待在飞写落定。 */
  roundMs: 5000,
  /** 写入排空总预算（三轮上限的理论耗时）。 */
  drainMs: 15000,
  /** 自动关闭端到端预算（从关闭请求起算）。 */
  endToEndMs: 23000,
} as const);

/** 关窗失败原因；UI 据此决定失败面板按钮。 */
export type CloseFailureReason =
  | 'open-timeout'
  | 'handle-timeout'
  | 'lock-timeout'
  | 'lock-failed'
  | 'save-timeout'
  | 'save-failed'
  | 'no-progress'
  | 'end-to-end-timeout'
  | 'conflict-removed'
  | 'conflict-updated';

/** 端到端截止时刻（不可变值对象）。 */
export interface CloseDeadline {
  readonly at: number;
}

export function createCloseDeadline(
  now: number,
  budgetMs: number = CLOSE_TIMEOUTS.endToEndMs,
): CloseDeadline {
  return Object.freeze({ at: now + budgetMs });
}

export function remainingBudgetMs(deadline: CloseDeadline, now: number): number {
  return deadline.at - now;
}

export function isBudgetExpired(deadline: CloseDeadline, now: number): boolean {
  return now >= deadline.at;
}

/** 取消定时器的句柄。 */
export type CancelTimer = () => void;

/** 关窗流程使用的可注入时钟（测试用假时钟，生产用 Date.now + setTimeout）。 */
export interface BudgetClock {
  readonly now: () => number;
  /** 注册一次性定时器；返回取消函数，取消后保证回调不再触发。 */
  readonly setTimer: (ms: number, callback: () => void) => CancelTimer;
}

/** 带预算等待的结果；`error` 表示被等待任务 rejection。 */
export type BudgetWait<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'phase-timeout' }
  | { readonly kind: 'budget-timeout' }
  | { readonly kind: 'error'; readonly error: unknown };

/**
 * 在「阶段上限」与「端到端剩余预算」的双重约束下等待任务。
 *
 * 同刻边界：计时器胜出后复核 `now() >= deadline.at`，是则归因端到端超时
 * （T_CLOSE 优先），而不是阶段超时。这样即使阶段计时器与预算截止时刻相同，
 * 结果也不依赖 Promise.race 的注册顺序。
 */
export async function awaitWithBudget<T>(
  task: Promise<T>,
  timeoutMs: number,
  deadline: CloseDeadline,
  clock: BudgetClock,
): Promise<BudgetWait<T>> {
  const remaining = remainingBudgetMs(deadline, clock.now());
  if (remaining <= 0) return { kind: 'budget-timeout' };

  const waitMs = Math.min(timeoutMs, remaining);
  // 任务先完成时取消计时器，避免遗留定时器与延迟触发（A.6 要求）。
  const timerState: { cancel: CancelTimer | null } = { cancel: null };
  const timer = new Promise<{ readonly kind: 'timer' }>((resolve) => {
    timerState.cancel = clock.setTimer(waitMs, () => {
      resolve({ kind: 'timer' });
    });
  });
  const value = task.then(
    (result): { readonly kind: 'value'; readonly value: T } => ({ kind: 'value', value: result }),
    (error: unknown): { readonly kind: 'error'; readonly error: unknown } => ({
      kind: 'error',
      error,
    }),
  );

  const winner = await Promise.race([timer, value]);
  if (winner.kind !== 'timer') {
    timerState.cancel?.();
    return winner;
  }
  // 同刻 tie：预算已到则端到端优先（A.6 固定规则）。
  return clock.now() >= deadline.at ? { kind: 'budget-timeout' } : { kind: 'phase-timeout' };
}

/** 排空轮次的累计状态：已发起保存轮数、连续无进展轮数、上一轮快照签名。 */
export interface DrainState {
  readonly round: number;
  readonly stalled: number;
  readonly signature: string;
}

export const INITIAL_DRAIN_STATE: DrainState = Object.freeze({
  round: 0,
  stalled: 0,
  signature: '',
});

export type DrainAction =
  | { readonly kind: 'done' }
  | { readonly kind: 'save' }
  | { readonly kind: 'wait-saving' }
  | { readonly kind: 'fail'; readonly reason: CloseFailureReason };

export interface DrainDecision {
  readonly state: DrainState;
  readonly action: DrainAction;
}

/** 单轮排空判定：协调器按返回的 action 保存 / 等待 / 结束 / 失败。 */
export function planDrainRound(
  state: DrainState,
  doc: SavePhaseInput | null,
  maxRounds: number = 3,
): DrainDecision {
  if (isDrained(doc)) {
    return {
      state: { round: state.round, stalled: 0, signature: '' },
      action: { kind: 'done' },
    };
  }
  // isDrained 已排除 null，此处收窄只为类型安全。
  if (doc === null) return { state, action: { kind: 'done' } };

  const signature = [
    doc.dirty ? 'dirty' : 'clean',
    doc.saving ? 'saving' : 'idle',
    doc.externalKind ?? 'none',
    doc.errorMessage ?? '',
  ].join('|');
  const stalled = signature === state.signature ? state.stalled + 1 : 0;
  const next: DrainState = { round: state.round, stalled, signature };

  if (doc.externalKind === 'removed') {
    return { state: next, action: { kind: 'fail', reason: 'conflict-removed' } };
  }
  if (doc.externalKind === 'updated') {
    return { state: next, action: { kind: 'fail', reason: 'conflict-updated' } };
  }
  // 连续两轮快照完全相同 → 无进展；本轮即第三轮时先拒绝，避免无效重试。
  if (stalled >= 2) {
    return { state: next, action: { kind: 'fail', reason: 'no-progress' } };
  }
  if (doc.saving) {
    return { state: next, action: { kind: 'wait-saving' } };
  }
  if (state.round >= maxRounds) {
    return { state: next, action: { kind: 'fail', reason: 'no-progress' } };
  }
  return {
    state: { round: state.round + 1, stalled, signature },
    action: { kind: 'save' },
  };
}
