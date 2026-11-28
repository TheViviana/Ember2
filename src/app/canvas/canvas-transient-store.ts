/**
 * 画布瞬态状态：块数预览、运行进度、失败块标记。
 *
 * 只服务渲染投影，不写文档、不入历史；engine 只做转调与重绘调度。
 * 失败块在文档同步时按现存 nodeId 裁剪，避免手动删除后残留。
 */
import type { SplitPreview } from './split-preview.ts';

/** 分块运行态进度：只做 k/N 文本，不引入进度条。 */
export interface StepProgressView {
  readonly done: number;
  readonly total: number;
}

export interface StepProgressUpdate extends StepProgressView {
  readonly nodeId: string;
}

export interface CanvasTransientStore {
  /** 返回需要重绘的节点 id（新增/移除都算）。 */
  setSplitPreviews(previews: ReadonlyMap<string, SplitPreview>): readonly string[];
  readSplitPreview(id: string): SplitPreview | null;
  /** 返回旧/新进度对应的节点 id。 */
  setStepProgress(progress: StepProgressUpdate | null): readonly string[];
  readStepProgress(id: string): StepProgressView | null;
  /** 返回标记是否变化。 */
  setStepFailed(id: string, failed: boolean): boolean;
  readStepFailed(id: string): boolean;
  /** 按现存节点 id 裁掉已删除块的失败标记。 */
  pruneFailedBlocks(existingIds: ReadonlySet<string>): void;
  clear(): void;
}

export function createCanvasTransientStore(): CanvasTransientStore {
  let splitPreviews: ReadonlyMap<string, SplitPreview> = new Map();
  let stepProgress: StepProgressUpdate | null = null;
  const failedBlocks = new Set<string>();

  return {
    setSplitPreviews(previews: ReadonlyMap<string, SplitPreview>): readonly string[] {
      const changed: string[] = [];
      for (const id of previews.keys()) changed.push(id);
      for (const id of splitPreviews.keys()) {
        if (!previews.has(id)) changed.push(id);
      }
      splitPreviews = previews;
      return changed;
    },

    readSplitPreview(id: string): SplitPreview | null {
      return splitPreviews.get(id) ?? null;
    },

    setStepProgress(progress: StepProgressUpdate | null): readonly string[] {
      const changed: string[] = [];
      if (stepProgress !== null) changed.push(stepProgress.nodeId);
      if (progress !== null && !changed.includes(progress.nodeId)) changed.push(progress.nodeId);
      stepProgress = progress;
      return changed;
    },

    readStepProgress(id: string): StepProgressView | null {
      if (stepProgress === null || stepProgress.nodeId !== id) return null;
      return { done: stepProgress.done, total: stepProgress.total };
    },

    setStepFailed(id: string, failed: boolean): boolean {
      const changed = failed ? !failedBlocks.has(id) : failedBlocks.delete(id);
      if (changed && failed) failedBlocks.add(id);
      return changed;
    },

    readStepFailed(id: string): boolean {
      return failedBlocks.has(id);
    },

    pruneFailedBlocks(existingIds: ReadonlySet<string>): void {
      for (const id of failedBlocks) {
        if (!existingIds.has(id)) failedBlocks.delete(id);
      }
    },

    clear(): void {
      splitPreviews = new Map();
      stepProgress = null;
      failedBlocks.clear();
    },
  };
}