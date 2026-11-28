import { MAX_NODE_DIMENSION, inspect } from './document.ts';
import type {
  CanvasCommand,
  CanvasCommandError,
  CanvasDocument,
  CanvasEdgeInput,
  CanvasMoveEntry,
  CanvasMutateResult,
  CanvasNodeInput,
  CanvasSplitMode,
} from './types.ts';

type RawRecord = Readonly<Record<string, unknown>>;
type MutableChanges = {
  label?: string | null;
  docPath?: string | null;
  w?: number | null;
  h?: number | null;
  /** CR-20261121-53：prompt 节点正文。 */
  text?: string | null;
  /** CR-20261121-53：ai 节点选用模型；null=未选择。 */
  model?: string | null;
  /** split 节点的分块方式；null=缺省 split。 */
  mode?: CanvasSplitMode | null;
  /** split 节点的目标块大小；null=按预算。 */
  chunkChars?: number | null;
};
const TEXT_CHANGE_KEYS = ['label', 'docPath', 'text', 'model'] as const;
const SIZE_CHANGE_KEYS = ['w', 'h'] as const;
const MODE_CHANGE_KEYS = ['mode'] as const;
const CHUNK_CHANGE_KEYS = ['chunkChars'] as const;

interface Draft {
  nodes: unknown[];
  edges: unknown[];
}

type CommandApplication =
  | { readonly ok: true; readonly inverse: readonly CanvasCommand[] }
  | { readonly ok: false; readonly error: CanvasCommandError };

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: RawRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isDeepFrozen(value: unknown): boolean {
  if (!Array.isArray(value) && !isRecord(value)) return true;
  return Object.isFrozen(value) && Object.values(value).every((entry) => isDeepFrozen(entry));
}

/** addNode/addEdge 切断可变输入别名；深冻结 inverse 条目可安全保持原引用。 */
function cloneStructure(value: unknown): unknown {
  if (isDeepFrozen(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => cloneStructure(entry));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, cloneStructure(entry)]),
  );
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function failure(
  commandIndex: number,
  code: 'E_MUTATE_COMMAND' | 'E_MUTATE_TARGET',
  path: string,
  message: string,
): CommandApplication {
  return { ok: false, error: { commandIndex, code, path, message } };
}

function success(inverse: readonly CanvasCommand[]): CommandApplication {
  return { ok: true, inverse };
}

function findNodeIndex(nodes: readonly unknown[], id: string): number {
  return nodes.findIndex((node) => isRecord(node) && node.id === id);
}

function findEdgeIndex(edges: readonly unknown[], id: string): number {
  return edges.findIndex((edge) => isRecord(edge) && edge.id === id);
}

function insertionIndex(command: RawRecord, length: number): number | null {
  if (!hasOwn(command, 'index')) return length;
  const index = command.index;
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 && index <= length ? index : null;
}

function applyMove(draft: Draft, command: RawRecord, commandIndex: number): CommandApplication {
  if (!Array.isArray(command.entries)) {
    return failure(commandIndex, 'E_MUTATE_COMMAND', `/commands/${commandIndex}/entries`, 'move.entries 必须是数组');
  }

  const plans: { readonly index: number; readonly entry: CanvasMoveEntry }[] = [];
  for (const [entryIndex, value] of command.entries.entries()) {
    const basePath = `/commands/${commandIndex}/entries/${entryIndex}`;
    if (!isRecord(value)) {
      return failure(commandIndex, 'E_MUTATE_COMMAND', basePath, 'move 条目必须是对象');
    }
    const id = nonEmptyString(value.id);
    const dx = finiteNumber(value.dx);
    const dy = finiteNumber(value.dy);
    if (id === null) {
      return failure(commandIndex, 'E_MUTATE_COMMAND', `${basePath}/id`, 'move 条目 id 必须是非空字符串');
    }
    if (dx === null) {
      return failure(commandIndex, 'E_MUTATE_COMMAND', `${basePath}/dx`, 'move.dx 必须是有限数');
    }
    if (dy === null) {
      return failure(commandIndex, 'E_MUTATE_COMMAND', `${basePath}/dy`, 'move.dy 必须是有限数');
    }
    const index = findNodeIndex(draft.nodes, id);
    if (index < 0) {
      return failure(commandIndex, 'E_MUTATE_TARGET', `${basePath}/id`, `目标节点不存在：${id}`);
    }
    plans.push({ index, entry: { id, dx, dy } });
  }

  for (const plan of plans) {
    const node = draft.nodes[plan.index];
    if (!isRecord(node) || typeof node.x !== 'number' || typeof node.y !== 'number') continue;
    draft.nodes[plan.index] = {
      ...node,
      x: node.x + plan.entry.dx,
      y: node.y + plan.entry.dy,
    };
  }
  return success([
    {
      kind: 'move',
      entries: plans.map(({ entry }) => ({ id: entry.id, dx: -entry.dx, dy: -entry.dy })),
    },
  ]);
}

function applyAddNode(draft: Draft, command: RawRecord, commandIndex: number): CommandApplication {
  const path = `/commands/${commandIndex}/node`;
  const node = command.node;
  if (!isRecord(node)) {
    return failure(commandIndex, 'E_MUTATE_COMMAND', path, 'addNode.node 必须是对象');
  }
  const id = nonEmptyString(node.id);
  if (id === null) {
    return failure(commandIndex, 'E_MUTATE_COMMAND', `${path}/id`, 'addNode 要求非空字符串 id');
  }
  if (finiteNumber(node.x) === null) {
    return failure(commandIndex, 'E_MUTATE_COMMAND', `${path}/x`, 'addNode 要求有限数 x');
  }
  if (finiteNumber(node.y) === null) {
    return failure(commandIndex, 'E_MUTATE_COMMAND', `${path}/y`, 'addNode 要求有限数 y');
  }
  const index = insertionIndex(command, draft.nodes.length);
  if (index === null) {
    return failure(commandIndex, 'E_MUTATE_COMMAND', `/commands/${commandIndex}/index`, 'addNode.index 超出数组范围');
  }

  draft.nodes.splice(index, 0, cloneStructure(node));
  return success([{ kind: 'removeNode', id }]);
}

function applyAddEdge(draft: Draft, command: RawRecord, commandIndex: number): CommandApplication {
  const path = `/commands/${commandIndex}/edge`;
  const edge = command.edge;
  if (!isRecord(edge)) {
    return failure(commandIndex, 'E_MUTATE_COMMAND', path, 'addEdge.edge 必须是对象');
  }
  const id = nonEmptyString(edge.id);
  if (id === null) {
    return failure(commandIndex, 'E_MUTATE_COMMAND', `${path}/id`, 'addEdge 要求非空字符串 id');
  }
  if (!isRecord(edge.from) || nonEmptyString(edge.from.nodeId) === null) {
    return failure(commandIndex, 'E_MUTATE_COMMAND', `${path}/from/nodeId`, 'addEdge.from 要求非空 nodeId');
  }
  if (!isRecord(edge.to) || nonEmptyString(edge.to.nodeId) === null) {
    return failure(commandIndex, 'E_MUTATE_COMMAND', `${path}/to/nodeId`, 'addEdge.to 要求非空 nodeId');
  }
  const index = insertionIndex(command, draft.edges.length);
  if (index === null) {
    return failure(commandIndex, 'E_MUTATE_COMMAND', `/commands/${commandIndex}/index`, 'addEdge.index 超出数组范围');
  }

  draft.edges.splice(index, 0, cloneStructure(edge));
  return success([{ kind: 'removeEdge', id }]);
}

function endpointNodeId(value: unknown): string | null {
  return isRecord(value) ? nonEmptyString(value.nodeId) : null;
}

function applyRestoreNode(draft: Draft, command: RawRecord, commandIndex: number): CommandApplication {
  const path = `/commands/${commandIndex}/entry`;
  const entry = command.entry;
  if (!isRecord(entry)) {
    return failure(commandIndex, 'E_MUTATE_COMMAND', path, 'restoreNode.entry 必须是对象');
  }
  const id = nonEmptyString(entry.id);
  if (id === null) {
    return failure(commandIndex, 'E_MUTATE_COMMAND', `${path}/id`, 'restoreNode 要求非空字符串 id');
  }
  if (finiteNumber(entry.x) === null) {
    return failure(commandIndex, 'E_MUTATE_COMMAND', `${path}/x`, 'restoreNode 要求有限数 x');
  }
  if (finiteNumber(entry.y) === null) {
    return failure(commandIndex, 'E_MUTATE_COMMAND', `${path}/y`, 'restoreNode 要求有限数 y');
  }
  const index = command.index;
  if (
    typeof index !== 'number' ||
    !Number.isInteger(index) ||
    index < 0 ||
    index > draft.nodes.length
  ) {
    return failure(commandIndex, 'E_MUTATE_COMMAND', `/commands/${commandIndex}/index`, 'restoreNode.index 超出数组范围');
  }

  const existingIndex = findNodeIndex(draft.nodes, id);
  if (existingIndex >= 0 && existingIndex !== index) {
    return failure(commandIndex, 'E_MUTATE_TARGET', `/commands/${commandIndex}/index`, 'restoreNode 目标节点不在原索引');
  }
  if (existingIndex === index) {
    const current = draft.nodes[index];
    if (!isRecord(current)) {
      return failure(commandIndex, 'E_MUTATE_TARGET', `${path}/id`, `目标节点不可读取：${id}`);
    }
    draft.nodes[index] = entry;
    return success([{ kind: 'restoreNode', entry: current as CanvasNodeInput, index }]);
  }

  draft.nodes.splice(index, 0, entry);
  return success([{ kind: 'removeNode', id }]);
}

function applyRemoveNode(draft: Draft, command: RawRecord, commandIndex: number): CommandApplication {
  const id = nonEmptyString(command.id);
  if (id === null) {
    return failure(commandIndex, 'E_MUTATE_COMMAND', `/commands/${commandIndex}/id`, 'removeNode.id 必须是非空字符串');
  }
  const index = findNodeIndex(draft.nodes, id);
  if (index < 0) {
    return failure(commandIndex, 'E_MUTATE_TARGET', `/commands/${commandIndex}/id`, `目标节点不存在：${id}`);
  }
  const node = draft.nodes[index];
  if (!isRecord(node)) {
    return failure(commandIndex, 'E_MUTATE_TARGET', `/commands/${commandIndex}/id`, `目标节点不可读取：${id}`);
  }

  const removedEdges: { readonly edge: CanvasEdgeInput; readonly index: number }[] = [];
  const keptEdges: unknown[] = [];
  for (const [edgeIndex, value] of draft.edges.entries()) {
    const incident =
      isRecord(value) &&
      (endpointNodeId(value.from) === id || endpointNodeId(value.to) === id);
    if (incident && isRecord(value)) {
      removedEdges.push({ edge: value as CanvasEdgeInput, index: edgeIndex });
    } else {
      keptEdges.push(value);
    }
  }

  draft.nodes.splice(index, 1);
  draft.edges = keptEdges;
  return success([
    { kind: 'restoreNode', entry: node as CanvasNodeInput, index },
    ...removedEdges.map(({ edge, index: edgeIndex }): CanvasCommand => ({
      kind: 'addEdge',
      edge,
      index: edgeIndex,
    })),
  ]);
}

function applyRemoveEdge(draft: Draft, command: RawRecord, commandIndex: number): CommandApplication {
  const id = nonEmptyString(command.id);
  if (id === null) {
    return failure(commandIndex, 'E_MUTATE_COMMAND', `/commands/${commandIndex}/id`, 'removeEdge.id 必须是非空字符串');
  }
  const index = findEdgeIndex(draft.edges, id);
  if (index < 0) {
    return failure(commandIndex, 'E_MUTATE_TARGET', `/commands/${commandIndex}/id`, `目标连线不存在：${id}`);
  }
  const edge = draft.edges[index];
  if (!isRecord(edge)) {
    return failure(commandIndex, 'E_MUTATE_TARGET', `/commands/${commandIndex}/id`, `目标连线不可读取：${id}`);
  }

  draft.edges.splice(index, 1);
  return success([{ kind: 'addEdge', edge: edge as CanvasEdgeInput, index }]);
}

function applyUpdateNode(draft: Draft, command: RawRecord, commandIndex: number): CommandApplication {
  const id = nonEmptyString(command.id);
  if (id === null) {
    return failure(commandIndex, 'E_MUTATE_COMMAND', `/commands/${commandIndex}/id`, 'updateNode.id 必须是非空字符串');
  }
  const changes = command.changes;
  const changesPath = `/commands/${commandIndex}/changes`;
  if (!isRecord(changes)) {
    return failure(commandIndex, 'E_MUTATE_COMMAND', changesPath, 'updateNode.changes 必须是对象');
  }
  const keys = Object.keys(changes);
  const isAllowedKey = (key: string): boolean =>
    key === 'label' ||
    key === 'docPath' ||
    key === 'w' ||
    key === 'h' ||
    key === 'text' ||
    key === 'model' ||
    key === 'mode' ||
    key === 'chunkChars';
  if (keys.length === 0 || !keys.every(isAllowedKey)) {
    return failure(
      commandIndex,
      'E_MUTATE_COMMAND',
      changesPath,
      'updateNode.changes 至少含一个 label/docPath/w/h/text/model/mode/chunkChars，且不得夹带其他键',
    );
  }

  const updates: MutableChanges = {};
  for (const key of TEXT_CHANGE_KEYS) {
    if (!hasOwn(changes, key)) continue;
    const value = changes[key];
    if (value !== null && typeof value !== 'string') {
      return failure(commandIndex, 'E_MUTATE_COMMAND', `${changesPath}/${key}`, `${key} 只能是 string 或 null`);
    }
    updates[key] = value;
  }
  for (const key of SIZE_CHANGE_KEYS) {
    if (!hasOwn(changes, key)) continue;
    const value = changes[key];
    if (value === null) {
      updates[key] = null;
      continue;
    }
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value <= 0 ||
      value > MAX_NODE_DIMENSION
    ) {
      return failure(
        commandIndex,
        'E_MUTATE_COMMAND',
        `${changesPath}/${key}`,
        `${key} 只能是 (0, ${MAX_NODE_DIMENSION}] 的有限数或 null`,
      );
    }
    updates[key] = value;
  }
  for (const key of MODE_CHANGE_KEYS) {
    if (!hasOwn(changes, key)) continue;
    const value = changes[key];
    if (value !== null && value !== 'split' && value !== 'refine') {
      return failure(commandIndex, 'E_MUTATE_COMMAND', `${changesPath}/${key}`, "mode 只能是 'split'、'refine' 或 null");
    }
    updates.mode = value;
  }
  for (const key of CHUNK_CHANGE_KEYS) {
    if (!hasOwn(changes, key)) continue;
    const value = changes[key];
    if (value === null) {
      updates.chunkChars = null;
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return failure(
        commandIndex,
        'E_MUTATE_COMMAND',
        `${changesPath}/${key}`,
        'chunkChars 只能是正的有限数或 null',
      );
    }
    updates.chunkChars = value;
  }

  const index = findNodeIndex(draft.nodes, id);
  if (index < 0) {
    return failure(commandIndex, 'E_MUTATE_TARGET', `/commands/${commandIndex}/id`, `目标节点不存在：${id}`);
  }
  const node = draft.nodes[index];
  if (!isRecord(node)) {
    return failure(commandIndex, 'E_MUTATE_TARGET', `/commands/${commandIndex}/id`, `目标节点不可读取：${id}`);
  }

  const next: Record<string, unknown> = { ...node };
  for (const key of TEXT_CHANGE_KEYS) {
    if (!hasOwn(changes, key)) continue;
    const value = updates[key];
    if (value === null) {
      delete next[key];
    } else if (typeof value === 'string') {
      next[key] = value;
    }
  }
  for (const key of SIZE_CHANGE_KEYS) {
    if (!hasOwn(changes, key)) continue;
    const value = updates[key];
    if (value === null) {
      delete next[key];
    } else if (typeof value === 'number') {
      next[key] = value;
    }
  }
  for (const key of MODE_CHANGE_KEYS) {
    if (!hasOwn(changes, key)) continue;
    const value = updates[key];
    if (value === null) {
      delete next[key];
    } else if (typeof value === 'string') {
      next[key] = value;
    }
  }
  for (const key of CHUNK_CHANGE_KEYS) {
    if (!hasOwn(changes, key)) continue;
    const value = updates[key];
    if (value === null) {
      delete next[key];
    } else if (typeof value === 'number') {
      next[key] = value;
    }
  }
  draft.nodes[index] = next;
  return success([{ kind: 'restoreNode', entry: node as CanvasNodeInput, index }]);
}

function applyCommand(draft: Draft, command: unknown, commandIndex: number): CommandApplication {
  if (!isRecord(command)) {
    return failure(commandIndex, 'E_MUTATE_COMMAND', `/commands/${commandIndex}`, '命令必须是对象');
  }
  switch (command.kind) {
    case 'move':
      return applyMove(draft, command, commandIndex);
    case 'addNode':
      return applyAddNode(draft, command, commandIndex);
    case 'removeNode':
      return applyRemoveNode(draft, command, commandIndex);
    case 'restoreNode':
      return applyRestoreNode(draft, command, commandIndex);
    case 'addEdge':
      return applyAddEdge(draft, command, commandIndex);
    case 'removeEdge':
      return applyRemoveEdge(draft, command, commandIndex);
    case 'updateNode':
      return applyUpdateNode(draft, command, commandIndex);
    default:
      return failure(commandIndex, 'E_MUTATE_COMMAND', `/commands/${commandIndex}/kind`, '未知画布命令');
  }
}

/** 在结构共享草稿上原子应用命令；inverse 已按整批 undo 顺序排列。 */
export function mutate(document: CanvasDocument, commands: readonly CanvasCommand[]): CanvasMutateResult {
  const initialInspection = inspect(document);
  if (commands.length === 0) {
    return { ok: true, document, inverse: [], inspection: initialInspection };
  }
  if (initialInspection.issues.length > 0) {
    return { ok: false, kind: 'document', issues: initialInspection.issues };
  }

  const draft: Draft = { nodes: [...document.nodes], edges: [...document.edges] };
  const inverses: CanvasCommand[][] = [];
  let current = document;
  let inspection = initialInspection;

  for (const [commandIndex, command] of commands.entries()) {
    const application = applyCommand(draft, command, commandIndex);
    if (!application.ok) return { ok: false, kind: 'command', errors: [application.error] };

    current = { ...document, nodes: draft.nodes, edges: draft.edges };
    inspection = inspect(current);
    if (inspection.issues.length > 0) {
      return {
        ok: false,
        kind: 'command',
        errors: inspection.issues.map((issue) => ({
          commandIndex,
          code: issue.code,
          message: issue.message,
          path: issue.path,
        })),
      };
    }
    inverses.push([...application.inverse]);
  }

  return {
    ok: true,
    document: current,
    inverse: inverses.reverse().flat(),
    inspection,
  };
}
