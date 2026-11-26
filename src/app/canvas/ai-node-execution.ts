/**
 * CR-20261121-53：AI 节点执行的前置纯逻辑——邻居收集与消息构造（零 DOM / 零 IPC）。
 *
 * CR-20261122-62：文档连线采用最小有向语义——文档 → AI 为素材，AI → 文档为输出。
 * 提示词节点=指令、文本节点=输出目的地（均取直连，文本取首条），方向保持无关；
 * 多篇素材与多条提示词按连线在文档中的顺序收集。
 */

export interface AiNeighborDoc {
  readonly nodeId: string;
  readonly docPath: string;
  readonly label: string;
}

export interface AiNeighborCollect {
  readonly docs: readonly AiNeighborDoc[];
  /** 非空提示词正文列表（按连线顺序）。 */
  readonly prompts: readonly string[];
  /** 首个直连文本节点 id（输出目的地）；无则 null。 */
  readonly outputNodeId: string | null;
  /** 首个 AI → 文档节点（空文档输出目的地）；无则 null。 */
  readonly outputDoc: AiNeighborDoc | null;
  /** AI 节点已选模型；未选择为 null。 */
  readonly model: string | null;
}

type RawRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function endpointNodeId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const nodeId = value.nodeId;
  return typeof nodeId === 'string' && nodeId !== '' ? nodeId : null;
}

/** 提示词「开始」：按连线顺序找首个直连 AI，方向无关；自环与非 AI 邻居忽略。 */
export function findPromptAiNode(
  nodes: readonly unknown[],
  edges: readonly unknown[],
  promptId: string,
): string | null {
  const aiNodeIds = new Set<string>();
  for (const raw of nodes) {
    if (!isRecord(raw) || raw.type !== 'ai') continue;
    if (typeof raw.id === 'string' && raw.id !== '') aiNodeIds.add(raw.id);
  }
  for (const edge of edges) {
    if (!isRecord(edge)) continue;
    const from = endpointNodeId(edge.from);
    const to = endpointNodeId(edge.to);
    const other = from === promptId ? to : to === promptId ? from : null;
    // 有意收紧：自环一律视为未连接，避免异常重复 ID 将 Prompt 自身作为 AI 执行。
    if (other === null || other === promptId || !aiNodeIds.has(other)) continue;
    return other;
  }
  return null;
}

/** 邻居收集：nodes/edges 为画布原始文档条目（engine.getDocument() 形状）。 */
export function collectAiNeighbors(
  nodes: readonly unknown[],
  edges: readonly unknown[],
  aiNodeId: string,
): AiNeighborCollect {
  const nodesById = new Map<string, RawRecord>();
  for (const raw of nodes) {
    if (!isRecord(raw)) continue;
    const id = raw.id;
    if (typeof id === 'string' && id !== '') nodesById.set(id, raw);
  }

  const docs: AiNeighborDoc[] = [];
  const seenDocIds = new Set<string>();
  const aiNode = nodesById.get(aiNodeId);
  const ownPrompt = typeof aiNode?.text === 'string' && aiNode.text.trim() !== '' ? aiNode.text : null;
  const prompts: string[] = ownPrompt === null ? [] : [ownPrompt];
  let outputNodeId: string | null = null;
  let outputDoc: AiNeighborDoc | null = null;

  for (const edge of edges) {
    if (!isRecord(edge)) continue;
    const from = endpointNodeId(edge.from);
    const to = endpointNodeId(edge.to);
    const other = from === aiNodeId ? to : to === aiNodeId ? from : null;
    if (other === null) continue;
    const node = nodesById.get(other);
    if (node === undefined) continue;
    if (node.type === 'document') {
      const docPath = node.docPath;
      if (typeof docPath !== 'string' || docPath === '') continue;
      const doc = {
        nodeId: other,
        docPath,
        label: typeof node.label === 'string' && node.label !== '' ? node.label : docPath,
      };
      if (to === aiNodeId) {
        if (seenDocIds.has(other)) continue;
        seenDocIds.add(other);
        docs.push(doc);
      } else if (outputDoc === null) {
        outputDoc = doc;
      }
    } else if (node.type === 'prompt') {
      if (typeof node.text === 'string' && node.text.trim() !== '') prompts.push(node.text);
    } else if (node.type === 'text') {
      if (outputNodeId === null) outputNodeId = other;
    }
  }

  const model =
    typeof aiNode?.model === 'string' && aiNode.model !== '' ? aiNode.model : null;
  return { docs, prompts, outputNodeId, outputDoc, model };
}

/** 无提示词节点时的内置默认指令（D4：无提示词直接生成汇总/深化）。 */
export const DEFAULT_AI_INSTRUCTION =
  '请汇总并分析以下文章内容：提炼核心论点与关键信息，做深化解读；若有多篇文章，请指出它们之间的关联。';

/** 素材总字符上限（含标题分节头）；与 CR-53 方案 §4 一致。 */
export const AI_RUN_MAX_CHARS = 100_000;

export type AiRunMessages =
  | { readonly ok: true; readonly system: string; readonly user: string }
  | { readonly ok: false; readonly reason: 'empty_docs' | 'too_long' };

/** 消息构造：提示词节点=system（缺省用内置指令），文章分节=user。 */
export function buildAiRunMessages(args: {
  readonly docs: readonly { readonly title: string; readonly content: string }[];
  readonly prompts: readonly string[];
}): AiRunMessages {
  if (args.docs.length === 0) return { ok: false, reason: 'empty_docs' };
  const sections = args.docs.map(
    (doc, index) => `【文章 ${index + 1}：${doc.title}】\n\n${doc.content}`,
  );
  const user = sections.join('\n\n');
  const prompt = args.prompts
    .map((text) => text.trim())
    .filter((text) => text !== '')
    .join('\n\n');
  const system = prompt !== '' ? prompt : DEFAULT_AI_INSTRUCTION;
  if (user.length + system.length > AI_RUN_MAX_CHARS) {
    return { ok: false, reason: 'too_long' };
  }
  return { ok: true, system, user };
}
