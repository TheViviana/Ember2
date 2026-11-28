/**
 * split 重跑确认的结构化信号（纯契约，零 React / 零 IPC）。
 *
 * runner 在 guard 命中时通过 notice 的第三个参数发出该信号；UI 只按 code
 * 匹配并消费 edited/downstream，不解析文案，也不重新计算边关系。
 */

export const SPLIT_RERUN_CONFIRM_CODE = 'split-rerun-confirm' as const;

export interface SplitRerunConfirmSignal {
  readonly code: typeof SPLIT_RERUN_CONFIRM_CODE;
  /** runner 的 blocksEdited 判定。 */
  readonly edited: boolean;
  /** runner 的 hasDownstreamEdge 判定。 */
  readonly downstream: boolean;
  /** 当前连在 split 下的旧子块数量；不是本次切分将生成的新块数。 */
  readonly existingBlockCount: number;
}