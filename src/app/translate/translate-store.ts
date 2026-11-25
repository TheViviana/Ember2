/**
 * 翻译状态（全局单例）：浮窗与画布节点共用同一张结果卡。
 *
 * 对照翻译（CR-20261121-42）：联网模式按 Rust plan_segments 的段落逐段请求；
 * AI 模式按前端 planAiSegments 的段落逐段串行调用 ai_chat_stream。两种模式
 * 都以「原文 + 译文」成对累积（segments），按钮计数与对照展示两模式统一。
 * 译文默认只展示，不直接写入正文；写入走第二批的提案确认。
 */
import { create } from 'zustand';
import { aiApi, translateApi } from '../../data/app-api.ts';
import { useAiChatStore } from '../../features/ai/ai-chat-store.ts';
import { createChatRequestId } from '../../features/ai/ai-chat-request.ts';
import { startChatSession } from '../../features/ai/chat-session.ts';
import {
  DEFAULT_TRANSLATE_LANGUAGE,
  buildTranslateRequest,
} from '../../features/translate/translate-request.ts';
import { planAiSegments, planAiTranslateChunks } from '../../features/translate/translate-segments.ts';
import { loadTranslateSettings } from '../../features/translate/translate-settings.ts';

export type TranslationStatus = 'idle' | 'streaming' | 'done' | 'error' | 'cancelled';

export interface TranslateStartArgs {
  readonly text: string;
  readonly sourcePath: string | null;
  readonly sourceLabel: string;
  readonly targetLang?: string;
  /** 失败即時回调（CR-20261120-40 B）：宿主借此在点击处 pushNotice，译文块在视口外也能感知。 */
  readonly onFailure?: (failure: TranslateFailure) => void;
}

export type TranslateFailureKind = 'empty' | 'unconfigured' | 'error';

export interface TranslateFailure {
  readonly kind: TranslateFailureKind;
  readonly message: string;
}

export interface TranslatePair {
  /** 所属段落序号（从 0 起；超长切分子段共享同一序号），内联展示按它对位。 */
  readonly index: number;
  readonly source: string;
  readonly text: string;
}

export interface TranslateStore {
  readonly open: boolean;
  readonly status: TranslationStatus;
  /** 对照翻译段（CR-20261121-42）：每段原文 + 译文成对累积，两种模式统一展示。 */
  readonly segments: ReadonlyArray<TranslatePair>;
  /** 联网模式 resolve 的全文兜底（展示走 segments；AI 逐段不再使用）。 */
  readonly output: string;
  readonly error: string | null;
  readonly sourceText: string;
  readonly sourceLabel: string;
  readonly sourcePath: string | null;
  readonly targetLang: string;
  /** 当前在途请求 id（AI 逐段时随段更新），供取消与事件代次守卫。 */
  readonly requestId: string | null;
  /** 本次翻译链的代次令牌：取消/关闭/重新 start 后旧串行链据此停止。 */
  readonly chainToken: string | null;
  /** 失败后保留的“从失败段续译”闭包；非 null 时 UI 显示继续翻译。 */
  readonly resumeRun: (() => void) | null;
  readonly online: boolean;
  /** 分段进度（CR-20261120-40）：两种模式都有值；`done`/`total` 只增不减。 */
  readonly progress: { done: number; total: number } | null;
  readonly setTargetLang: (lang: string) => void;
  readonly start: (args: TranslateStartArgs) => void;
  /** 失败后从失败段继续（AI 模式；无待续任务时安全空转）。 */
  readonly resume: () => void;
  readonly cancel: () => void;
  readonly close: () => void;
}

const INITIAL = {
  open: false,
  status: 'idle' as TranslationStatus,
  segments: [] as ReadonlyArray<TranslatePair>,
  output: '',
  error: null,
  sourceText: '',
  sourceLabel: '',
  sourcePath: null,
  targetLang: loadTranslateSettings().targetLang || DEFAULT_TRANSLATE_LANGUAGE,
  requestId: null,
  chainToken: null as string | null,
  resumeRun: null as (() => void) | null,
  online: false,
  progress: null as { done: number; total: number } | null,
};

export const useTranslateStore = create<TranslateStore>()((set, get) => ({
  ...INITIAL,
  setTargetLang: (lang) => set({ targetLang: lang }),
  start: (args) => {
    const settings = loadTranslateSettings();
    const targetLang = args.targetLang ?? settings.targetLang ?? get().targetLang;
    const text = args.text.trim();
    if (text === '') {
      set({
        open: true,
        status: 'error',
        output: '',
        segments: [],
        error: '没有可翻译的内容',
        sourceText: args.text,
        sourceLabel: args.sourceLabel,
        sourcePath: args.sourcePath,
        targetLang,
        requestId: null,
        chainToken: null,
        online: settings.mode === 'online',
        progress: null,
      });
      args.onFailure?.({ kind: 'empty', message: '没有可翻译的内容' });
      return;
    }

    // 联网翻译：Rust 按段落规划并逐段推送（对照事件），走独立 IPC。
    if (settings.mode === 'online') {
      const requestId = createChatRequestId();
      set({
        open: true,
        status: 'streaming',
        output: '',
        segments: [],
        error: null,
        sourceText: args.text,
        sourceLabel: args.sourceLabel,
        sourcePath: args.sourcePath,
        targetLang,
        requestId,
        chainToken: null,
        resumeRun: null,
        online: true,
        progress: null,
      });
      void translateApi
        .online({ text, targetLang }, (event) => {
          if (get().requestId !== requestId) return;
          if (event.type === 'progress') {
            set({ progress: { done: event.done, total: event.total } });
          } else {
            // 对照翻译：每段原文+译文成对累积；resolve 全文仅兜底。
            set((state) => ({
              segments: [
                ...state.segments,
                { index: event.index, source: event.source, text: event.text },
              ],
            }));
          }
        })
        .then((output) => {
          if (get().requestId !== requestId) return;
          set({ status: 'done', output });
        })
        .catch((error: unknown) => {
          if (get().requestId !== requestId) return;
          const message = error instanceof Error ? error.message : '联网翻译失败';
          set({ status: 'error', error: message });
          args.onFailure?.({ kind: 'error', message });
        });
      return;
    }

    // AI 对照翻译：前端按段落规划，逐段串行调用 ai_chat_stream，每段成对累积。
    const planned = planAiSegments(args.text);
    if (!planned.ok || planned.segments.length === 0) {
      const reason = planned.ok ? '没有可翻译的内容' : planned.reason;
      set({
        open: true,
        status: 'error',
        output: '',
        segments: [],
        error: reason,
        sourceText: args.text,
        sourceLabel: args.sourceLabel,
        sourcePath: args.sourcePath,
        targetLang,
        requestId: null,
        chainToken: null,
        resumeRun: null,
        online: false,
        progress: null,
      });
      args.onFailure?.({ kind: planned.ok ? 'empty' : 'error', message: reason });
      return;
    }
    // 2026-11-23：超长段落切成 <= MAX_AI_TRANSLATE_CHUNK_CHARS 的块，
    // 仍按原段落序号回填，避免单请求超出模型上下文导致整篇翻译中断。
    const chunks = planAiTranslateChunks(planned.segments);
    if (chunks.length === 0) {
      set({
        open: true,
        status: 'error',
        output: '',
        segments: [],
        error: '没有可翻译的内容',
        sourceText: args.text,
        sourceLabel: args.sourceLabel,
        sourcePath: args.sourcePath,
        targetLang,
        requestId: null,
        chainToken: null,
        resumeRun: null,
        online: false,
        progress: null,
      });
      args.onFailure?.({ kind: 'empty', message: '没有可翻译的内容' });
      return;
    }
    const chainToken = createChatRequestId();
    const total = chunks.length;
    set({
      open: true,
      status: 'streaming',
      output: '',
      segments: [],
      error: null,
      sourceText: args.text,
      sourceLabel: args.sourceLabel,
      sourcePath: args.sourcePath,
      targetLang,
      requestId: null,
      chainToken,
      resumeRun: null,
      online: false,
      progress: { done: 0, total },
    });
    const chainActive = (): boolean =>
      get().chainToken === chainToken && get().status === 'streaming';

    /**
     * 从 startIndex 开始跑 chunk 链。
     * 每块失败自动重试一次；仍失败则把从该块续译的闭包放进 resumeRun。
     */
    const runChunks = (startIndex: number): void => {
      void (async () => {
        let done = get().segments.length;
        for (let index = startIndex; index < chunks.length; index += 1) {
          if (!chainActive()) return;
          const chunk = chunks[index];
          if (chunk === undefined) continue;
          const { index: paragraphIndex, text: source } = chunk;
          let segmentText = '';
          let segmentError: string | null = null;
          let failureKind: 'unconfigured' | 'error' = 'error';

          for (let attempt = 0; attempt < 2; attempt += 1) {
            if (attempt > 0) {
              await new Promise<void>((resolveDelay) => {
                globalThis.setTimeout(resolveDelay, 400);
              });
            }
            if (!chainActive()) return;
            // 每次重试读取最新 AI 配置：用户可能刚修好端点/Key。
            const currentConfig = useAiChatStore.getState().config;
            const built = buildTranslateRequest({
              config: currentConfig,
              text: source,
              targetLang,
            });
            if (!built.ok) {
              segmentError = built.reason;
              failureKind = 'unconfigured';
              break;
            }
            set({ requestId: built.request.requestId });
            let attemptText = '';
            let attemptError: string | null = null;
            let attemptKind: 'unconfigured' | 'error' = 'error';
            let attemptRetryable = true;
            await new Promise<void>((resolveSegment) => {
              startChatSession(
                {
                  requestId: built.request.requestId,
                  config: currentConfig,
                  messages: built.request.messages.map((message, id) => ({
                    id: `translate-${id}`,
                    role: 'user' as const,
                    content: message.content,
                    completed: true,
                  })),
                },
                {
                  onDelta: (text) => {
                    if (get().requestId === built.request.requestId) attemptText = text;
                  },
                  onDone: resolveSegment,
                  onError: (failure) => {
                    if (failure.kind === 'build') {
                      attemptError = failure.reason;
                      attemptKind = 'unconfigured';
                      attemptRetryable = false;
                    } else {
                      attemptError = failure.message;
                      attemptKind = 'error';
                      attemptRetryable = true;
                    }
                    resolveSegment();
                  },
                },
                {
                  stream: (request, handlers) => aiApi.chatStream(request, {
                    onDelta: (event) => handlers.onDelta(event.text),
                    onDone: () => handlers.onDone(),
                    onError: (_error, event) => handlers.onError(event.code, event.message),
                  }),
                  cancel: (requestId) => aiApi.cancel(requestId),
                },
              );
            });
            if (!chainActive()) return;
            if (attemptError === null) {
              segmentText = attemptText;
              segmentError = null;
              break;
            }
            segmentText = '';
            segmentError = attemptError;
            failureKind = attemptKind;
            if (!attemptRetryable) break;
          }

          if (segmentError !== null) {
            const message = segmentError;
            const failedIndex = index;
            set({
              status: 'error',
              error: message,
              requestId: null,
              resumeRun: () => {
                set({ status: 'streaming', error: null, requestId: null });
                runChunks(failedIndex);
              },
            });
            args.onFailure?.({ kind: failureKind, message });
            return;
          }
          done += 1;
          set((state) => ({
            segments: [...state.segments, { index: paragraphIndex, source, text: segmentText }],
            progress: { done, total },
          }));
        }
        if (!chainActive()) return;
        set({ status: 'done', resumeRun: null });
      })();
    };
    runChunks(0);
  },
  resume: () => {
    const run = get().resumeRun;
    if (run === null) return;
    set({ status: 'streaming', error: null, requestId: null, resumeRun: null });
    run();
  },
  cancel: () => {
    if (get().status !== 'streaming') return;
    const requestId = get().requestId;
    set({ status: 'cancelled', requestId: null, resumeRun: null });
    // AI 逐段链在段间时 requestId 为 null：仅落 cancelled，串行链靠状态守卫停止。
    if (requestId !== null && !get().online) {
      void aiApi.cancel(requestId).catch(() => undefined);
    }
  },
  close: () => set({ ...INITIAL, targetLang: get().targetLang }),
}));
