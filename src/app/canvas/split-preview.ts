/**
 * split 卡片块数预览的共享纯逻辑。
 *
 * 预览与 runner 必须使用同一套「拼接全文 → clamp 预算 → 确定性切分」口径：
 * 预览的块数就是执行时 `chunks.length`，不做近似估算。
 * 零 React / 零 IPC。
 */
import { splitTextByBudget, type TextChunk } from '../../core/chunk-text.ts';
import type { AiProvider } from '../../features/ai/ai-endpoint.ts';
import { clampChunkChars } from '../../features/ai/model-budget.ts';
import {
  collectSplitConfig,
  SPLIT_MAX_TOTAL_CHARS,
  type SplitSourceDoc,
} from './split-node-execution.ts';

type RawRecord = Readonly<Record<string, unknown>>;

/** 预览三态；`null` 表示尚无结果（卡片隐藏预览行）。 */
export type SplitPreview =
  | { readonly kind: 'count'; readonly count: number }
  | { readonly kind: 'pending' }
  | { readonly kind: 'too-long' };

/** 合并多篇文档为一次切分的全文；格式必须与 runner 完全一致。 */
export function buildSplitFullText(
  docs: readonly SplitSourceDoc[],
  contents: readonly (string | null)[],
): string {
  return docs
    .map((doc, index) => `【文章 ${index + 1}：${doc.label}】 ${contents[index] ?? ''}`)
    .join('\n\n');
}

/** 与 runner 共用的切分入口：节点配置 + provider 预算 → 文本块区间。 */
export function computeSplitChunks(
  fullText: string,
  chunkChars: number | undefined,
  provider: AiProvider,
): readonly TextChunk[] {
  return splitTextByBudget(fullText, clampChunkChars(chunkChars, provider));
}

/** 新切分块数（`chunks.length` 口径），供卡片预览使用。 */
export function computeSplitChunkCount(
  fullText: string,
  chunkChars: number | undefined,
  provider: AiProvider,
): number {
  return computeSplitChunks(fullText, chunkChars, provider).length;
}

/** 卡片文案；不允许出现「约 N 块」等近似表达。 */
export function splitPreviewLabel(preview: SplitPreview | null | undefined): string {
  if (preview === null || preview === undefined) return '';
  if (preview.kind === 'count') return `预计 ${preview.count} 块`;
  if (preview.kind === 'too-long') return '素材过长';
  return '块数待计算';
}

export const SPLIT_PREVIEW_DEBOUNCE_MS = 300;

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** split 节点 id（按文档顺序）。 */
export function splitNodeIds(nodes: readonly unknown[]): readonly string[] {
  const ids: string[] = [];
  for (const raw of nodes) {
    if (!isRecord(raw) || raw.type !== 'split') continue;
    const id = raw.id;
    if (typeof id === 'string' && id !== '') ids.push(id);
  }
  return ids;
}

/**
 * 只覆盖「块数相关」的结构：provider、split 的 chunkChars、上游文档的
 * nodeId/docPath/label 与连线顺序。节点坐标、尺寸、mode、prompt 不参与。
 * 正文变化不在签名内，由文档变更强制重算。
 */
export function splitPreviewSignature(
  nodes: readonly unknown[],
  edges: readonly unknown[],
  provider: AiProvider,
): string {
  const parts: string[] = [`provider:${provider}`];
  for (const id of splitNodeIds(nodes)) {
    const config = collectSplitConfig(nodes, edges, id);
    const docs = config.docs
      .map((doc) => `${doc.nodeId}\u0000${doc.docPath}\u0000${doc.label}`)
      .join('\u0001');
    parts.push(`${id}\u0000${config.chunkChars ?? 'auto'}\u0000${docs}`);
  }
  return parts.join('\u0002');
}

/** 超限阈值复用执行层常量，禁止另起阈值。 */
export function splitPreviewTooLong(fullText: string): boolean {
  return fullText.length > SPLIT_MAX_TOTAL_CHARS;
}