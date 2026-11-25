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
import { planAiSegments } from '../../features/translate/translate-segments.ts';
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
  readonly online: boolean;
  /** 分段进度（CR-20261120-40）：两种模式都有值；`done`/`total` 只增不减。 */
  readonly progress: { done: number; total: number } | null;
  readonly setTargetLang: (lang: string) => void;
  readonly start: (args: TranslateStartArgs) => void;
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
  online: false,
  progress: null as { done: number; total: number } | null,
};

export const useTranslateStore = create<TranslateStore>()((set, get) => ({
  ...INITIAL,
  setTargetLang: (lang) => set({ targetLang: lang }),
  start: (args) => {
    const config = useAiChatStore.getState().config;
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
        online: false,
        progress: null,
      });
      args.onFailure?.({ kind: planned.ok ? 'empty' : 'error', message: reason });
      return;
    }
    const chainToken = createChatRequestId();
    const total = planned.segments.length;
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
      online: false,
      progress: { done: 0, total },
    });
    const chainActive = (): boolean =>
      get().chainToken === chainToken && get().status === 'streaming';
    void (async () => {
      let done = 0;
      for (const [index, source] of planned.segments.entries()) {
        if (!chainActive()) return;
        const built = buildTranslateRequest({ config, text: source, targetLang });
        if (!built.ok) {
          set({ status: 'error', error: built.reason });
          args.onFailure?.({ kind: 'unconfigured', message: built.reason });
          return;
        }
        set({ requestId: built.request.requestId });
        let segmentText = '';
        let segmentError: string | null = null;
        await new Promise<void>((resolveSegment) => {
          startChatSession(
            {
              requestId: built.request.requestId,
              config,
              messages: built.request.messages.map((message, id) => ({
                id: `translate-${id}`,
                role: 'user' as const,
                content: message.content,
                completed: true,
              })),
            },
            {
              onDelta: (text) => {
                if (get().requestId === built.request.requestId) segmentText = text;
              },
              onDone: resolveSegment,
              onError: (failure) => {
                segmentError = failure.kind === 'build' ? failure.reason : failure.message;
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
        if (segmentError !== null) {
          set({ status: 'error', error: segmentError });
          args.onFailure?.({ kind: 'error', message: segmentError });
          return;
        }
        done += 1;
        set((state) => ({
          segments: [...state.segments, { index, source, text: segmentText }],
          progress: { done, total },
        }));
      }
      if (!chainActive()) return;
      set({ status: 'done' });
    })();
  },
  cancel: () => {
    if (get().status !== 'streaming') return;
    const requestId = get().requestId;
    set({ status: 'cancelled', requestId: null });
    // AI 逐段链在段间时 requestId 为 null：仅落 cancelled，串行链靠状态守卫停止。
    if (requestId !== null && !get().online) {
      void aiApi.cancel(requestId).catch(() => undefined);
    }
  },
  close: () => set({ ...INITIAL, targetLang: get().targetLang }),
}));
