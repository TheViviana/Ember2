/**
 * 分块重跑确认：消费 runner 的结构化信号，生成 UI 确认状态与文案。
 *
 * runner 仍是重跑 guard 的唯一判定方：guard 命中时携带
 * `{ code: 'split-rerun-confirm', edited, downstream, existingBlockCount }`。
 * UI 只按 code 匹配，不解析文案，也不重新计算整批重跑的边关系。
 * 单块重试没有 runner guard，因此下游检测由 UI 在点击时做一次。
 */

import {
  SPLIT_RERUN_CONFIRM_CODE,
  type SplitRerunConfirmSignal,
} from '../../core/canvas/split-rerun-contract.ts';

export interface SplitRerunConflict {
  /** runner 判定为「块被编辑」。 */
  readonly edited: boolean;
  /** 任一子块存在出边（下游连线）。 */
  readonly downstream: boolean;
}

export const RETRY_DOWNSTREAM_MESSAGE = '该块有下游连线，重试会改写其内容';

export interface RetryBlockConfirm {
  readonly nodeId: string;
  readonly message: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function endpointNodeId(endpoint: unknown): string | null {
  if (!isRecord(endpoint) || typeof endpoint.nodeId !== 'string') return null;
  return endpoint.nodeId;
}

/** 单块是否有下游出边；命中则返回 UI 确认状态。 */
export function retryConfirmForBlock(
  edges: readonly unknown[],
  blockId: string,
): RetryBlockConfirm | null {
  const downstream = edges.some((edge) => {
    if (!isRecord(edge)) return false;
    const from = endpointNodeId(edge.from);
    const to = endpointNodeId(edge.to);
    return from === blockId && to !== null && to !== blockId;
  });
  return downstream ? { nodeId: blockId, message: RETRY_DOWNSTREAM_MESSAGE } : null;
}

/** 只认结构化 code；其它通知返回 null，继续按普通 toast 处理。 */
export function splitRerunConflictFromSignal(
  signal: SplitRerunConfirmSignal | undefined,
): SplitRerunConflict | null {
  if (signal === undefined || signal.code !== SPLIT_RERUN_CONFIRM_CODE) return null;
  return { edited: signal.edited, downstream: signal.downstream };
}

/** 双命中时两件事都要说清楚；不写块数（M4 未落地）。 */
export function buildSplitRerunConfirmMessage(conflict: SplitRerunConflict): string {
  const reasons: string[] = [];
  if (conflict.edited) reasons.push('块内容与重新切分结果不同，重跑将覆盖');
  if (conflict.downstream) reasons.push('下游连线会断开');
  const detail = reasons.length === 0 ? '现有块将被覆盖' : reasons.join('，');
  return `${detail}。确定继续覆盖吗？`;
}