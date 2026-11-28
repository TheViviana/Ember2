/**
 * split 卡片块数预览的只读异步投影。
 *
 * 预览在运行前独立计算，不复用 runner 运行时 chunks；读取正文与切分口径
 * 全部复用 `split-preview.ts`，保证与执行一致。结果只发布到 engine 的
 * 瞬态存储，不写节点、不入历史、不新增 schema 字段。
 */
import type { AiProvider } from '../../features/ai/ai-endpoint.ts';
import {
  buildSplitFullText,
  computeSplitChunkCount,
  SPLIT_PREVIEW_DEBOUNCE_MS,
  splitNodeIds,
  splitPreviewSignature,
  splitPreviewTooLong,
  type SplitPreview,
} from './split-preview.ts';
import { collectSplitConfig } from './split-node-execution.ts';

export interface SplitPreviewDeps {
  readonly getDocument: () => {
    readonly nodes: readonly unknown[];
    readonly edges: readonly unknown[];
  };
  readonly readLiveText: (path: string) => string | null;
  readonly readSnapshot: (path: string) => Promise<string>;
  readonly getProvider: () => AiProvider;
  readonly publish: (previews: ReadonlyMap<string, SplitPreview>) => void;
  readonly debounceMs?: number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface SplitPreviewProjection {
  refresh(options?: { readonly force?: boolean }): Promise<void>;
  dispose(): void;
}

type RawConfig = ReturnType<typeof collectSplitConfig>;

/** 单次预览：读取失败与空素材分别落到 pending / 精确块数。 */
async function previewFor(
  config: RawConfig,
  provider: AiProvider,
  deps: SplitPreviewDeps,
): Promise<SplitPreview> {
  if (config.docs.length === 0) return { kind: 'pending' };
  const contents: (string | null)[] = [];
  for (const doc of config.docs) {
    const live = deps.readLiveText(doc.docPath);
    if (live !== null) {
      contents.push(live);
      continue;
    }
    try {
      contents.push(await deps.readSnapshot(doc.docPath));
    } catch {
      return { kind: 'pending' };
    }
  }
  const fullText = buildSplitFullText(config.docs, contents);
  if (splitPreviewTooLong(fullText)) return { kind: 'too-long' };
  return {
    kind: 'count',
    count: computeSplitChunkCount(fullText, config.chunkChars, provider),
  };
}

export function createSplitPreviewProjection(
  deps: SplitPreviewDeps,
): SplitPreviewProjection {
  const debounceMs = deps.debounceMs ?? SPLIT_PREVIEW_DEBOUNCE_MS;
  const setTimer =
    deps.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer =
    deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let timer: unknown = null;
  let forceRequested = false;
  let generation = 0;
  let lastSignature: string | null = null;
  let disposed = false;
  let runInFlight = false;
  let waiters: (() => void)[] = [];
  let pendingPromise: Promise<void> | null = null;

  const finishCycle = (): void => {
    const resolve = waiters;
    waiters = [];
    pendingPromise = null;
    for (const resolveOne of resolve) resolveOne();
  };

  const run = async (): Promise<void> => {
    runInFlight = true;
    const myGeneration = ++generation;
    const force = forceRequested;
    forceRequested = false;
    try {
      const provider = deps.getProvider();
      const document = deps.getDocument();
      const signature = splitPreviewSignature(document.nodes, document.edges, provider);
      if (!force && signature === lastSignature) return;

      const previews = new Map<string, SplitPreview>();
      for (const splitId of splitNodeIds(document.nodes)) {
        const config = collectSplitConfig(document.nodes, document.edges, splitId);
        previews.set(splitId, await previewFor(config, provider, deps));
        if (disposed || myGeneration !== generation) return;
      }
      if (disposed || myGeneration !== generation) return;
      lastSignature = signature;
      deps.publish(previews);
    } finally {
      runInFlight = false;
      if (!disposed && myGeneration === generation) finishCycle();
    }
  };

  const schedule = (): Promise<void> => {
    if (pendingPromise === null) {
      pendingPromise = new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    }
    if (debounceMs <= 0) {
      if (runInFlight) {
        void Promise.resolve().then(() => {
          if (!disposed) void run();
        });
      } else {
        void run();
      }
      return pendingPromise;
    }
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      void run();
    }, debounceMs);
    return pendingPromise;
  };

  return {
    refresh(options = {}): Promise<void> {
      if (disposed) return Promise.resolve();
      if (options.force === true) forceRequested = true;
      return schedule();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      generation += 1;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      finishCycle();
    },
  };
}