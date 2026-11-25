/**
 * P5-C4：关窗流程协调器（app 层，纯逻辑 + 端口注入，可在 Node 单测）。
 *
 * 三个关闭入口（标题栏 ×、外部删除占位「关闭窗口」、冲突横幅「接受删除」）统一收敛到
 * 本协调器；`src/editor/` 与 `src/app/panels/` 不得直接调用 closeWindow。
 *
 * 关闭目标注册表留在 app 层：UI 只按 windowId 请求关闭，不接触绑定 token。
 * 协调器按 windowId 取得 `{ path, token, awaitOpen, awaitEditor, lockEditing, handoff, resume }`。
 *
 * 接管时序（A.6）：
 * - 找到目标即 `handoff()`，此后窗口卸载清理只注销归属，不会触发第二套 save/close；
 * - 取消 / 处理冲突时 `resume()` 撤销移交并解锁；
 * - 目标未注册时不得直关窗口，必须中止并保留（提示可重试）。
 *
 * 失败即保留窗口（不 closeDoc、不丢 dirty）；三条失败路径：
 * - 打开 / 句柄 / 锁定超时或失败；
 * - 保存失败、冲突（removed / updated）、单轮超时；
 * - 三轮无进展或端到端 23000ms 预算耗尽。
 * 强制关闭不发起新保存、不 closeDoc，但继续观察已发出的写入结果并显式上报。
 */
import {
  CLOSE_TIMEOUTS,
  INITIAL_DRAIN_STATE,
  awaitWithBudget,
  createCloseDeadline,
  isBudgetExpired,
  planDrainRound,
  remainingBudgetMs,
  type BudgetClock,
  type CancelTimer,
  type CloseDeadline,
  type CloseFailureReason,
  type DrainState,
  type SavePhaseInput,
} from '../editor/save-phases.ts';
import { formatUnknownError } from '../core/errors.ts';

export type CloseIntent = 'close' | 'accept-deletion';

export type CloseFlowPhase = 'working' | 'confirming' | 'failed';

export type CloseStage = 'open' | 'editor' | 'lock' | 'drain';

/** 失败面板 / 进度面板需要的只读视图。 */
export interface CloseFlowView {
  readonly windowId: string;
  readonly path: string;
  readonly phase: CloseFlowPhase;
  readonly stage: CloseStage | null;
  readonly reason: CloseFailureReason | null;
  readonly message: string | null;
}

/** 协调器需要的文档快照（由 app store 映射）。 */
export type CloseDocSnapshot = SavePhaseInput;

/** 保存结果的最小结构（与 core 的 SaveOutcome 结构兼容）。 */
export interface CloseSaveOutcome {
  readonly ok: boolean;
  readonly error?: { readonly message: string } | null;
  readonly conflict?: unknown;
}

/** 关闭目标：由 EditorWindow 挂载时注册；所有能力都绑定到当前实例 token。 */
export interface CloseTarget {
  readonly path: string;
  readonly token: number;
  /** 等待 openDoc 在途完成（无论成功失败，只要落定即可）。 */
  awaitOpen(): Promise<void>;
  /** 等待 CodeMirror 句柄可锁定。 */
  awaitEditor(): Promise<void>;
  /** 同步应用编辑锁定；找不到句柄时必须 reject，不得静默继续。 */
  lockEditing(): Promise<void>;
  /** 移交收尾职责：抑制卸载时的 save/close。 */
  handoff(): void;
  /** 恢复编辑（取消 / 解锁）并撤销移交。 */
  resume(): void;
}

export interface CloseFlowPorts {
  getDoc(path: string): CloseDocSnapshot | null;
  hasDoc(path: string): boolean;
  saveDoc(path: string): Promise<CloseSaveOutcome>;
  closeDoc(path: string): void;
  closeWindow(windowId: string): void;
  notice(message: string, tone?: 'info' | 'warning' | 'error'): void;
  now(): number;
  setTimer(ms: number, callback: () => void): CancelTimer;
}

export type CloseFlowListener = (windowId: string, view: CloseFlowView | null) => void;

export interface CloseFlow {
  register(windowId: string, target: CloseTarget): () => void;
  requestClose(windowId: string, intent?: CloseIntent): void;
  confirmDiscard(windowId: string): void;
  forceClose(windowId: string): void;
  cancel(windowId: string): void;
  retry(windowId: string): void;
  resolveConflict(windowId: string): void;
  view(windowId: string): CloseFlowView | null;
  subscribe(listener: CloseFlowListener): () => void;
}

const STAGE_LABEL: Record<CloseStage, string> = {
  open: '正在等待文档载入…',
  editor: '正在准备编辑器…',
  lock: '正在锁定编辑…',
  drain: '正在保存并关闭…',
};

const FAILURE_MESSAGE: Record<CloseFailureReason, string> = {
  'open-timeout': '文档打开超时，已中止关闭并保留窗口',
  'handle-timeout': '编辑器尚未就绪，已中止关闭并保留窗口',
  'lock-timeout': '编辑锁定超时，已中止关闭并保留窗口',
  'lock-failed': '无法锁定编辑，已中止关闭并保留窗口',
  'save-timeout': '保存超时，已保留窗口与未落盘改动',
  'save-failed': '保存失败，已保留窗口与未落盘改动',
  'no-progress': '多轮保存后仍未落盘，已保留窗口与未落盘改动',
  'end-to-end-timeout': '关闭总时限（23 秒）已到，已保留窗口与未落盘改动',
  'conflict-removed': '磁盘文件已被删除，需确认后才能丢弃本地改动',
  'conflict-updated': '磁盘内容已被外部修改，请先处理冲突',
};

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

function workingView(windowId: string, path: string, stage: CloseStage): CloseFlowView {
  return {
    windowId,
    path,
    phase: 'working',
    stage,
    reason: null,
    message: STAGE_LABEL[stage],
  };
}

export function createCloseFlow(ports: CloseFlowPorts): CloseFlow {
  const targets = new Map<string, CloseTarget>();
  const generations = new Map<string, number>();
  const views = new Map<string, CloseFlowView>();
  const listeners = new Set<CloseFlowListener>();
  const clock: BudgetClock = {
    now: () => ports.now(),
    setTimer: (ms, callback) => ports.setTimer(ms, callback),
  };

  function notify(windowId: string): void {
    const current = views.get(windowId) ?? null;
    for (const listener of listeners) listener(windowId, current);
  }

  function setView(view: CloseFlowView): void {
    views.set(view.windowId, view);
    notify(view.windowId);
  }

  function clearView(windowId: string): void {
    if (views.delete(windowId)) notify(windowId);
  }

  function nextGeneration(windowId: string): number {
    const next = (generations.get(windowId) ?? 0) + 1;
    generations.set(windowId, next);
    return next;
  }

  function isCurrent(windowId: string, runId: number): boolean {
    return generations.get(windowId) === runId;
  }

  function setFailed(
    windowId: string,
    path: string,
    reason: CloseFailureReason,
    message: string = FAILURE_MESSAGE[reason],
  ): void {
    setView({
      windowId,
      path,
      phase: 'failed',
      stage: null,
      reason,
      message,
    });
  }

  function failIfCurrent(
    windowId: string,
    path: string,
    runId: number,
    reason: CloseFailureReason,
    message?: string,
  ): void {
    if (!isCurrent(windowId, runId)) return;
    setFailed(windowId, path, reason, message);
  }

  /** 文档不在 Core：没有可保存内容，直接移除窗口（不调用 closeDoc）。 */
  function finishQuickClose(windowId: string): void {
    ports.closeWindow(windowId);
    clearView(windowId);
  }

  /** 排空成功：移除窗口 → 关闭文档（handoff 已在接管时完成）。 */
  function finishClose(windowId: string, target: CloseTarget): void {
    ports.closeWindow(windowId);
    ports.closeDoc(target.path);
    clearView(windowId);
  }

  /** 已发出的写入无法取消：继续观察，失败/rejection 显式上报，成功静默。 */
  function observeSave(task: Promise<CloseSaveOutcome>, path: string): void {
    void task.then(
      (outcome) => {
        if (outcome.ok) return;
        const detail = outcome.error?.message;
        ports.notice(
          `关闭时保存未完成：${path}${detail ? `：${detail}` : ''}`,
          'error',
        );
      },
      (error: unknown) => {
        ports.notice(`关闭时保存异常：${path}：${formatUnknownError(error, String(error))}`, 'error');
      },
    );
  }

  async function waitUntilSettled(
    path: string,
    deadline: CloseDeadline,
  ): Promise<'settled' | 'phase-timeout' | 'budget-timeout'> {
    const start = clock.now();
    for (;;) {
      const doc = ports.getDoc(path);
      if (doc === null || !doc.saving) return 'settled';
      const now = clock.now();
      if (isBudgetExpired(deadline, now)) return 'budget-timeout';
      const elapsed = now - start;
      if (elapsed >= CLOSE_TIMEOUTS.roundMs) return 'phase-timeout';
      const step = Math.min(
        50,
        CLOSE_TIMEOUTS.roundMs - elapsed,
        remainingBudgetMs(deadline, now),
      );
      // step <= 0 只可能出现在同刻边界；调用方按端到端优先归因具体预算。
      if (step <= 0) return 'budget-timeout';
      await new Promise<void>((resolve) => {
        clock.setTimer(step, resolve);
      });
    }
  }

  /**
   * 等待句柄并锁定编辑。确认丢弃前也走同一路径，确保确认期间无法继续编辑。
   */
  async function acquireLock(
    windowId: string,
    target: CloseTarget,
    runId: number,
    deadline: CloseDeadline,
  ): Promise<'locked' | 'aborted'> {
    setView(workingView(windowId, target.path, 'editor'));
    const editorWait = await awaitWithBudget(
      target.awaitEditor(),
      CLOSE_TIMEOUTS.editorHandleMs,
      deadline,
      clock,
    );
    if (!isCurrent(windowId, runId)) return 'aborted';
    if (editorWait.kind === 'budget-timeout') {
      failIfCurrent(windowId, target.path, runId, 'end-to-end-timeout');
      return 'aborted';
    }
    if (editorWait.kind === 'phase-timeout' || editorWait.kind === 'error') {
      failIfCurrent(windowId, target.path, runId, 'handle-timeout');
      return 'aborted';
    }

    setView(workingView(windowId, target.path, 'lock'));
    const lockWait = await awaitWithBudget(
      Promise.resolve().then(() => target.lockEditing()),
      CLOSE_TIMEOUTS.lockMs,
      deadline,
      clock,
    );
    if (!isCurrent(windowId, runId)) return 'aborted';
    if (lockWait.kind === 'budget-timeout') {
      failIfCurrent(windowId, target.path, runId, 'end-to-end-timeout');
      return 'aborted';
    }
    if (lockWait.kind === 'phase-timeout') {
      failIfCurrent(windowId, target.path, runId, 'lock-timeout');
      return 'aborted';
    }
    if (lockWait.kind === 'error') {
      failIfCurrent(windowId, target.path, runId, 'lock-failed');
      return 'aborted';
    }
    return 'locked';
  }

  async function runNormalClose(
    windowId: string,
    target: CloseTarget,
    runId: number,
    alreadyLocked = false,
  ): Promise<void> {
    const path = target.path;
    const deadline = createCloseDeadline(ports.now());
    const alive = (): boolean => isCurrent(windowId, runId);

    const fail = (reason: CloseFailureReason, message?: string): void => {
      failIfCurrent(windowId, path, runId, reason, message);
    };

    setView(workingView(windowId, path, 'open'));
    const openWait = await awaitWithBudget(
      target.awaitOpen(),
      CLOSE_TIMEOUTS.openMs,
      deadline,
      clock,
    );
    if (!alive()) return;
    if (openWait.kind === 'budget-timeout') return fail('end-to-end-timeout');
    if (openWait.kind === 'phase-timeout') return fail('open-timeout');
    // openDoc 失败（文件不存在等）不视为关闭失败：文档不在 Core 即无可保存内容。

    if (!ports.hasDoc(path)) {
      finishQuickClose(windowId);
      return;
    }

    if (!alreadyLocked) {
      const locked = await acquireLock(windowId, target, runId, deadline);
      if (locked === 'aborted') return;
    }

    setView(workingView(windowId, path, 'drain'));
    const drainDeadline = createCloseDeadline(clock.now(), CLOSE_TIMEOUTS.drainMs);
    const activeDrainDeadline = drainDeadline.at < deadline.at ? drainDeadline : deadline;
    const failDrainBudget = (): void => {
      fail(isBudgetExpired(deadline, clock.now()) ? 'end-to-end-timeout' : 'save-timeout');
    };
    let drain: DrainState = INITIAL_DRAIN_STATE;

    for (;;) {
      if (!alive()) return;
      const now = clock.now();
      if (isBudgetExpired(deadline, now)) return fail('end-to-end-timeout');
      if (isBudgetExpired(drainDeadline, now)) return fail('save-timeout');

      const planned = planDrainRound(drain, ports.getDoc(path));
      drain = planned.state;
      const action = planned.action;

      if (action.kind === 'done') {
        finishClose(windowId, target);
        return;
      }
      if (action.kind === 'fail') {
        fail(action.reason);
        return;
      }

      if (action.kind === 'wait-saving') {
        const wait = await waitUntilSettled(path, activeDrainDeadline);
        if (!alive()) return;
        if (wait === 'budget-timeout') return failDrainBudget();
        if (wait === 'phase-timeout') return fail('save-timeout');
        continue;
      }

      const saveTask: Promise<CloseSaveOutcome> = Promise.resolve()
        .then(() => ports.saveDoc(path))
        .then(
          (outcome) => outcome,
          (error: unknown): CloseSaveOutcome => ({
            ok: false,
            error: { message: formatUnknownError(error, String(error)) },
            conflict: null,
          }),
        );

      const saveWait = await awaitWithBudget(
        saveTask,
        CLOSE_TIMEOUTS.roundMs,
        activeDrainDeadline,
        clock,
      );
      if (!alive()) {
        observeSave(saveTask, path);
        return;
      }
      if (saveWait.kind === 'budget-timeout' || saveWait.kind === 'phase-timeout') {
        observeSave(saveTask, path);
        if (saveWait.kind === 'budget-timeout') return failDrainBudget();
        return fail('save-timeout');
      }
      if (saveWait.kind === 'error') {
        return fail('save-failed', `保存失败：${formatUnknownError(saveWait.error, String(saveWait.error))}`);
      }
      if (!saveWait.value.ok) {
        // E_NOT_FOUND 等失败不能直接快关：先复核 Core 状态。
        const after = ports.getDoc(path);
        if (after?.externalKind === 'removed') return fail('conflict-removed');
        if (after?.externalKind === 'updated') return fail('conflict-updated');
        if (after === null) {
          // 文档已不在 Core：本次保存失败无需再报，按快关收尾。
          finishQuickClose(windowId);
          return;
        }
        const detail = saveWait.value.error?.message ?? '未知错误';
        return fail('save-failed', `保存失败：${detail}，已保留窗口与未落盘改动`);
      }
    }
  }

  /**
   * 「接受删除」入口：先复核 Core，再等待句柄并锁定，之后才进入唯一确认态。
   * 文档消失 → 快关；已变 updated → 冲突失败；冲突解除 → 回正常关闭。
   */
  async function runAcceptDeletion(
    windowId: string,
    target: CloseTarget,
    runId: number,
  ): Promise<void> {
    const path = target.path;
    if (!ports.hasDoc(path)) {
      finishQuickClose(windowId);
      return;
    }
    const doc = ports.getDoc(path);
    if (doc === null) {
      finishQuickClose(windowId);
      return;
    }
    if (doc.externalKind === 'updated') {
      failIfCurrent(windowId, path, runId, 'conflict-updated');
      return;
    }
    if (doc.externalKind !== 'removed') {
      await runNormalClose(windowId, target, runId);
      return;
    }

    // 确认期间必须冻结编辑：先等句柄、再锁定，失败则保留窗口。
    const deadline = createCloseDeadline(ports.now());
    const locked = await acquireLock(windowId, target, runId, deadline);
    if (locked === 'aborted') return;
    if (!isCurrent(windowId, runId)) return;

    setView({
      windowId,
      path,
      phase: 'confirming',
      stage: null,
      reason: 'conflict-removed',
      message: '确认丢弃本地未保存改动并关闭窗口？',
    });
  }

  function register(windowId: string, target: CloseTarget): () => void {
    targets.set(windowId, target);
    // 同一 windowId 重新挂载时清除上次遗留的确认 / 失败态。
    clearView(windowId);
    return () => {
      if (targets.get(windowId) === target) targets.delete(windowId);
    };
  }

  function requestClose(windowId: string, intent: CloseIntent = 'close'): void {
    const current = views.get(windowId);
    // 幂等：进行中 / 确认中的重复请求（含确认态下的标题栏 ×）不得打断流程。
    if (
      current !== undefined &&
      (current.phase === 'working' || current.phase === 'confirming')
    ) {
      return;
    }

    const target = targets.get(windowId);
    if (!target) {
      // A.6：编辑器目标未注册时中止并保留窗口，绝不绕过 flush 直接关窗。
      setFailed(windowId, windowId, 'handle-timeout');
      ports.notice('编辑器尚未就绪，已中止关闭并保留窗口', 'warning');
      return;
    }

    const runId = nextGeneration(windowId);
    // 接管即移交收尾职责：等待 / 保存期间卸载也不会触发第二套 save/close。
    target.handoff();

    if (intent === 'accept-deletion') void runAcceptDeletion(windowId, target, runId);
    else void runNormalClose(windowId, target, runId);
  }

  function confirmDiscard(windowId: string): void {
    // 只有确认态可以执行；重复确认 / 其他阶段一律忽略。
    if (views.get(windowId)?.phase !== 'confirming') return;

    const target = targets.get(windowId);
    if (!target) {
      setFailed(windowId, windowId, 'handle-timeout');
      return;
    }
    const runId = nextGeneration(windowId);
    const path = target.path;
    // 接管在 requestClose 时已完成；确认态期间不存在撤销，无需再次 handoff。

    // 确认执行前复核：进入确认态后磁盘可能已变化。
    if (!ports.hasDoc(path)) {
      finishQuickClose(windowId);
      return;
    }
    const doc = ports.getDoc(path);
    if (doc === null) {
      finishQuickClose(windowId);
      return;
    }
    if (doc.externalKind === 'updated') {
      setFailed(windowId, path, 'conflict-updated');
      return;
    }
    if (doc.externalKind !== 'removed') {
      // 冲突已解除：不按旧的删除确认丢弃，回正常关闭（已锁定，无需再次等待句柄）。
      void runNormalClose(windowId, target, runId, true);
      return;
    }

    // 仍为 removed：按用户确认丢弃本地改动。
    ports.closeWindow(windowId);
    ports.closeDoc(path);
    clearView(windowId);
    ports.notice(`已丢弃「${basename(path)}」的本地未保存改动并关闭窗口`, 'info');
  }

  function forceClose(windowId: string): void {
    const target = targets.get(windowId);
    nextGeneration(windowId);
    if (!target) {
      // 目标不存在（从未开始 flush）：没有 Core 文档需要保留，直接移除窗口。
      ports.closeWindow(windowId);
      clearView(windowId);
      return;
    }
    // handoff 已在接管时设置；不重复调用，也不 closeDoc（保留 Core dirty）。
    ports.closeWindow(windowId);
    clearView(windowId);
    ports.notice(
      `已强制关闭「${basename(target.path)}」：未保存改动仍保留在内存中`,
      'warning',
    );
  }

  function cancel(windowId: string): void {
    const target = targets.get(windowId);
    nextGeneration(windowId);
    // resume 在适配器内撤销 handoff 并解锁，恢复卸载时的常规 save/close。
    target?.resume();
    clearView(windowId);
  }

  function retry(windowId: string): void {
    const current = views.get(windowId);
    if (
      current !== undefined &&
      (current.phase === 'working' || current.phase === 'confirming')
    ) {
      return;
    }
    const target = targets.get(windowId);
    if (!target) {
      setFailed(windowId, windowId, 'handle-timeout');
      return;
    }
    const runId = nextGeneration(windowId);
    target.handoff();
    void runNormalClose(windowId, target, runId);
  }

  function resolveConflict(windowId: string): void {
    const target = targets.get(windowId);
    nextGeneration(windowId);
    target?.resume();
    clearView(windowId);
    ports.notice('请在冲突横幅中选择「重新加载」或「保留本地」后再关闭窗口', 'info');
  }

  return Object.freeze({
    register,
    requestClose,
    confirmDiscard,
    forceClose,
    cancel,
    retry,
    resolveConflict,
    view: (windowId: string) => views.get(windowId) ?? null,
    subscribe: (listener: CloseFlowListener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
}

/** 卸载清理需要的最小 release 结果结构（与 binding 的 ReleaseResult 结构兼容）。 */
export interface UnloadReleaseOutcome {
  readonly status: string;
  readonly error?: { readonly message: string } | null;
  readonly conflict?: unknown;
}

/**
 * 卸载清理：等到 openDoc 落定再 release；任何 rejection / 失败都显式上报，
 * 不产生未处理的 Promise rejection，也不静默吞掉写盘失败。
 */
export async function releaseOnUnmount(input: {
  readonly path: string;
  readonly awaitOpen: Promise<void>;
  readonly release: () => Promise<UnloadReleaseOutcome>;
  readonly report: (message: string) => void;
}): Promise<void> {
  try {
    await input.awaitOpen;
  } catch {
    // 打开失败已由加载态呈现；这里只等待其在途完成，避免 release 与 openDoc 竞态。
  }

  let result: UnloadReleaseOutcome;
  try {
    result = await input.release();
  } catch (error: unknown) {
    input.report(`关闭浮窗时保存异常：${input.path}：${formatUnknownError(error, String(error))}`);
    return;
  }

  if (result.status !== 'failed') return;
  const detail =
    result.error?.message ?? (result.conflict ? '存在外部冲突，未能写盘' : '未知错误');
  input.report(`关闭浮窗时保存失败：${detail}（${input.path}；改动仍保留）`);
}
