/**
 * 单次请求的字符预算（纯函数，零 React / 零 IPC）。
 *
 * 预算按 provider 类型给保守默认值；本地模型还要受 prefill 内存约束，
 * 因此显著低于公网。用户可在分块节点上覆盖，运行时统一 clamp。
 */
import { isLocalProvider, type AiProvider } from './ai-endpoint.ts';

export const LOCAL_CHAR_BUDGET = 8_000;
export const PUBLIC_CHAR_BUDGET = 60_000;

export const MIN_CHUNK_CHARS = 500;
export const MAX_CHUNK_CHARS = 100_000;

export function charBudgetFor(provider: AiProvider): number {
  return isLocalProvider(provider) ? LOCAL_CHAR_BUDGET : PUBLIC_CHAR_BUDGET;
}

/** 把节点上的 chunkChars 收进合法区间；非有限数回退到预算值。 */
export function clampChunkChars(value: number | undefined, provider: AiProvider): number {
  if (value === undefined || !Number.isFinite(value)) return charBudgetFor(provider);
  const rounded = Math.floor(value);
  if (rounded < MIN_CHUNK_CHARS) return MIN_CHUNK_CHARS;
  if (rounded > MAX_CHUNK_CHARS) return MAX_CHUNK_CHARS;
  return rounded;
}

/** 块数预估（用于节点上的调用次数提示）。 */
export function estimateChunkCount(text: string, chunkChars: number): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / Math.max(1, chunkChars)));
}