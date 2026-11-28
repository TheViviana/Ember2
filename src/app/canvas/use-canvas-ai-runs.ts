/**
 * 画布 AI / 分块 / 汇总节点的执行接线（React 侧薄层）。
 *
 * runner 本身零 React、零 IPC；本 hook 只负责把 store、IPC、engine 与通知
 * 组装成 runner 依赖，并持有运行态与取消入口。CanvasView 因此不再承载
 * 三段近似的执行编排。
 */
import { useCallback, useRef, useState, type RefObject } from 'react';
import { aiApi, docApi } from '../../data/app-api.ts';
import { useAiChatStore } from '../../features/ai/ai-chat-store.ts';
import { pushNotice } from '../stores/notice-store';
import { useEmberStore } from '../stores/ember-store';
import {
  createUpdateLabelCommand,
  makeEdgeId,
  makeNodeId,
} from './canvas-interactions.ts';
import { nodeSizeOf } from './node-layout.ts';
import type { CanvasEngine } from './engine.ts';
import {
  buildSplitRerunConfirmMessage,
  retryConfirmForBlock,
  splitRerunConflictFromSignal,
  type RetryBlockConfirm,
  type SplitRerunConflict,
} from './split-rerun-confirm.ts';
import {
  createAiNodeRunner,
  type AiRunApplyResult,
  type AiRunOutput,
} from './ai-node-run.ts';
import { createMergeNodeRunner } from './merge-node-run.ts';
import { createSplitNodeRunner } from './split-node-run.ts';
import { createSplitFailureCleanup, finishRetryBlock } from './split-failure-cleanup.ts';

export interface RunningAiState {
  readonly nodeId: string;
  readonly requestId: string;
}

export interface UseCanvasAiRunsOptions {
  readonly getEngine: () => CanvasEngine | null;
  readonly readOnly: boolean;
  readonly clearAiFlash: () => void;
  readonly flashAiResult: (engine: CanvasEngine, nodeId: string, kind: 'ok' | 'error') => void;
}

export interface SplitConfirmState {
  readonly nodeId: string;
  readonly message: string;
}

/** M2：split 运行态 k/N（只记录当前正在运行的分块节点）。 */
export interface StepProgressState {
  readonly nodeId: string;
  readonly done: number;
  readonly total: number;
}

export interface CanvasAiRuns {
  readonly runningAi: RunningAiState | null;
  readonly stepProgress: StepProgressState | null;
  readonly splitConfirm: SplitConfirmState | null;
  /** B2：命中下游边时的单块重试确认。 */
  readonly retryConfirm: RetryBlockConfirm | null;
  readonly runAiNode: (aiNodeId: string) => Promise<void>;
  readonly cancelAiRun: () => void;
  readonly runStepNode: (
    kind: 'split' | 'merge',
    nodeId: string,
    options?: { readonly replace?: boolean },
  ) => Promise<void>;
  readonly cancelStepRun: () => void;
  /** 确认覆盖：带 replace:true 重跑；取消则零命令、零历史。 */
  readonly confirmSplitRerun: () => Promise<void>;
  readonly cancelSplitRerun: () => void;
  /** 单块重试：只锁该块、成功写回一条历史。 */
  readonly retryStepBlock: (blockId: string) => Promise<void>;
  readonly confirmRetryBlock: () => Promise<void>;
  readonly cancelRetryBlock: () => void;
  /** engine 创建早于回调引用时，经 ref 调用避免 TDZ。 */
  readonly runAiNodeRef: RefObject<(aiNodeId: string) => Promise<void> | void>;
  readonly runStepNodeRef: RefObject<
    (kind: 'split' | 'merge', nodeId: string, options?: { readonly replace?: boolean }) => Promise<void> | void
  >;
  readonly retryStepBlockRef: RefObject<(blockId: string) => Promise<void> | void>;
}

interface ActiveRunner {
  cancel(): void;
}

export function useCanvasAiRuns(options: UseCanvasAiRunsOptions): CanvasAiRuns {
  const [runningAi, setRunningAi] = useState<RunningAiState | null>(null);
  const [stepProgress, setStepProgress] = useState<StepProgressState | null>(null);
  const [splitConfirm, setSplitConfirm] = useState<SplitConfirmState | null>(null);
  const [retryConfirm, setRetryConfirm] = useState<RetryBlockConfirm | null>(null);
  const aiRunnerRef = useRef<ActiveRunner | null>(null);
  const stepRunnerRef = useRef<ActiveRunner | null>(null);
  const pendingSplitConflictRef = useRef<SplitRerunConflict | null>(null);
  const splitFailureCleanupRef = useRef(createSplitFailureCleanup());
  const { getEngine, readOnly, clearAiFlash, flashAiResult } = options;

  /** AI / 汇总共用的结果写回：label 走命令，document 走带 sha 的整篇写入。 */
  const applyAiOutput = useCallback(
    async (engine: CanvasEngine, output: AiRunOutput): Promise<AiRunApplyResult> => {
      if (output.kind === 'label') {
        return engine.executeCommands([createUpdateLabelCommand(output.nodeId, output.text)])
          ? { ok: true }
          : { ok: false, reason: 'command' };
      }
      try {
        const result = await useEmberStore
          .getState()
          .writeDocText(output.docPath, output.text, output.expectedSha);
        if (!result.ok) {
          return result.reason === 'dirty'
            ? { ok: false, reason: 'dirty' }
            : { ok: false, reason: 'failed', error: result.error };
        }
        engine.invalidateDocPreview(output.docPath);
        engine.refreshViews();
        return { ok: true };
      } catch (error: unknown) {
        return { ok: false, reason: 'failed', error };
      }
    },
    [],
  );

  const runAiNodeRef = useRef<(aiNodeId: string) => Promise<void> | void>(() => undefined);
  const runAiNode = useCallback(
    async (aiNodeId: string): Promise<void> => {
      const engine = getEngine();
      if (engine === null) return;
      if (readOnly) {
        pushNotice('画布只读，无法执行 AI 节点', 'warning');
        return;
      }
      if (aiRunnerRef.current !== null || stepRunnerRef.current !== null) {
        pushNotice('已有 AI 节点在执行，请先取消', 'warning');
        return;
      }
      clearAiFlash();
      const runner = createAiNodeRunner({
        getDocument: () => engine.getDocument(),
        liveText: (path) => useEmberStore.getState().docs.get(path)?.text ?? null,
        readSnapshot: (path) => docApi.read(path),
        aiConfig: useAiChatStore.getState().config,
        stream: (request, handlers) => {
          setRunningAi({ nodeId: aiNodeId, requestId: request.requestId });
          return aiApi.chatStream(request, {
            onDelta: (event) => handlers.onDelta(event.text),
            onDone: () => handlers.onDone(),
            onError: (_error, event) => handlers.onError(event.code, event.message),
          });
        },
        cancel: (requestId) => {
          void aiApi.cancel(requestId).catch(() => undefined);
        },
        notice: (message, tone) => pushNotice(message, tone),
        execute: (output) => applyAiOutput(engine, output),
        flash: (nodeId, kind) => flashAiResult(engine, nodeId, kind),
      });
      aiRunnerRef.current = runner;
      try {
        await runner.start(aiNodeId);
      } finally {
        if (aiRunnerRef.current === runner) {
          aiRunnerRef.current = null;
          setRunningAi(null);
        }
      }
    },
    [applyAiOutput, clearAiFlash, flashAiResult, getEngine, readOnly],
  );
  runAiNodeRef.current = runAiNode;

  const cancelAiRun = useCallback((): void => {
    const runner = aiRunnerRef.current;
    if (runner === null) return;
    aiRunnerRef.current = null;
    setRunningAi(null);
    runner.cancel();
  }, []);

  const runStepNodeRef = useRef<
    (kind: 'split' | 'merge', nodeId: string, options?: { readonly replace?: boolean }) => Promise<void> | void
  >(() => undefined);
  const cancelStepRun = useCallback((): void => {
    const runner = stepRunnerRef.current;
    if (runner === null) return;
    stepRunnerRef.current = null;
    setRunningAi(null);
    setStepProgress(null);
    runner.cancel();
  }, []);

  const createSplitRunnerFor = useCallback(
    (engine: CanvasEngine, runNodeId: string, onCommitted?: () => void) =>
      createSplitNodeRunner({
      getDocument: () => engine.getDocument(),
      liveText: (path) => useEmberStore.getState().docs.get(path)?.text ?? null,
      readSnapshot: (path) => docApi.read(path),
      aiConfig: useAiChatStore.getState().config,
      stream: (request, handlers) => {
        setRunningAi({ nodeId: runNodeId, requestId: request.requestId });
        return aiApi.chatStream(request, {
          onDelta: (event) => handlers.onDelta(event.text),
          onDone: () => handlers.onDone(),
          onError: (_error, event) => handlers.onError(event.code, event.message),
        });
      },
      cancel: (requestId) => {
        void aiApi.cancel(requestId).catch(() => undefined);
      },
      notice: (message, tone, signal) => {
        const conflict = splitRerunConflictFromSignal(signal);
        if (conflict !== null) {
          pendingSplitConflictRef.current = conflict;
          return;
        }
        pushNotice(message, tone);
      },
      executeCommands: (commands) => {
        const ok = engine.executeCommands(commands);
        if (ok) onCommitted?.();
        return ok;
      },
      createNodeId: makeNodeId,
      createEdgeId: makeEdgeId,
      occupiedRects: (excludeIds) =>
        engine
          .getNodeViews()
          .filter((view) => !excludeIds.includes(view.id))
          .map((view) => {
            const size = nodeSizeOf(view);
            return { x: view.x, y: view.y, w: size.w, h: size.h };
          }),
      progress: (progress) =>
        setStepProgress({ nodeId: runNodeId, done: progress.done, total: progress.total }),
      flash: (id, kind) => {
        if (kind === 'error') engine.setStepFailed(id, true);
        flashAiResult(engine, id, kind);
      },
    }),
    [flashAiResult],
  );

  const createMergeRunnerFor = useCallback(
    (engine: CanvasEngine, runNodeId: string) =>
      createMergeNodeRunner({
      getDocument: () => engine.getDocument(),
      aiConfig: useAiChatStore.getState().config,
      stream: (request, handlers) => {
        setRunningAi({ nodeId: runNodeId, requestId: request.requestId });
        return aiApi.chatStream(request, {
          onDelta: (event) => handlers.onDelta(event.text),
          onDone: () => handlers.onDone(),
          onError: (_error, event) => handlers.onError(event.code, event.message),
        });
      },
      cancel: (requestId) => {
        void aiApi.cancel(requestId).catch(() => undefined);
      },
      notice: (message, tone) => pushNotice(message, tone),
      execute: (output) => applyAiOutput(engine, output),
      readSnapshot: (path) => docApi.read(path),
      flash: (id, kind) => flashAiResult(engine, id, kind),
    }),
    [applyAiOutput, flashAiResult],
  );
  const runStepNode = useCallback(
    async (
      kind: 'split' | 'merge',
      nodeId: string,
      options?: { readonly replace?: boolean },
    ): Promise<void> => {
      const engine = getEngine();
      if (engine === null) return;
      if (readOnly) {
        pushNotice('画布只读，无法执行节点', 'warning');
        return;
      }
      if (stepRunnerRef.current !== null || aiRunnerRef.current !== null) {
        pushNotice('已有 AI 节点在执行，请先取消', 'warning');
        return;
      }
      clearAiFlash();
      pendingSplitConflictRef.current = null;
      setStepProgress(null);
      setRetryConfirm(null);
      if (kind === 'split') {
        splitFailureCleanupRef.current.collect(engine.getDocument().nodes, nodeId);
      } else {
        splitFailureCleanupRef.current.discard();
      }
      let committed = false;
      const runner =
        kind === 'split'
          ? createSplitRunnerFor(engine, nodeId, () => {
              committed = true;
            })
          : createMergeRunnerFor(engine, nodeId);
      stepRunnerRef.current = runner;
      try {
        if (kind === 'split') await runner.start(nodeId, options);
        else await runner.start(nodeId);
      } finally {
        if (stepRunnerRef.current === runner) {
          stepRunnerRef.current = null;
          setRunningAi(null);
          setStepProgress(null);
        }
      }
      if (kind !== 'split') return;
      const conflict = pendingSplitConflictRef.current;
      pendingSplitConflictRef.current = null;
      if (conflict !== null) {
        setSplitConfirm({ nodeId, message: buildSplitRerunConfirmMessage(conflict) });
        return;
      }
      splitFailureCleanupRef.current.finish(committed, (id, failed) => engine.setStepFailed(id, failed));
    },
    [clearAiFlash, createMergeRunnerFor, createSplitRunnerFor, getEngine, readOnly],
  );
  runStepNodeRef.current = runStepNode;

  const confirmSplitRerun = useCallback(async (): Promise<void> => {
    const pending = splitConfirm;
    if (pending === null) return;
    setSplitConfirm(null);
    await runStepNodeRef.current('split', pending.nodeId, { replace: true });
  }, [splitConfirm]);
  const cancelSplitRerun = useCallback((): void => {
    splitFailureCleanupRef.current.discard();
    setSplitConfirm(null);
  }, []);

  const retryStepBlockRef = useRef<(blockId: string) => Promise<void> | void>(() => undefined);
  const retryStepBlockNow = useCallback(
    async (blockId: string): Promise<void> => {
      const engine = getEngine();
      if (engine === null) return;
      if (readOnly) {
        pushNotice('画布只读，无法重试', 'warning');
        return;
      }
      if (stepRunnerRef.current !== null || aiRunnerRef.current !== null) {
        pushNotice('已有 AI 节点在执行，请先取消', 'warning');
        return;
      }
      clearAiFlash();
      let committed = false;
      const runner = createSplitRunnerFor(engine, blockId, () => {
        committed = true;
      });
      stepRunnerRef.current = runner;
      setRunningAi({ nodeId: blockId, requestId: 'retry' });
      try {
        await runner.retryBlock(blockId);
      } finally {
        if (stepRunnerRef.current === runner) {
          stepRunnerRef.current = null;
          setRunningAi(null);
        }
      }
      finishRetryBlock(committed, blockId, (id, failed) => engine.setStepFailed(id, failed));
    },
    [clearAiFlash, createSplitRunnerFor, getEngine, readOnly],
  );

  /** B2：有下游边时先确认；无下游保持原行为，直接重试。 */
  const retryStepBlock = useCallback(
    async (blockId: string): Promise<void> => {
      const engine = getEngine();
      if (engine === null) return;
      if (readOnly) {
        pushNotice('画布只读，无法重试', 'warning');
        return;
      }
      if (stepRunnerRef.current !== null || aiRunnerRef.current !== null) {
        pushNotice('已有 AI 节点在执行，请先取消', 'warning');
        return;
      }
      const confirm = retryConfirmForBlock(engine.getDocument().edges, blockId);
      if (confirm !== null) {
        setRetryConfirm(confirm);
        return;
      }
      await retryStepBlockNow(blockId);
    },
    [getEngine, readOnly, retryStepBlockNow],
  );
  retryStepBlockRef.current = retryStepBlock;

  const confirmRetryBlock = useCallback(async (): Promise<void> => {
    const pending = retryConfirm;
    if (pending === null) return;
    setRetryConfirm(null);
    await retryStepBlockNow(pending.nodeId);
  }, [retryConfirm, retryStepBlockNow]);

  const cancelRetryBlock = useCallback((): void => setRetryConfirm(null), []);

  return {
    runningAi,
    stepProgress,
    splitConfirm,
    retryConfirm,
    runAiNode,
    cancelAiRun,
    runStepNode,
    cancelStepRun,
    confirmSplitRerun,
    cancelSplitRerun,
    retryStepBlock,
    confirmRetryBlock,
    cancelRetryBlock,
    runAiNodeRef,
    runStepNodeRef,
    retryStepBlockRef,
  };
}