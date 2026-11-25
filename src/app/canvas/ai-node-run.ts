/**
 * CR-R4-2：AI 节点执行编排（依赖注入，零 React / 零 IPC）。
 *
 * 编排链：收集有向素材/输出 → 校验输出目标 → 读文档素材 → 构造消息 → chatStream
 * → 写回文本节点或空文档。所有外部能力经 deps 注入，失败路径可在 node 下用
 * fake deps 覆盖。
 */
import { formatUnknownError } from '../../core/errors.ts';
import type { AiChatConfig } from '../../features/ai/ai-chat-store.ts';
import { startChatSession, type ChatSession } from '../../features/ai/chat-session.ts';
import type { AiChatRequest } from '../../types/ipc.ts';
import {
  AI_RUN_MAX_CHARS,
  buildAiRunMessages,
  collectAiNeighbors,
} from './ai-node-execution.ts';

export interface AiRunSnapshot {
  readonly text: string;
  readonly sha256: string;
}

export interface AiStreamHandlers {
  readonly onDelta: (text: string) => void;
  readonly onDone: () => void;
  readonly onError: (code: string, message: string) => void;
}

export type AiRunOutput =
  | { readonly kind: 'label'; readonly nodeId: string; readonly text: string }
  | {
      readonly kind: 'document';
      readonly docPath: string;
      readonly label: string;
      readonly text: string;
      readonly expectedSha: string;
    };

export type AiRunApplyResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'command' | 'dirty' | 'failed';
      readonly error?: unknown;
    };

export interface AiNodeRunDeps {
  readonly getDocument: () => {
    readonly nodes: readonly unknown[];
    readonly edges: readonly unknown[];
  };
  readonly liveText: (path: string) => string | null;
  readonly readSnapshot: (path: string) => Promise<AiRunSnapshot>;
  readonly aiConfig: AiChatConfig;
  readonly stream: (request: AiChatRequest, handlers: AiStreamHandlers) => Promise<void>;
  readonly cancel: (requestId: string) => void;
  readonly notice: (message: string, tone: 'info' | 'warning' | 'error') => void;
  readonly execute: (output: AiRunOutput) => Promise<AiRunApplyResult>;
  readonly flash: (nodeId: string, kind: 'ok' | 'error') => void;
}

export interface AiNodeRunner {
  readonly start: (nodeId: string) => Promise<void>;
  readonly cancel: () => void;
}

export function createAiNodeRunner(deps: AiNodeRunDeps): AiNodeRunner {
  let active: { readonly nodeId: string } | null = null;
  let activeSession: ChatSession | null = null;
  let settleOutput: (() => void) | null = null;

  const start = async (aiNodeId: string): Promise<void> => {
    if (active !== null) {
      deps.notice('已有 AI 节点在执行，请先取消', 'warning');
      return;
    }
    const raw = deps.getDocument();
    const collected = collectAiNeighbors(raw.nodes, raw.edges, aiNodeId);
    const outputNodeId = collected.outputNodeId;
    const outputDoc = collected.outputDoc;
    if (outputNodeId !== null && outputDoc !== null) {
      deps.notice('输出目标不唯一：请只保留文本节点或 AI → 文档输出之一', 'warning');
      return;
    }
    if (outputNodeId === null && outputDoc === null) {
      deps.notice('请连接文本节点，或从 AI 节点拉线到空文章作为输出', 'warning');
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
    if (collected.docs.length === 0) {
      deps.notice('请先把文章（文档节点）连到 AI 节点', 'warning');
      return;
    }
    const sections: { readonly title: string; readonly content: string }[] = [];
    for (const doc of collected.docs) {
      try {
        const live = deps.liveText(doc.docPath);
        const content = live !== null ? live : (await deps.readSnapshot(doc.docPath)).text;
        sections.push({ title: doc.label, content });
      } catch (error: unknown) {
        deps.notice(
          `读取文章失败：${doc.label}：${formatUnknownError(error, '未知画布错误')}`,
          'error',
        );
        return;
      }
    }
    const messages = buildAiRunMessages({ docs: sections, prompts: collected.prompts });
    if (!messages.ok) {
      deps.notice(
        messages.reason === 'empty_docs'
          ? '没有可分析的文章内容'
          : `素材过长（上限 ${AI_RUN_MAX_CHARS} 字符），请减少文章`,
        'warning',
      );
      return;
    }
    const aiConfig = deps.aiConfig;
    const run = { nodeId: aiNodeId };
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
      deps.flash(aiNodeId, kind);
    };
    const completeOutput = async (): Promise<void> => {
      if (!isActive()) return;
      try {
        const output = full.trim();
        if (output === '') {
          finishWithFlash('error');
          deps.notice('AI 未返回内容', 'warning');
          return;
        }
        if (outputNodeId !== null) {
          const result = await deps.execute({ kind: 'label', nodeId: outputNodeId, text: output });
          if (!isActive()) return;
          finishWithFlash(result.ok ? 'ok' : 'error');
          deps.notice(
            result.ok ? 'AI 结果已写入文本节点' : '画布已切换，结果未写入',
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
        deps.notice('AI 结果已写入文档节点', 'info');
      } catch (error: unknown) {
        if (!isActive()) return;
        finishWithFlash('error');
        deps.notice(
          outputDoc === null
            ? `写入 AI 结果失败：${formatUnknownError(error, '未知画布错误')}`
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
      deps.notice('AI 节点执行中…', 'info');
    };
    const session = startChatSession(
      {
        config: { ...aiConfig, model: collected.model ?? aiConfig.model },
        messages: [{ id: 'ai-node-input', role: 'user', content: messages.user, completed: true }],
        system: messages.system,
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
                  ? '请先双击 AI 节点选择模型'
                  : 'AI 请求构造失败',
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
