/**
 * C0-D：画布交互命令映射与 dead-link 判断（纯逻辑，不碰 React/DOM/IO）。
 *
 * - 右键菜单 → CanvasCommand[] 映射；
 * - 节点 id 生成（递增 + 时间戳后缀）；
 * - dead-link 四分支：effectivePath = resolveDocPath(docPath) ?? docPath，
 *   再查 docs.has(effectivePath)；
 * - 所有命令经 engine.execute() → controller.execute() → mutate → 统一历史。
 */
import {
  inspect,
  type CanvasCommand,
  type CanvasDocument,
  type CanvasNodeInput,
  type CanvasPortInput,
  type CanvasSchemaIssue,
} from '#canvas-format';
import type { CanvasSelection, InteractionState } from './interaction.ts';
import { illegalSegment } from '../../core/path-segments.ts';

/** 模块级不能有 let/var（I11/D12），用 IIFE 封装计数器状态。 */
const nodeIdGen = (() => {
  let c = 0;
  return () => { c += 1; return c; };
})();
const edgeIdGen = (() => {
  let c = 0;
  return () => { c += 1; return c; };
})();

export function makeNodeId(): string {
  return `n_${nodeIdGen()}_${Date.now().toString(36)}`;
}

export function makeEdgeId(): string {
  return `e_${edgeIdGen()}_${Date.now().toString(36)}`;
}

/**
 * 新建节点命令：最小合法形状，不自动补默认端口/type（R3=B 兼容投影）。
 */
export function createAddTextNodeCommand(
  x: number,
  y: number,
  label = '文本节点',
): CanvasCommand {
  const node: CanvasNodeInput = {
    id: makeNodeId(),
    x,
    y,
    type: 'text',
    label,
  };
  return { kind: 'addNode', node };
}

/** C1-D：编辑器选区拖入画布时的标签——首个非空行 trim 后截断 40 字符。 */
export function textLabelFromText(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '');
  if (firstLine === undefined) return '文本节点';
  return firstLine.length > 40 ? firstLine.slice(0, 40) : firstLine;
}

/** 文档节点标题：取路径最后一段（含扩展名），找不到分隔符时回退原路径。 */
export function documentTitleFromPath(docPath: string): string {
  const normalized = docPath.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return base === '' ? docPath : base;
}

export function createAddDocumentNodeCommand(
  x: number,
  y: number,
  docPath: string,
): CanvasCommand {
  const node: CanvasNodeInput = {
    id: makeNodeId(),
    x,
    y,
    type: 'document',
    docPath,
    label: documentTitleFromPath(docPath),
  };
  return { kind: 'addNode', node };
}

/**
 * CR-20261121-53：AI 节点 / 提示词节点最小合法形状。
 * ports 缺省由投影补 in/out（与文本节点同口径），可参与端口连线。
 */
export function createAddAiNodeCommand(x: number, y: number, label = 'AI 节点'): CanvasCommand {
  const node: CanvasNodeInput = { id: makeNodeId(), x, y, type: 'ai', label, text: '' };
  return { kind: 'addNode', node };
}

export function createAddPromptNodeCommand(
  x: number,
  y: number,
  label = '提示词',
): CanvasCommand {
  const node: CanvasNodeInput = { id: makeNodeId(), x, y, type: 'prompt', label, text: '' };
  return { kind: 'addNode', node };
}

/** 分块节点：把文章切成块，可选逐块提炼；配置内联在卡片上。 */
export function createAddSplitNodeCommand(
  x: number,
  y: number,
  label = '分块节点',
): CanvasCommand {
  const node: CanvasNodeInput = { id: makeNodeId(), x, y, type: 'split', label };
  return { kind: 'addNode', node };
}

/** 汇总节点：把上游块合并为一份结果。 */
export function createAddMergeNodeCommand(
  x: number,
  y: number,
  label = '汇总节点',
): CanvasCommand {
  const node: CanvasNodeInput = { id: makeNodeId(), x, y, type: 'merge', label };
  return { kind: 'addNode', node };
}

/** 分块节点内联配置；chunkChars=null 删除字段（按 provider 预算自动）。 */
export function createUpdateSplitConfigCommand(
  id: string,
  patch: { readonly mode?: 'split' | 'refine'; readonly chunkChars?: number | null },
): CanvasCommand {
  return { kind: 'updateNode', id, changes: patch };
}

/** CR-20261121-53：提示词正文更新（空串=清空，卡片显示占位）。 */
export function createUpdatePromptTextCommand(id: string, text: string): CanvasCommand {
  return { kind: 'updateNode', id, changes: { text } };
}

/** AI 节点内联提示词更新；与旧提示词节点共用可逆 text 命令通道。 */
export function createUpdateAiTextCommand(id: string, text: string): CanvasCommand {
  return { kind: 'updateNode', id, changes: { text } };
}

/** CR-20261121-53：AI 节点模型选择；null=未选择（删除字段）。 */
export function createUpdateAiModelCommand(id: string, model: string | null): CanvasCommand {
  return { kind: 'updateNode', id, changes: { model } };
}

export type FinderDocumentResolution =
  | { readonly kind: 'library'; readonly path: string }
  | { readonly kind: 'unindexed'; readonly path: string }
  | { readonly kind: 'external' };

/** Finder `.md` 绝对路径 → 库内相对路径；库根边界与索引均通过才允许建节点。 */
export function resolveFinderDocumentPath(
  path: string,
  libraryRoot: string | null,
  hasDoc: (relativePath: string) => boolean,
): FinderDocumentResolution {
  if (libraryRoot === null || libraryRoot === '') return { kind: 'external' };
  const absolute = path.replace(/\\/g, '/');
  const root = libraryRoot.replace(/\\/g, '/');
  const prefix = root.endsWith('/') ? root : `${root}/`;
  if (!absolute.startsWith(prefix)) return { kind: 'external' };

  const relative = absolute.slice(prefix.length);
  if (relative === '' || illegalSegment(relative) !== null) {
    return { kind: 'external' };
  }
  return hasDoc(relative) ? { kind: 'library', path: relative } : { kind: 'unindexed', path: relative };
}

/**
 * S4：应用内拖拽载荷是库内相对路径，复用与 Finder 通道同款的路径段纪律：
 * 非空、无 `.`/`..`/空段、且必须能在知识库索引中命中。
 */
export function isSafeLibraryDocPath(
  path: string,
  hasDoc: (relativePath: string) => boolean,
): boolean {
  const normalized = path.replace(/\\/g, '/');
  if (normalized === '' || illegalSegment(normalized) !== null) {
    return false;
  }
  return hasDoc(normalized);
}

/** C1-C：媒体节点。`path` 是库内媒体相对路径（schema 保留未知字段，非 document 禁 docPath）。 */
export function createAddMediaNodeCommand(
  x: number,
  y: number,
  path: string,
  kind: 'image' | 'audio' | 'video' | 'doc',
  label: string = documentTitleFromPath(path),
): CanvasCommand {
  // 统一外壳包含顶部信息与页脚，为预览和播放控件预留完整内表面。
  const defaultSize: { w: number; h: number } =
    kind === 'audio'
      ? { w: 300, h: 132 }
      : kind === 'video'
        ? { w: 320, h: 180 }
        : kind === 'doc'
          ? { w: 280, h: 132 }
          : { w: 280, h: 180 };
  const node: CanvasNodeInput = {
    id: makeNodeId(),
    x,
    y,
    type: 'media',
    kind,
    path,
    label,
    w: defaultSize.w,
    h: defaultSize.h,
  };
  return { kind: 'addNode', node };
}

/** 删除选中节点：最小实现（engine 会同时处理 removeNode 级联边）。 */
export function createRemoveNodeCommands(ids: readonly string[]): readonly CanvasCommand[] {
  return ids.map((id) => ({ kind: 'removeNode', id }));
}

/** Delete 与连线右键菜单共用的删除命令；统一经 controller 写入可逆历史。 */
export function createRemoveEdgeCommands(ids: readonly string[]): readonly CanvasCommand[] {
  return ids.map((id) => ({ kind: 'removeEdge', id }));
}

/**
 * S1：按文档投影剔除已不存在的节点/边 id。
 *
 * 删除/撤销/外部替换后 selection 可能残留死 id；死 id 会让整批删除命令
 * 被 E_MUTATE_TARGET 原子拒绝并反复失败。无变化时返回原引用，避免无谓重渲染。
 */
export function pruneSelection(
  selection: CanvasSelection,
  document: CanvasDocument,
): CanvasSelection {
  const { nodes, edges } = inspect(document).projection;
  const liveNodes = new Set(nodes.map((node) => node.id));
  const liveEdges = new Set(edges.map((edge) => edge.id));
  const keptNodes = new Set([...selection.nodes].filter((id) => liveNodes.has(id)));
  const keptEdges = new Set([...selection.edges].filter((id) => liveEdges.has(id)));
  if (keptNodes.size === selection.nodes.size && keptEdges.size === selection.edges.size) {
    return selection;
  }
  return { nodes: keptNodes, edges: keptEdges };
}

/** S1：只同步选中集，保留 gesture；文档变更后由 engine 调用。 */
export function pruneInteraction(
  state: InteractionState,
  document: CanvasDocument,
): InteractionState {
  const selection = pruneSelection(state.selection, document);
  return selection === state.selection ? state : { ...state, selection };
}

/** 节点级联边不重复生成 removeEdge；其余选中边与节点合并为同一原子历史批。 */
export function createDeleteSelectionCommands(
  document: CanvasDocument,
  nodeIds: readonly string[],
  edgeIds: readonly string[],
): readonly CanvasCommand[] {
  // S1 双保险：生成时再过滤一层，文档中已不存在的 id 绝不进入命令批。
  const projection = inspect(document).projection;
  const liveNodes = new Set(projection.nodes.map((node) => node.id));
  const liveEdges = new Set(projection.edges.map((edge) => edge.id));
  const existingNodeIds = nodeIds.filter((id) => liveNodes.has(id));
  const existingEdgeIds = edgeIds.filter((id) => liveEdges.has(id));
  if (existingNodeIds.length === 0) return createRemoveEdgeCommands(existingEdgeIds);
  const selectedNodes = new Set(existingNodeIds);
  const cascadedEdges = new Set(
    projection.edges
      .filter((edge) => selectedNodes.has(edge.from.nodeId) || selectedNodes.has(edge.to.nodeId))
      .map((edge) => edge.id),
  );
  return [
    ...createRemoveNodeCommands(existingNodeIds),
    ...createRemoveEdgeCommands(existingEdgeIds.filter((id) => !cascadedEdges.has(id))),
  ];
}

export function createCanvasSelectAllSelection(document: CanvasDocument): {
  readonly nodes: ReadonlySet<string>;
  readonly edges: ReadonlySet<string>;
} {
  const { nodes, edges } = inspect(document).projection;
  return {
    nodes: new Set(nodes.map((node) => node.id)),
    edges: new Set(edges.map((edge) => edge.id)),
  };
}

export function createUpdateLabelCommand(id: string, label: string): CanvasCommand {
  return { kind: 'updateNode', id, changes: { label } };
}

export type CanvasTextEditKeyAction = 'newline' | 'submit' | 'cancel' | null;

/** 文本节点：Shift+Enter 显式换行，普通 Enter 提交，Escape 取消。 */
export function canvasTextEditKeyAction(event: {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly isComposing?: boolean;
}): CanvasTextEditKeyAction {
  if (event.isComposing === true) return null;
  if (event.key === 'Escape') return 'cancel';
  if (event.key === 'Enter' && event.shiftKey) return 'newline';
  if (event.key === 'Enter') return 'submit';
  return null;
}

/**
 * CR-20261118-05 §4.4：拉线落空新建节点的显式端口。
 * 这是调用方显式给出的字段，不是格式层在 addNode 时补默认值。
 */
export function createConnectionNodePorts(): readonly CanvasPortInput[] {
  return [
    { id: 'in', dir: 'in' },
    { id: 'out', dir: 'out' },
  ];
}

/**
 * 新节点 + 从源 out 端口连到新节点 `in` 端口；两条命令同批提交，undo/redo 原子。
 * 调用方须保证 `node.ports` 已显式包含 `{ id: 'in', dir: 'in' }`。
 */
export function createConnectNewNodeCommands(
  node: CanvasNodeInput,
  from: { readonly nodeId: string; readonly portId: string },
): readonly CanvasCommand[] {
  return [
    { kind: 'addNode', node },
    {
      kind: 'addEdge',
      edge: { id: makeEdgeId(), from, to: { nodeId: node.id, portId: 'in' } },
    },
  ];
}

export interface CanvasConnectionCandidate {
  readonly from: { readonly nodeId: string; readonly portId: string };
  readonly to: { readonly nodeId: string; readonly portId: string };
}

/**
 * 连线 pointerUp 的交互层预检：把候选边交给唯一 I9 规则源，仅读取新边上的
 * group / 引用 / 端口方向 issues；不写文档，也不进入 mutate 或历史。
 */
export function inspectConnectionCandidate(
  document: CanvasDocument,
  candidate: CanvasConnectionCandidate,
): readonly CanvasSchemaIssue[] {
  const edgeIndex = document.edges.length;
  const inspection = inspect({
    ...document,
    edges: [
      ...document.edges,
      { id: '__interaction_precheck__', from: candidate.from, to: candidate.to },
    ],
  });
  return inspection.issues.filter(
    (issue) =>
      issue.edgeIndex === edgeIndex &&
      (issue.code === 'E_SCHEMA_GROUP' ||
        issue.code === 'E_SCHEMA_EDGE_REF' ||
        issue.code === 'E_SCHEMA_PORT_DIR'),
  );
}

export function createUpdateDocPathCommand(id: string, docPath: string): CanvasCommand {
  return { kind: 'updateNode', id, changes: { docPath } };
}

/** ⌥复制：拖动结束时目标节点 id 与落点世界坐标。 */
export interface CanvasDuplicatePlacement {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/** 文档节点最小结构守卫：只有含合法 id/x/y 的对象才参与复制。 */
function isCanvasNodeInput(value: unknown): value is CanvasNodeInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (!('id' in value) || !('x' in value) || !('y' in value)) return false;
  return typeof value.id === 'string' && typeof value.x === 'number' && typeof value.y === 'number';
}

/**
 * ⌥复制：为每个落点生成 addNode 命令。
 *
 * - 复制源节点的全部字段（label/docPath/type/ports/parentId 等原样保留）；
 * - 只替换 id（新 id）与 x/y（落点）；
 * - 不自动补 schema 默认值（源节点没有的字段副本也没有）；
 * - 源节点不存在时跳过该落点，不伪造空节点。
 */
export function createDuplicateNodeCommands(
  entries: readonly CanvasDuplicatePlacement[],
  nodes: readonly unknown[],
): readonly CanvasCommand[] {
  const byId = new Map<string, CanvasNodeInput>();
  for (const node of nodes) {
    if (isCanvasNodeInput(node)) byId.set(node.id, node);
  }

  const commands: CanvasCommand[] = [];
  for (const entry of entries) {
    const source = byId.get(entry.id);
    if (source === undefined) continue;
    const node: CanvasNodeInput = { ...source, id: makeNodeId(), x: entry.x, y: entry.y };
    commands.push({ kind: 'addNode', node });
  }
  return commands;
}

/**
 * R5=A：effectivePath 计算与死链判断。
 *
 * 四分支：
 * 1. resolveDocPath 返回非 null → 别名命中（会话内可解析的外部改名，不是死链）
 * 2. resolveDocPath 返回 null 且 docs.has(docPath) → 直接索引命中，有效
 * 3. resolveDocPath 返回 null 且 !docs.has(docPath) → 死链
 * 4. docPath 为空 → 未绑定文档（新节点/重绑前），不算死链（不阻塞创建）
 */
export function resolveEffectivePath(
  docPath: string,
  resolveDocPath: (from: string) => string | null,
): string | null {
  if (docPath === '') return null;
  const resolved = resolveDocPath(docPath);
  return resolved ?? docPath;
}

export type DocLinkStatus =
  | { readonly kind: 'unbound' }
  | { readonly kind: 'ok'; readonly effectivePath: string }
  | { readonly kind: 'dead'; readonly effectivePath: string };

export function classifyDocLink(
  docPath: string,
  resolveDocPath: (from: string) => string | null,
  hasDoc: (path: string) => boolean,
): DocLinkStatus {
  if (docPath === '') return { kind: 'unbound' };
  const effectivePath = resolveEffectivePath(docPath, resolveDocPath);
  if (effectivePath === null) return { kind: 'unbound' };
  if (hasDoc(effectivePath)) return { kind: 'ok', effectivePath };
  return { kind: 'dead', effectivePath };
}
