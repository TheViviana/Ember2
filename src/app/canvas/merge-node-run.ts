/**
 * 汇总节点执行编排（依赖注入，零 React / 零 IPC）。
 *
 * 收 text → merge 的全部上游块，按连线顺序拼接，一次生成后写入
 * merge → 文本节点或 merge → 空文档。输入超过预算时拒绝执行并报数。
 */
import { formatUnknownError } from '../../core/errors.ts';
import type { AiChatConfig } from '../../features/ai/ai-chat-store.ts';
import { startChatSession, type ChatSession } from '../../features/ai/chat-session.ts';
import { charBudgetFor } from '../../features/ai/model-budget.ts';
import { composeSystemPrompt } from '../../features/ai/system-prompt.ts';
import type { AiChatRequest } from '../../types/ipc.ts';
import type { AiRunApplyResult, AiRunOutput, AiRunSnapshot, AiStreamHandlers } from './ai-node-run.ts';
import {
  buildMergeSystem,
  buildMergeUser,
  collectMergeConfig,
  mergeInputChars,
  mergeOutputKind,
} from './split-node-execution.ts';

export interface MergeRunDeps {
  readonly getDocument: () => {
    readonly nodes: readonly unknown[];
    readonly edges: readonly unknown[];
  };
  readonly aiConfig: AiChatConfig;
  /** 全局与画布层提示词；汇总指令作为节点层。 */
  readonly systemContext?: { readonly global: string; readonly canvas: string };
  readonly stream: (request: AiChatRequest, handlers: AiStreamHandlers) => Promise<void>;
  readonly cancel: (requestId: string) => void;
  readonly notice: (message: string, tone: 'info' | 'warning' | 'error') => void;
  readonly execute: (output: AiRunOutput) => Promise<AiRunApplyResult>;
  readonly readSnapshot: (path: string) => Promise<AiRunSnapshot>;
  readonly flash: (nodeId: string, kind: 'ok' | 'error') => void;
}

export interface MergeRunner {
  readonly start: (nodeId: string) => Promise<void>;
  readonly cancel: () => void;
}

export function createMergeNodeRunner(deps: MergeRunDeps): MergeRunner {
  let active: { readonly nodeId: string } | null = null;
  let activeSession: ChatSession | null = null;
  let settleOutput: (() => void) | null = null;

  const start = async (mergeNodeId: string): Promise<void> => {
    if (active !== null) {
      deps.notice('已有分块或汇总任务在执行，请先取消', 'warning');
      return;
    }
    const raw = deps.getDocument();
    const collected = collectMergeConfig(raw.nodes, raw.edges, mergeNodeId);
    const outputNodeId = collected.outputNodeId;
    const outputDoc = collected.outputDoc;

    if (mergeOutputKind(raw.nodes, raw.edges, mergeNodeId) === 'ambiguous') {
      deps.notice('输出目标不唯一：请只保留文本节点或汇总 → 文档输出之一', 'warning');
      return;
    }
    if (outputNodeId === null && outputDoc === null) {
      deps.notice('请连接文本节点，或从汇总节点拉线到空文章作为输出', 'warning');
      return;
    }
    if (collected.inputs.length === 0) {
      deps.notice('请先把块（文本节点）连到汇总节点', 'warning');
      return;
    }
    if (outputDoc !== null) {
      try {
        const existing = await deps.readSnapshot(outputDoc.docPath);
        if (existing.text.trim() !== '') {
          deps.notice('输出文档已有内容，仅允许写入空文件', 'warning');
          return;
        }
      } catch (error: unknown) {
        deps.notice(
          `读取输出文档失败：${outputDoc.label}：${formatUnknownError(error, '未知画布错误')}`,
          'error',
        );
        return;
      }
    }

    const budget = charBudgetFor(deps.aiConfig.provider);
    const total = mergeInputChars(collected.inputs);
    if (total > budget) {
      deps.notice(
        `上游共 ${total} 字符，超过预算 ${budget} 字符；请减少上游内容，或先拆分再汇总`,
        'warning',
      );
      return;
    }

    const aiConfig = deps.aiConfig;
    const run = { nodeId: mergeNodeId };
    const isActive = (): boolean => active === run;
    active = run;
    let full = '';
    const finishRun = (): void => {
      if (isActive()) {
        active = null;
        activeSession = null;
      }
    };
    const finishWithFlash = (kind: 'ok' | 'error'): void => {
      finishRun();
      deps.flash(mergeNodeId, kind);
    };

    const completeOutput = async (): Promise<void> => {
      if (!isActive()) return;
      try {
        const output = full.trim();
        if (output === '') {
          finishWithFlash('error');
          deps.notice('汇总未返回内容', 'warning');
          return;
        }
        if (outputNodeId !== null) {
          const result = await deps.execute({ kind: 'label', nodeId: outputNodeId, text: output });
          if (!isActive()) return;
          finishWithFlash(result.ok ? 'ok' : 'error');
          deps.notice(
            result.ok ? '汇总结果已写入文本节点' : '画布已切换，结果未写入',
            result.ok ? 'info' : 'error',
          );
          return;
        }
        if (outputDoc === null) {
          finishWithFlash('error');
          deps.notice('输出目标已失效，结果未写入', 'error');
          return;
        }
        const current = await deps.readSnapshot(outputDoc.docPath);
        if (!isActive()) return;
        if (current.text.trim() !== '') {
          finishWithFlash('error');
          deps.notice('输出文档已有内容，结果未写入', 'error');
          return;
        }
        const result = await deps.execute({
          kind: 'document',
          docPath: outputDoc.docPath,
          label: outputDoc.label,
          text: output,
          expectedSha: current.sha256,
        });
        if (!isActive()) return;
        if (!result.ok) {
          if (result.reason === 'dirty') {
            finishWithFlash('error');
            deps.notice('输出文档已被编辑，结果未写入', 'error');
            return;
          }
          throw result.error;
        }
        finishWithFlash('ok');
        deps.notice('汇总结果已写入文档节点', 'info');
      } catch (error: unknown) {
        if (!isActive()) return;
        finishWithFlash('error');
        deps.notice(
          outputDoc === null
            ? `写入汇总结果失败：${formatUnknownError(error, '未知画布错误')}`
            : `写入输出文档失败：${outputDoc.label}：${formatUnknownError(error, '未知画布错误')}`,
          'error',
        );
      }
    };

    let markOutputSettled: () => void = () => undefined;
    const outputSettled = new Promise<void>((resolve) => {
      markOutputSettled = resolve;
    });
    settleOutput = markOutputSettled;

    let buildFailure = false;
    let started = false;
    const notifyStarted = (): void => {
      if (started) return;
      started = true;
      deps.notice('汇总节点执行中…', 'info');
    };

    const mergeSystem = buildMergeSystem(collected.prompt);
    const session = startChatSession(
      {
        config: { ...aiConfig, model: collected.model ?? aiConfig.model },
        messages: [
          {
            id: 'merge-node-input',
            role: 'user',
            content: buildMergeUser(collected.inputs),
            completed: true,
          },
        ],
        system: composeSystemPrompt({
          global: deps.systemContext?.global,
          canvas: deps.systemContext?.canvas,
          node: [mergeSystem],
          fallback: mergeSystem,
        }),
      },
      {
        onDelta: (text) => {
          notifyStarted();
          if (isActive()) full = text;
        },
        onDone: () => {
          notifyStarted();
          void completeOutput().finally(markOutputSettled);
        },
        onError: (failure) => {
          if (failure.kind === 'build') {
            buildFailure = true;
            deps.notice(
              failure.reason === 'invalid_base_url'
                ? '请先在设置中配置 AI 端点'
                : failure.reason === 'missing_model'
                  ? '请先双击汇总节点选择模型'
                  : '汇总请求构造失败',
              'warning',
            );
            markOutputSettled();
            return;
          }
          if (!isActive()) return;
          notifyStarted();
          finishWithFlash('error');
          deps.notice(failure.text, 'error');
          markOutputSettled();
        },
      },
      { stream: deps.stream, cancel: (requestId) => deps.cancel(requestId) },
    );
    if (buildFailure) {
      active = null;
      settleOutput = null;
      return;
    }
    activeSession = session;
    notifyStarted();
    try {
      await outputSettled;
    } finally {
      settleOutput = null;
    }
  };

  return Object.freeze({
    start,
    cancel: (): void => {
      const current = active;
      if (current === null) return;
      active = null;
      const session = activeSession;
      activeSession = null;
      session?.cancel();
      settleOutput?.();
      settleOutput = null;
    },
  });
}