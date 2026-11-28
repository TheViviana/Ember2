/**
 * split 块数预览的 app 层装配：只负责把 engine 文档变更、文档正文变化
 * 与 AI 配置变化接到纯投影控制器上，不做任何计算。
 */
import { useAiChatStore } from '../../features/ai/ai-chat-store.ts';
import { useEmberStore } from '../stores/ember-store.ts';
import type { CanvasEngine } from './engine.ts';
import { createSplitPreviewProjection } from './use-split-previews.ts';

export interface SplitPreviewSource {
  readonly readLiveText: (path: string) => string | null;
  readonly readSnapshot: (path: string) => Promise<string>;
}

/** 返回清理函数，挂到画布会话的 unsubscribe。 */
export function startSplitPreviewProjection(
  engine: CanvasEngine,
  source: SplitPreviewSource,
): () => void {
  const projection = createSplitPreviewProjection({
    getDocument: () => engine.getDocument(),
    readLiveText: source.readLiveText,
    readSnapshot: source.readSnapshot,
    getProvider: () => useAiChatStore.getState().config.provider,
    publish: (previews) => engine.setSplitPreviews(previews),
  });
  const offDocument = engine.subscribeDocumentChanges(() => {
    void projection.refresh();
  });
  const offDocs = useEmberStore.subscribe((state, previous) => {
    if (state.docs === previous.docs) return;
    void projection.refresh({ force: true });
  });
  const offAi = useAiChatStore.subscribe((state, previous) => {
    if (
      state.config.provider === previous.config.provider &&
      state.config.model === previous.config.model
    ) {
      return;
    }
    void projection.refresh({ force: true });
  });
  void projection.refresh({ force: true });
  return () => {
    offDocument();
    offDocs();
    offAi();
    projection.dispose();
  };
}