/**
 * B1：split 重跑前的失败块清理计划。
 *
 * 入口只收集旧子块 id，不立即清标记；start 结束后按 committed 决定：
 * true → 清理这批旧子块；false（失败/取消/未提交）→ 丢弃计划并保留标记。
 * 手动删除块导致的 stale id 不在这里 GC，见 canvas-split-preview backlog。
 */
export interface SplitFailureCleanup {
  /** 按 sourceNodeId 收集当前 split 的子块 id，覆盖上一轮计划。 */
  collect(nodes: readonly unknown[], splitNodeId: string): void;
  /** start 结束后结算：只有 committed 才清标记，否则仅丢弃计划。 */
  finish(committed: boolean, setFailed: (id: string, failed: boolean) => void): void;
  /** 取消确认：丢弃计划，不触碰失败标记。 */
  discard(): void;
}

/** 单块重试结算：只有写回提交成功才清该块标记；失败/取消保留，可再次重试。 */
export function finishRetryBlock(
  committed: boolean,
  blockId: string,
  setFailed: (id: string, failed: boolean) => void,
): void {
  if (committed) setFailed(blockId, false);
}

export function createSplitFailureCleanup(): SplitFailureCleanup {
  let pending: readonly string[] = [];

  return {
    collect(nodes: readonly unknown[], splitNodeId: string): void {
      const ids: string[] = [];
      for (const node of nodes) {
        const block = node as { readonly id?: unknown; readonly sourceNodeId?: unknown };
        if (block.sourceNodeId === splitNodeId && typeof block.id === 'string') {
          ids.push(block.id);
        }
      }
      pending = ids;
    },

    finish(committed: boolean, setFailed: (id: string, failed: boolean) => void): void {
      if (committed) {
        for (const id of pending) setFailed(id, false);
      }
      pending = [];
    },

    discard(): void {
      pending = [];
    },
  };
}