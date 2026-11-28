/**
 * 分块节点执行编排（依赖注入，零 React / 零 IPC）。
 *
 * 编排链：收集文档素材 → 读取 → 确定性切分 → 批量落 N 个文本节点
 * →（refine 模式）逐块流式提炼 → 一次性批量写回。
 * 切分与提炼写回各占一条历史；提炼期间只更新进度，不改文档。
 */
import type { CanvasCommand } from '#canvas-format';
import {
  SPLIT_RERUN_CONFIRM_CODE,
  type SplitRerunConfirmSignal,
} from '../../core/canvas/split-rerun-contract.ts';
import { formatUnknownError } from '../../core/errors.ts';
import type { AiChatConfig } from '../../features/ai/ai-chat-store.ts';
import { startChatSession, type ChatSession } from '../../features/ai/chat-session.ts';
import type { AiChatRequest } from '../../types/ipc.ts';
import { buildSplitFullText, computeSplitChunks } from './split-preview.ts';
import {
  buildRefineSystem,
  collectSplitConfig,
  layoutChunkNodes,
  SPLIT_MAX_TOTAL_CHARS,
  type NodeRect,
} from './split-node-execution.ts';

export interface SplitRunSnapshot {
  readonly text: string;
  readonly sha256: string;
}

export interface SplitStreamHandlers {
  readonly onDelta: (text: string) => void;
  readonly onDone: () => void;
  readonly onError: (code: string, message: string) => void;
}

export interface SplitProgress {
  readonly phase: 'split' | 'refine';
  readonly done: number;
  readonly total: number;
}

export interface SplitRunOptions {
  /** 已有子块时，必须显式确认覆盖。 */
  readonly replace?: boolean;
}

export interface SplitRunDeps {
  readonly getDocument: () => {
    readonly nodes: readonly unknown[];
    readonly edges: readonly unknown[];
  };
  readonly liveText: (path: string) => string | null;
  readonly readSnapshot: (path: string) => Promise<SplitRunSnapshot>;
  readonly aiConfig: AiChatConfig;
  readonly stream: (request: AiChatRequest, handlers: SplitStreamHandlers) => Promise<void>;
  readonly cancel: (requestId: string) => void;
  readonly notice: (
    message: string,
    tone: 'info' | 'warning' | 'error',
    signal?: SplitRerunConfirmSignal,
  ) => void;
  readonly executeCommands: (commands: readonly CanvasCommand[]) => boolean;
  readonly createNodeId: () => string;
  readonly createEdgeId: () => string;
  /** 当前画布上除 excludeNodeIds 外的节点矩形，用于子块避让布局。 */
  readonly occupiedRects: (excludeNodeIds: readonly string[]) => readonly NodeRect[];
  readonly progress: (progress: SplitProgress) => void;
  readonly flash: (nodeId: string, kind: 'ok' | 'error') => void;
}

export interface SplitRunner {
  readonly start: (nodeId: string, options?: SplitRunOptions) => Promise<void>;
  /** 单块重试：只重新提炼该块当前内容，成功写回一条历史。 */
  readonly retryBlock: (blockId: string) => Promise<void>;
  readonly cancel: () => void;
}

interface RefineOutcome {
  readonly ok: boolean;
  readonly text: string;
  readonly cancelled: boolean;
  readonly fatal: boolean;
  readonly message?: string;
}

type RawRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findNode(nodes: readonly unknown[], id: string): RawRecord | null {
  for (const raw of nodes) {
    if (isRecord(raw) && raw.id === id) return raw;
  }
  return null;
}

function rectOf(node: RawRecord | null): NodeRect {
  const number = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return {
    x: number(node?.x, 0),
    y: number(node?.y, 0),
    w: number(node?.w, 176),
    h: number(node?.h, 96),
  };
}

/**
 * 旧子块识别：split 只处理「自己生成或挂在自身出边上的 text 块」。
 * 先按 sourceNodeId 命中（覆盖边已删的孤儿），再并入 split → text 出边命中，
 * 按 id 去重并保持稳定顺序（sourceNodeId 命中在前）；用户手连的非 text 节点不处理。
 */
function childTextIds(
  nodes: readonly unknown[],
  edges: readonly unknown[],
  splitNodeId: string,
): readonly string[] {
  const byId = new Map<string, RawRecord>();
  for (const raw of nodes) {
    if (isRecord(raw) && typeof raw.id === 'string') byId.set(raw.id, raw);
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of nodes) {
    if (!isRecord(raw) || raw.type !== 'text' || typeof raw.id !== 'string') continue;
    if (raw.sourceNodeId !== splitNodeId || seen.has(raw.id)) continue;
    seen.add(raw.id);
    ids.push(raw.id);
  }
  for (const edge of edges) {
    if (!isRecord(edge)) continue;
    const from = isRecord(edge.from) && typeof edge.from.nodeId === 'string' ? edge.from.nodeId : null;
    const to = isRecord(edge.to) && typeof edge.to.nodeId === 'string' ? edge.to.nodeId : null;
    if (from !== splitNodeId || to === null || seen.has(to)) continue;
    if (byId.get(to)?.type !== 'text') continue;
    seen.add(to);
    ids.push(to);
  }
  return ids;
}

/** 子块是否有下游连线（block → 任意其他节点）。 */
function hasDownstreamEdge(edges: readonly unknown[], blockIds: readonly string[]): boolean {
  const blocks = new Set(blockIds);
  return edges.some((edge) => {
    if (!isRecord(edge) || !isRecord(edge.from)) return false;
    const from = typeof edge.from.nodeId === 'string' ? edge.from.nodeId : null;
    return from !== null && blocks.has(from);
  });
}

/** 按当前上游重新切分结果逐块比对，文本不一致即视为用户编辑过。 */
function blocksEdited(
  nodes: readonly unknown[],
  existing: readonly string[],
  chunks: readonly { readonly start: number; readonly end: number }[],
  fullText: string,
): boolean {
  return existing.some((id, order) => {
    const node = findNode(nodes, id);
    if (node === null) return true;
    const index = typeof node.chunkIndex === 'number' ? node.chunkIndex : order;
    const chunk = chunks[index];
    if (chunk === undefined) return true;
    const expected = fullText.slice(chunk.start, chunk.end);
    return (typeof node.label === 'string' ? node.label : '') !== expected;
  });
}

export function createSplitNodeRunner(deps: SplitRunDeps): SplitRunner {
  let active: { readonly nodeId: string } | null = null;
  let activeSession: ChatSession | null = null;
  let settleRefine: ((outcome: RefineOutcome) => void) | null = null;
  let cancelRequested = false;

  const refineChunk = (
    text: string,
    system: string,
    config: AiChatConfig,
  ): Promise<RefineOutcome> =>
    new Promise<RefineOutcome>((resolve) => {
      let full = '';
      let settled = false;
      const done = (outcome: RefineOutcome): void => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };
      settleRefine = (outcome) => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };
      const session = startChatSession(
        {
          config,
          messages: [{ id: 'split-chunk', role: 'user', content: text, completed: true }],
          system,
        },
        {
          onDelta: (value) => {
            full = value;
          },
          onDone: () => {
            settleRefine = null;
            activeSession = null;
            done({ ok: true, text: full, cancelled: false, fatal: false });
          },
          onError: (failure) => {
            settleRefine = null;
            activeSession = null;
            if (failure.kind === 'build') {
              done({
                ok: false,
                text: '',
                cancelled: false,
                fatal: true,
                message: '提炼请求构造失败，请检查 AI 设置',
              });
              return;
            }
            done({
              ok: false,
              text: '',
              cancelled: false,
              fatal: false,
              message: failure.text,
            });
          },
        },
        { stream: deps.stream, cancel: (requestId) => deps.cancel(requestId) },
      );
      activeSession = session;
    });

  const start = async (splitNodeId: string, options: SplitRunOptions = {}): Promise<void> => {
    if (active !== null) {
      deps.notice('已有分块或汇总任务在执行，请先取消', 'warning');
      return;
    }
    const raw = deps.getDocument();
    const config = collectSplitConfig(raw.nodes, raw.edges, splitNodeId);
    if (config.docs.length === 0) {
      deps.notice('请先把文章（文档节点）连到分块节点', 'warning');
      return;
    }

    const contents: (string | null)[] = [];
    for (const doc of config.docs) {
      try {
        const live = deps.liveText(doc.docPath);
        const content = live !== null ? live : (await deps.readSnapshot(doc.docPath)).text;
        contents.push(content);
      } catch (error: unknown) {
        deps.notice(
          `读取文章失败：${doc.label}：${formatUnknownError(error, '未知画布错误')}`,
          'error',
        );
        return;
      }
    }

    const fullText = buildSplitFullText(config.docs, contents);
    if (fullText.trim() === '') {
      deps.notice('没有可切分的内容', 'warning');
      return;
    }
    if (fullText.length > SPLIT_MAX_TOTAL_CHARS) {
      deps.notice(`素材过长（上限 ${SPLIT_MAX_TOTAL_CHARS} 字符），请减少文章`, 'warning');
      return;
    }

    const chunks = computeSplitChunks(fullText, config.chunkChars, deps.aiConfig.provider);
    if (chunks.length === 0) {
      deps.notice('没有可切分的内容', 'warning');
      return;
    }

    const existing = childTextIds(raw.nodes, raw.edges, splitNodeId);
    const edited = existing.length > 0 && blocksEdited(raw.nodes, existing, chunks, fullText);
    const downstream = existing.length > 0 && hasDownstreamEdge(raw.edges, existing);
    if (existing.length > 0 && (edited || downstream) && options.replace !== true) {
      // 此 notice 同时是 UI 的确认信号：UI 按 signal.code 匹配并消费
      // edited/downstream，不解析文案。改 code 需同步 split-rerun-confirm；
      // 改文案不影响确认弹窗触发。
      deps.notice(
        `已有 ${existing.length} 个块，${edited ? '其中有块内容与重新切分结果不同：重跑会覆盖这些块' : '块已有下游连线：重跑会断开下游连线'}，请确认`,
        'warning',
        {
          code: SPLIT_RERUN_CONFIRM_CODE,
          edited,
          downstream,
          existingBlockCount: existing.length,
        },
      );
      return;
    }

    const splitRect = rectOf(findNode(raw.nodes, splitNodeId));
    const positions = layoutChunkNodes(
      splitRect,
      chunks.length,
      deps.occupiedRects(existing),
    );
    // 块节点在提交前只存在于内存；refine 期间画布上没有可编辑块。
    const plans = chunks.map((chunk, index) => ({
      nodeId: deps.createNodeId(),
      raw: fullText.slice(chunk.start, chunk.end),
      position: positions[index] ?? { x: splitRect.x, y: splitRect.y },
    }));

    const commitBlocks = (labels: readonly string[]): boolean => {
      const commands: CanvasCommand[] = existing.map((id) => ({ kind: 'removeNode', id }));
      plans.forEach((plan, index) => {
        commands.push({
          kind: 'addNode',
          node: {
            id: plan.nodeId,
            x: plan.position.x,
            y: plan.position.y,
            type: 'text',
            label: labels[index] ?? plan.raw,
            chunkIndex: index,
            sourceNodeId: splitNodeId,
          },
        });
        commands.push({
          kind: 'addEdge',
          edge: {
            id: deps.createEdgeId(),
            from: { nodeId: splitNodeId, portId: 'out' },
            to: { nodeId: plan.nodeId, portId: 'in' },
          },
        });
      });
      return deps.executeCommands(commands);
    };

    if (config.mode !== 'refine') {
      if (!commitBlocks(plans.map((plan) => plan.raw))) {
        deps.notice('创建块节点失败，未做任何修改', 'error');
        return;
      }
      deps.notice(
        options.replace === true && existing.length > 0
          ? `已覆盖为 ${plans.length} 块`
          : `已切分为 ${plans.length} 块`,
        'info',
      );
      deps.progress({ phase: 'split', done: plans.length, total: plans.length });
      deps.flash(splitNodeId, 'ok');
      return;
    }

    const run = { nodeId: splitNodeId };
    const isActive = (): boolean => active === run;
    active = run;
    cancelRequested = false;

    const system = buildRefineSystem(config.prompt);
    const chatConfig: AiChatConfig = { ...deps.aiConfig, model: config.model ?? deps.aiConfig.model };
    const labels = plans.map((plan) => plan.raw);
    const failedIndexes: number[] = [];
    let fatalMessage: string | null = null;

    for (let index = 0; index < plans.length; index += 1) {
      if (!isActive()) break;
      const plan = plans[index];
      if (plan === undefined) continue;
      deps.progress({ phase: 'refine', done: index, total: plans.length });
      const outcome = await refineChunk(plan.raw, system, chatConfig);
      if (!isActive()) break;
      if (outcome.ok) {
        if (outcome.text.trim() !== '') labels[index] = outcome.text.trim();
      } else if (outcome.fatal) {
        fatalMessage = outcome.message ?? '提炼失败';
        break;
      } else {
        failedIndexes.push(index);
      }
      deps.progress({ phase: 'refine', done: index + 1, total: plans.length });
    }

    active = null;
    activeSession = null;

    if (cancelRequested) {
      deps.notice('已取消提炼，未写入任何块', 'warning');
      return;
    }
    if (!commitBlocks(labels)) {
      deps.notice('创建块节点失败，未做任何修改', 'error');
      return;
    }
    deps.progress({ phase: 'split', done: plans.length, total: plans.length });
    for (const index of failedIndexes) {
      const plan = plans[index];
      if (plan !== undefined) deps.flash(plan.nodeId, 'error');
    }

    if (fatalMessage !== null) {
      deps.flash(splitNodeId, 'error');
      deps.notice(fatalMessage, 'error');
      return;
    }
    if (failedIndexes.length > 0) {
      deps.flash(splitNodeId, 'error');
      deps.notice(`${failedIndexes.length} 块提炼失败，已保留原始块文本`, 'warning');
      return;
    }
    deps.flash(splitNodeId, 'ok');
    deps.notice('逐块提炼完成', 'info');
  };

  const retryBlock = async (blockId: string): Promise<void> => {
    if (active !== null) {
      deps.notice('已有分块或汇总任务在执行，请先取消', 'warning');
      return;
    }
    const raw = deps.getDocument();
    const block = findNode(raw.nodes, blockId);
    if (block === null || block.type !== 'text' || typeof block.sourceNodeId !== 'string') {
      deps.notice('该节点不是分块子块，无法重试', 'warning');
      return;
    }
    const text = typeof block.label === 'string' ? block.label : '';
    if (text.trim() === '') {
      deps.notice('块内容为空，无法重试', 'warning');
      return;
    }
    const config = collectSplitConfig(raw.nodes, raw.edges, block.sourceNodeId);
    const run = { nodeId: block.sourceNodeId };
    active = run;
    cancelRequested = false;
    const system = buildRefineSystem(config.prompt);
    const chatConfig: AiChatConfig = { ...deps.aiConfig, model: config.model ?? deps.aiConfig.model };
    const outcome = await refineChunk(text, system, chatConfig);
    active = null;
    activeSession = null;
    if (cancelRequested) {
      deps.notice('已取消提炼，块内容保持不变', 'warning');
      return;
    }
    if (!outcome.ok) {
      deps.flash(blockId, 'error');
      deps.notice(outcome.message ?? '提炼失败', outcome.fatal ? 'error' : 'warning');
      return;
    }
    if (outcome.text.trim() === '') {
      deps.flash(blockId, 'error');
      deps.notice('提炼结果为空，块内容保持不变', 'warning');
      return;
    }
    if (
      !deps.executeCommands([
        { kind: 'updateNode', id: blockId, changes: { label: outcome.text.trim() } },
      ])
    ) {
      deps.flash(blockId, 'error');
      deps.notice('重试结果写回失败，未做任何修改', 'error');
      return;
    }
    deps.flash(blockId, 'ok');
    deps.notice('已重试该块', 'info');
  };

  return Object.freeze({
    start,
    retryBlock,
    cancel: (): void => {
      if (active === null) return;
      cancelRequested = true;
      active = null;
      const session = activeSession;
      activeSession = null;
      session?.cancel();
      const settle = settleRefine;
      settleRefine = null;
      settle?.({ ok: false, text: '', cancelled: true, fatal: false });
    },
  });
}