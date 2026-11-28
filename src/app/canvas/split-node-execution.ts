/**
 * 分块 / 汇总节点的前置纯逻辑：邻居收集、消息构造、子块布局。
 * 零 DOM / 零 IPC / 零 React，便于 node 下用 fake 覆盖。
 */
import type { CanvasSplitMode } from '#canvas-format';

type RawRecord = Readonly<Record<string, unknown>>;

export interface SplitSourceDoc {
  readonly nodeId: string;
  readonly docPath: string;
  readonly label: string;
}

export interface SplitConfig {
  readonly docs: readonly SplitSourceDoc[];
  readonly mode: CanvasSplitMode;
  readonly chunkChars: number | undefined;
  readonly prompt: string;
  readonly model: string | null;
}

export interface MergeInput {
  readonly nodeId: string;
  readonly label: string;
  readonly text: string;
}

export interface MergeConfig {
  readonly inputs: readonly MergeInput[];
  /** 首个 merge → 文本节点（输出口）。 */
  readonly outputNodeId: string | null;
  /** 首个 merge → 文档节点（空文档输出口）。 */
  readonly outputDoc: SplitSourceDoc | null;
  readonly prompt: string;
  readonly model: string | null;
}

export const DEFAULT_REFINE_INSTRUCTION =
  '提炼下面这段文字的核心信息，保留事实、结论与关键细节；不要复述原文。';
export const DEFAULT_MERGE_INSTRUCTION =
  '把下面各段内容合并成一份连贯的结果：去重、合并同类项，保留关键事实与结论。';

/** 卡片上「块大小」标签的循环预设；undefined 表示按 provider 预算自动。 */
export const CHUNK_CHAR_PRESETS = [2000, 4000, 8000, 16000] as const;

/** 依次循环：自动 → 2000 → 4000 → 8000 → 16000 → 自动。 */
export function nextChunkChars(current: number | undefined): number | undefined {
  if (current === undefined) return CHUNK_CHAR_PRESETS[0];
  const index = CHUNK_CHAR_PRESETS.indexOf(current as (typeof CHUNK_CHAR_PRESETS)[number]);
  if (index < 0 || index === CHUNK_CHAR_PRESETS.length - 1) return undefined;
  return CHUNK_CHAR_PRESETS[index + 1];
}

/** 分块素材总量上限，防止一次读入过多文本。 */
export const SPLIT_MAX_TOTAL_CHARS = 2_000_000;

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function endpointNodeId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const nodeId = value.nodeId;
  return typeof nodeId === 'string' && nodeId !== '' ? nodeId : null;
}

function nodesById(nodes: readonly unknown[]): Map<string, RawRecord> {
  const map = new Map<string, RawRecord>();
  for (const raw of nodes) {
    if (!isRecord(raw)) continue;
    const id = raw.id;
    if (typeof id === 'string' && id !== '') map.set(id, raw);
  }
  return map;
}

function docOf(node: RawRecord | undefined): SplitSourceDoc | null {
  if (node === undefined || node.type !== 'document') return null;
  const docPath = node.docPath;
  if (typeof docPath !== 'string' || docPath === '') return null;
  return {
    nodeId: typeof node.id === 'string' ? node.id : '',
    docPath,
    label: typeof node.label === 'string' && node.label !== '' ? node.label : docPath,
  };
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** 文档 → split 为素材；按连线顺序去重。 */
export function collectSplitConfig(
  nodes: readonly unknown[],
  edges: readonly unknown[],
  splitNodeId: string,
): SplitConfig {
  const byId = nodesById(nodes);
  const split = byId.get(splitNodeId);
  const docs: SplitSourceDoc[] = [];
  const seen = new Set<string>();

  for (const edge of edges) {
    if (!isRecord(edge)) continue;
    const from = endpointNodeId(edge.from);
    const to = endpointNodeId(edge.to);
    if (to !== splitNodeId || from === null || from === splitNodeId) continue;
    const doc = docOf(byId.get(from));
    if (doc === null || seen.has(doc.nodeId)) continue;
    seen.add(doc.nodeId);
    docs.push(doc);
  }

  const mode = split?.mode === 'refine' ? 'refine' : 'split';
  const chunkChars = typeof split?.chunkChars === 'number' ? split.chunkChars : undefined;
  return {
    docs,
    mode,
    chunkChars,
    prompt: typeof split?.text === 'string' ? split.text : '',
    model: nonEmpty(split?.model),
  };
}

/** 汇总上游段数：唯一真源，投影卡片与 runner 共用。 */
export function countMergeInputs(
  nodes: readonly unknown[],
  edges: readonly unknown[],
  mergeNodeId: string,
): number {
  return collectMergeConfig(nodes, edges, mergeNodeId).inputs.length;
}

/** text → merge 为输入（按连线顺序），merge → text/document 为输出。 */
export function collectMergeConfig(
  nodes: readonly unknown[],
  edges: readonly unknown[],
  mergeNodeId: string,
): MergeConfig {
  const byId = nodesById(nodes);
  const merge = byId.get(mergeNodeId);
  const inputs: MergeInput[] = [];
  const seenInputs = new Set<string>();
  let outputNodeId: string | null = null;
  let outputDoc: SplitSourceDoc | null = null;

  for (const edge of edges) {
    if (!isRecord(edge)) continue;
    const from = endpointNodeId(edge.from);
    const to = endpointNodeId(edge.to);
    if (from === mergeNodeId && to !== null && to !== mergeNodeId) {
      const node = byId.get(to);
      if (node?.type === 'text' && outputNodeId === null) outputNodeId = to;
      if (node?.type === 'document' && outputDoc === null) outputDoc = docOf(node);
      continue;
    }
    if (to === mergeNodeId && from !== null && from !== mergeNodeId) {
      const node = byId.get(from);
      if (node?.type !== 'text') continue;
      if (seenInputs.has(from)) continue;
      seenInputs.add(from);
      inputs.push({
        nodeId: from,
        label: typeof node.label === 'string' ? node.label : '',
        text: typeof node.label === 'string' ? node.label : '',
      });
    }
  }

  return {
    inputs,
    outputNodeId,
    outputDoc,
    prompt: typeof merge?.text === 'string' ? merge.text : '',
    model: nonEmpty(merge?.model),
  };
}

/** 汇总输出形态：与 runner「输出目标不唯一」拒绝条件保持同一口径。 */
export type MergeOutputKind = 'none' | 'text' | 'document' | 'ambiguous';

/**
 * 汇总输出形态判定。存在文本 + document 双输出时为 `ambiguous`，
 * runner 会拒绝执行；投影卡片据此避免误报 document 例外。
 */
export function mergeOutputKind(
  nodes: readonly unknown[],
  edges: readonly unknown[],
  mergeNodeId: string,
): MergeOutputKind {
  const { outputNodeId, outputDoc } = collectMergeConfig(nodes, edges, mergeNodeId);
  if (outputNodeId !== null && outputDoc !== null) return 'ambiguous';
  if (outputDoc !== null) return 'document';
  if (outputNodeId !== null) return 'text';
  return 'none';
}

/** 汇总输入的总字符数（含分节头）。 */
export function mergeInputChars(inputs: readonly MergeInput[]): number {
  return inputs.reduce((sum, input) => sum + input.text.length + 12, 0);
}

export function buildRefineSystem(prompt: string): string {
  const trimmed = prompt.trim();
  return trimmed === '' ? DEFAULT_REFINE_INSTRUCTION : trimmed;
}

export function buildMergeSystem(prompt: string): string {
  const trimmed = prompt.trim();
  return trimmed === '' ? DEFAULT_MERGE_INSTRUCTION : trimmed;
}

/** 汇总消息：每个上游文本节点一节。 */
export function buildMergeUser(inputs: readonly MergeInput[]): string {
  return inputs
    .map((input, index) => `【块 ${index + 1}】\n\n${input.text}`)
    .join('\n\n');
}

export interface NodeRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface ChunkPosition {
  readonly x: number;
  readonly y: number;
}

export const CHUNK_NODE_WIDTH = 160;
export const CHUNK_NODE_HEIGHT = 96;
const CHUNK_GAP_X = 80;
const CHUNK_GAP_Y = 24;
/** 单列最多 8 块；超出后向右换列，避免竖排无限下坠。 */
const CHUNK_COLUMN_MAX_ROWS = 8;
/** 网格上限：8 × 20 个槽位，超过后退化为顺序下排（仅极端块数）。 */
const CHUNK_COLUMN_LIMIT = 20;

function intersects(a: NodeRect, b: NodeRect): boolean {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

/**
 * 子块网格排布：从 split 右侧开始向下排，一列最多 8 块；
 * 超出列边界或槽位被占用时向右换列，换列后仍避开已有节点。
 * 按列优先扫描，保证块之间、块与现有节点之间不重叠。
 */
export function layoutChunkNodes(
  origin: NodeRect,
  count: number,
  occupied: readonly NodeRect[],
): readonly ChunkPosition[] {
  const placed: NodeRect[] = [];
  const positions: ChunkPosition[] = [];
  const startX = origin.x + origin.w + CHUNK_GAP_X;
  const blocked = (rect: NodeRect): boolean =>
    occupied.some((item) => intersects(rect, item)) ||
    placed.some((item) => intersects(rect, item));

  let slot = 0;
  for (let index = 0; index < count; index += 1) {
    let chosen: NodeRect | null = null;
    while (slot < CHUNK_COLUMN_MAX_ROWS * CHUNK_COLUMN_LIMIT) {
      const column = Math.floor(slot / CHUNK_COLUMN_MAX_ROWS);
      const row = slot % CHUNK_COLUMN_MAX_ROWS;
      const candidate: NodeRect = {
        x: startX + column * (CHUNK_NODE_WIDTH + CHUNK_GAP_X),
        y: origin.y + row * (CHUNK_NODE_HEIGHT + CHUNK_GAP_Y),
        w: CHUNK_NODE_WIDTH,
        h: CHUNK_NODE_HEIGHT,
      };
      slot += 1;
      if (!blocked(candidate)) {
        chosen = candidate;
        break;
      }
    }
    if (chosen === null) {
      const last = placed[placed.length - 1];
      chosen = {
        x: last?.x ?? startX,
        y: (last?.y ?? origin.y) + CHUNK_NODE_HEIGHT + CHUNK_GAP_Y,
        w: CHUNK_NODE_WIDTH,
        h: CHUNK_NODE_HEIGHT,
      };
    }
    placed.push(chosen);
    positions.push({ x: chosen.x, y: chosen.y });
  }

  return positions;
}