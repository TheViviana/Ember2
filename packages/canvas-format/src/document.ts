import { isCanvasNodeType } from './node-types.ts';
import type {
  CanvasDocument,
  CanvasEdge,
  CanvasEndpoint,
  CanvasInspection,
  CanvasNode,
  CanvasPort,
  CanvasPortDirection,
  CanvasProjection,
  CanvasSchemaIssue,
  CanvasSchemaIssueCode,
} from './types.ts';

type RawRecord = Readonly<Record<string, unknown>>;
type NodeType = CanvasNode['type'];

/** 节点显式 w/h 的合法上限；与 CR-20261118-05 §1 第 6 项一致。 */
export const MAX_NODE_DIMENSION = 10000;

interface NodeState {
  readonly raw: RawRecord | null;
  readonly index: number;
  id: string | null;
  x: number | null;
  y: number | null;
  type: NodeType | null;
  ports: readonly CanvasPort[];
  hasOwnIssue: boolean;
}

interface EdgeState {
  readonly raw: RawRecord | null;
  readonly index: number;
  id: string | null;
  from: CanvasEndpoint | null;
  to: CanvasEndpoint | null;
  hasOwnIssue: boolean;
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: RawRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isNodeType(value: unknown): value is NodeType {
  return isCanvasNodeType(value);
}

function makeIssue(
  code: CanvasSchemaIssueCode,
  path: string,
  message: string,
  location: { readonly node?: NodeState; readonly edge?: EdgeState } = {},
): CanvasSchemaIssue {
  const { node, edge } = location;
  return {
    code,
    path,
    message,
    ...(node === undefined
      ? {}
      : { nodeIndex: node.index, ...(node.id === null ? {} : { nodeId: node.id }) }),
    ...(edge === undefined
      ? {}
      : { edgeIndex: edge.index, ...(edge.id === null ? {} : { edgeId: edge.id }) }),
  };
}

function defaultPorts(): readonly CanvasPort[] {
  return [
    { id: 'in', dir: 'in' },
    { id: 'out', dir: 'out' },
  ];
}

function inspectPorts(
  raw: readonly unknown[],
  node: NodeState,
  issues: CanvasSchemaIssue[],
): readonly CanvasPort[] {
  if (raw.length === 0) {
    issues.push(
      makeIssue('E_SCHEMA_FIELD', `/nodes/${node.index}/ports`, '显式 ports 必须是非空数组', { node }),
    );
    return [];
  }

  const ports: CanvasPort[] = [];
  const ids = new Set<string>();
  for (const [portIndex, value] of raw.entries()) {
    const path = `/nodes/${node.index}/ports/${portIndex}`;
    if (!isRecord(value)) {
      issues.push(makeIssue('E_SCHEMA_FIELD', path, '端口必须是对象', { node }));
      continue;
    }

    let valid = true;
    const id = nonEmptyString(value.id);
    if (id === null) {
      issues.push(makeIssue('E_SCHEMA_FIELD', `${path}/id`, '端口 id 必须是非空字符串', { node }));
      valid = false;
    } else if (ids.has(id)) {
      issues.push(makeIssue('E_SCHEMA_ID_DUP', `${path}/id`, `节点内端口 id 重复：${id}`, { node }));
      valid = false;
    } else {
      ids.add(id);
    }

    const dir = value.dir;
    if (dir !== 'in' && dir !== 'out') {
      issues.push(makeIssue('E_SCHEMA_PORT_DIR', `${path}/dir`, '端口 dir 必须是 in 或 out', { node }));
      valid = false;
    }
    if (hasOwn(value, 'name') && typeof value.name !== 'string') {
      issues.push(makeIssue('E_SCHEMA_FIELD', `${path}/name`, '端口 name 若存在必须是字符串', { node }));
      valid = false;
    }

    if (valid && id !== null && (dir === 'in' || dir === 'out')) {
      ports.push({ ...value, id, dir });
    }
  }
  return ports;
}

function inspectNode(value: unknown, index: number, issues: CanvasSchemaIssue[]): NodeState {
  const state: NodeState = {
    raw: isRecord(value) ? value : null,
    index,
    id: null,
    x: null,
    y: null,
    type: null,
    ports: [],
    hasOwnIssue: false,
  };
  const issueStart = issues.length;
  if (state.raw === null) {
    issues.push(makeIssue('E_SCHEMA_FIELD', `/nodes/${index}`, '节点必须是对象', { node: state }));
    state.hasOwnIssue = true;
    return state;
  }
  const raw = state.raw;

  const id = nonEmptyString(raw.id);
  state.id = id;
  if (id === null) {
    issues.push(makeIssue('E_SCHEMA_FIELD', `/nodes/${index}/id`, '节点 id 必须是非空字符串', { node: state }));
  }
  const x = finiteNumber(raw.x);
  if (x === null) {
    issues.push(makeIssue('E_SCHEMA_FIELD', `/nodes/${index}/x`, '节点 x 必须是有限数', { node: state }));
  }
  const y = finiteNumber(raw.y);
  if (y === null) {
    issues.push(makeIssue('E_SCHEMA_FIELD', `/nodes/${index}/y`, '节点 y 必须是有限数', { node: state }));
  }

  let type: NodeType | null = null;
  if (!hasOwn(raw, 'type')) {
    type = 'text';
  } else if (isNodeType(raw.type)) {
    type = raw.type;
  } else {
    issues.push(makeIssue('E_SCHEMA_FIELD', `/nodes/${index}/type`, '节点 type 非法', { node: state }));
  }

  let ports: readonly CanvasPort[] = [];
  if (!hasOwn(raw, 'ports')) {
    ports = defaultPorts();
  } else if (!Array.isArray(raw.ports)) {
    issues.push(makeIssue('E_SCHEMA_FIELD', `/nodes/${index}/ports`, '显式 ports 必须是非空数组', { node: state }));
  } else {
    ports = inspectPorts(raw.ports, state, issues);
  }

  if (hasOwn(raw, 'label') && typeof raw.label !== 'string') {
    issues.push(makeIssue('E_SCHEMA_FIELD', `/nodes/${index}/label`, '节点 label 若存在必须是字符串', { node: state }));
  }
  if (hasOwn(raw, 'parentId') && nonEmptyString(raw.parentId) === null) {
    issues.push(
      makeIssue('E_SCHEMA_FIELD', `/nodes/${index}/parentId`, 'parentId 若存在必须是非空字符串', { node: state }),
    );
  }
  for (const key of ['w', 'h'] as const) {
    if (!hasOwn(raw, key)) continue;
    const dimension = finiteNumber(raw[key]);
    if (dimension === null || dimension <= 0 || dimension > MAX_NODE_DIMENSION) {
      issues.push(
        makeIssue(
          'E_SCHEMA_FIELD',
          `/nodes/${index}/${key}`,
          `节点 ${key} 必须是 (0, ${MAX_NODE_DIMENSION}] 的有限数`,
          { node: state },
        ),
      );
    }
  }

  if (hasOwn(raw, 'docId')) {
    issues.push(makeIssue('E_SCHEMA_PATH_REF', `/nodes/${index}/docId`, 'v2 节点禁止携带 docId', { node: state }));
  }
  if (type === 'document') {
    if (!hasOwn(raw, 'docPath')) {
      issues.push(
        makeIssue('E_SCHEMA_PATH_REF', `/nodes/${index}/docPath`, 'document 节点必须携带 docPath', { node: state }),
      );
    } else if (nonEmptyString(raw.docPath) === null) {
      issues.push(
        makeIssue('E_SCHEMA_FIELD', `/nodes/${index}/docPath`, 'document 节点的 docPath 必须是非空字符串', {
          node: state,
        }),
      );
    }
  } else if (hasOwn(raw, 'docPath')) {
    issues.push(
      makeIssue('E_SCHEMA_PATH_REF', `/nodes/${index}/docPath`, '非 document 节点禁止携带 docPath', { node: state }),
    );
  }

  if (type === 'media' && raw.kind !== 'image' && raw.kind !== 'audio' && raw.kind !== 'video') {
    issues.push(makeIssue('E_SCHEMA_FIELD', `/nodes/${index}/kind`, 'media 节点 kind 非法', { node: state }));
  }
  // CR-20261121-53：ai.model / prompt.text 类型专属字段——形状校验 + 禁止跨类型携带。
  if (type === 'ai' && hasOwn(raw, 'model') && typeof raw.model !== 'string') {
    issues.push(
      makeIssue('E_SCHEMA_FIELD', `/nodes/${index}/model`, 'ai 节点 model 若存在必须是字符串', { node: state }),
    );
  }
  if (type !== 'ai' && hasOwn(raw, 'model')) {
    issues.push(makeIssue('E_SCHEMA_FIELD', `/nodes/${index}/model`, '非 ai 节点禁止携带 model', { node: state }));
  }
  if (type === 'prompt' && hasOwn(raw, 'text') && typeof raw.text !== 'string') {
    issues.push(
      makeIssue('E_SCHEMA_FIELD', `/nodes/${index}/text`, 'prompt 节点 text 若存在必须是字符串', { node: state }),
    );
  }
  if (type !== 'prompt' && hasOwn(raw, 'text')) {
    issues.push(makeIssue('E_SCHEMA_FIELD', `/nodes/${index}/text`, '非 prompt 节点禁止携带 text', { node: state }));
  }
  if (type === 'group' && hasOwn(raw, 'parentId')) {
    issues.push(makeIssue('E_SCHEMA_GROUP', `/nodes/${index}/parentId`, '组不得嵌套', { node: state }));
  }

  state.id = id;
  state.x = x;
  state.y = y;
  state.type = type;
  state.ports = ports;
  state.hasOwnIssue = issues.length !== issueStart;
  return state;
}

function projectNode(state: NodeState): CanvasNode | null {
  if (
    state.raw === null ||
    state.hasOwnIssue ||
    state.id === null ||
    state.x === null ||
    state.y === null ||
    state.type === null
  ) {
    return null;
  }

  // 各判别字段及保留字段均已在 inspectNode 中逐项校验。
  return {
    ...state.raw,
    id: state.id,
    x: state.x,
    y: state.y,
    type: state.type,
    ports: state.ports,
  } as CanvasNode;
}

function inspectEndpoint(
  value: unknown,
  path: string,
  fallbackPortId: CanvasPortDirection,
  edge: EdgeState,
  issues: CanvasSchemaIssue[],
): CanvasEndpoint | null {
  if (!isRecord(value)) {
    issues.push(makeIssue('E_SCHEMA_FIELD', path, '连线端点必须是对象', { edge }));
    return null;
  }

  let valid = true;
  const nodeId = nonEmptyString(value.nodeId);
  if (nodeId === null) {
    issues.push(makeIssue('E_SCHEMA_FIELD', `${path}/nodeId`, '端点 nodeId 必须是非空字符串', { edge }));
    valid = false;
  }

  let portId: string | null;
  if (!hasOwn(value, 'portId')) {
    portId = fallbackPortId;
  } else {
    portId = nonEmptyString(value.portId);
    if (portId === null) {
      issues.push(makeIssue('E_SCHEMA_FIELD', `${path}/portId`, '显式 portId 必须是非空字符串', { edge }));
      valid = false;
    }
  }

  return valid && nodeId !== null && portId !== null ? { ...value, nodeId, portId } : null;
}

function inspectEdge(value: unknown, index: number, issues: CanvasSchemaIssue[]): EdgeState {
  const state: EdgeState = {
    raw: isRecord(value) ? value : null,
    index,
    id: null,
    from: null,
    to: null,
    hasOwnIssue: false,
  };
  const issueStart = issues.length;
  if (state.raw === null) {
    issues.push(makeIssue('E_SCHEMA_FIELD', `/edges/${index}`, '连线必须是对象', { edge: state }));
    state.hasOwnIssue = true;
    return state;
  }
  const raw = state.raw;

  const id = nonEmptyString(raw.id);
  state.id = id;
  if (id === null) {
    issues.push(makeIssue('E_SCHEMA_FIELD', `/edges/${index}/id`, '连线 id 必须是非空字符串', { edge: state }));
  }
  const from = inspectEndpoint(raw.from, `/edges/${index}/from`, 'out', state, issues);
  const to = inspectEndpoint(raw.to, `/edges/${index}/to`, 'in', state, issues);
  if (hasOwn(raw, 'label') && typeof raw.label !== 'string') {
    issues.push(makeIssue('E_SCHEMA_FIELD', `/edges/${index}/label`, '连线 label 若存在必须是字符串', { edge: state }));
  }
  if (hasOwn(raw, 'flow') && typeof raw.flow !== 'string') {
    issues.push(makeIssue('E_SCHEMA_FIELD', `/edges/${index}/flow`, '连线 flow 若存在必须是字符串', { edge: state }));
  }

  state.id = id;
  state.from = from;
  state.to = to;
  state.hasOwnIssue = issues.length !== issueStart;
  return state;
}

function validateParentReferences(nodes: readonly NodeState[], issues: CanvasSchemaIssue[]): void {
  const firstById = new Map<string, NodeState>();
  for (const node of nodes) {
    if (node.id !== null && !node.hasOwnIssue && !firstById.has(node.id)) firstById.set(node.id, node);
  }

  for (const node of nodes) {
    if (node.raw === null || node.hasOwnIssue || !hasOwn(node.raw, 'parentId')) continue;
    const parentId = nonEmptyString(node.raw.parentId);
    if (parentId === null) continue;
    const parent = firstById.get(parentId);
    if (parent === undefined || parent.type !== 'group') {
      issues.push(
        makeIssue('E_SCHEMA_GROUP', `/nodes/${node.index}/parentId`, 'parentId 必须引用一个存在的 group', {
          node,
        }),
      );
      node.hasOwnIssue = true;
    }
  }
}

function portDirection(node: CanvasNode, portId: string): CanvasPortDirection | null {
  return node.ports.find((port) => port.id === portId)?.dir ?? null;
}

function validateEdgeReferences(
  edges: readonly EdgeState[],
  nodes: ReadonlyMap<string, CanvasNode>,
  issues: CanvasSchemaIssue[],
): void {
  const pairs = new Set<string>();
  for (const edge of edges) {
    if (edge.hasOwnIssue || edge.from === null || edge.to === null) continue;
    const { from, to } = edge;
    const path = `/edges/${edge.index}`;
    const fromNode = nodes.get(from.nodeId);
    const toNode = nodes.get(to.nodeId);
    let invalid = false;

    if (fromNode === undefined) {
      issues.push(makeIssue('E_SCHEMA_EDGE_REF', `${path}/from/nodeId`, '连线起点引用的节点不存在或非法', { edge }));
      invalid = true;
    }
    if (toNode === undefined) {
      issues.push(makeIssue('E_SCHEMA_EDGE_REF', `${path}/to/nodeId`, '连线终点引用的节点不存在或非法', { edge }));
      invalid = true;
    }
    if (invalid || fromNode === undefined || toNode === undefined) {
      edge.hasOwnIssue = true;
      continue;
    }

    if (fromNode.type === 'group') {
      issues.push(makeIssue('E_SCHEMA_GROUP', `${path}/from/nodeId`, '组不得参与连线', { edge }));
      invalid = true;
    }
    if (toNode.type === 'group') {
      issues.push(makeIssue('E_SCHEMA_GROUP', `${path}/to/nodeId`, '组不得参与连线', { edge }));
      invalid = true;
    }
    if (invalid) {
      edge.hasOwnIssue = true;
      continue;
    }

    const fromDirection = portDirection(fromNode, from.portId);
    const toDirection = portDirection(toNode, to.portId);
    if (fromDirection === null) {
      issues.push(makeIssue('E_SCHEMA_EDGE_REF', `${path}/from/portId`, '连线起点引用的端口不存在', { edge }));
      invalid = true;
    }
    if (toDirection === null) {
      issues.push(makeIssue('E_SCHEMA_EDGE_REF', `${path}/to/portId`, '连线终点引用的端口不存在', { edge }));
      invalid = true;
    }
    if (invalid || fromDirection === null || toDirection === null) {
      edge.hasOwnIssue = true;
      continue;
    }

    if (fromDirection !== 'out') {
      issues.push(makeIssue('E_SCHEMA_PORT_DIR', `${path}/from/portId`, '连线起点必须是 out 端口', { edge }));
      invalid = true;
    }
    if (toDirection !== 'in') {
      issues.push(makeIssue('E_SCHEMA_PORT_DIR', `${path}/to/portId`, '连线终点必须是 in 端口', { edge }));
      invalid = true;
    }
    if (invalid) {
      edge.hasOwnIssue = true;
      continue;
    }

    const pair = JSON.stringify([from.nodeId, from.portId, to.nodeId, to.portId]);
    if (pairs.has(pair)) {
      issues.push(makeIssue('E_SCHEMA_EDGE_REF', path, '完全相同的端口对不得重复连线', { edge }));
      edge.hasOwnIssue = true;
    } else {
      pairs.add(pair);
    }
  }
}

function projectEdge(state: EdgeState): CanvasEdge | null {
  if (state.raw === null || state.hasOwnIssue || state.id === null || state.from === null || state.to === null) {
    return null;
  }
  return { ...state.raw, id: state.id, from: state.from, to: state.to };
}

/** 唯一 schema 规则源：返回结构化 issues 与只做缺省规范化的渲染投影。 */
export function inspect(document: CanvasDocument): CanvasInspection {
  const issues: CanvasSchemaIssue[] = [];
  const nodeStates = document.nodes.map((node, index) => inspectNode(node, index, issues));

  const nodeIds = new Set<string>();
  for (const node of nodeStates) {
    if (node.id === null) continue;
    if (nodeIds.has(node.id)) {
      issues.push(
        makeIssue('E_SCHEMA_ID_DUP', `/nodes/${node.index}/id`, `节点 id 重复：${node.id}`, { node }),
      );
      node.hasOwnIssue = true;
    } else {
      nodeIds.add(node.id);
    }
  }

  validateParentReferences(nodeStates, issues);

  const nodes: CanvasNode[] = [];
  const nodesById = new Map<string, CanvasNode>();
  for (const state of nodeStates) {
    const node = projectNode(state);
    if (node === null) continue;
    nodes.push(node);
    if (!nodesById.has(node.id)) nodesById.set(node.id, node);
  }

  const edgeStates = document.edges.map((edge, index) => inspectEdge(edge, index, issues));
  const edgeIds = new Set<string>();
  for (const edge of edgeStates) {
    if (edge.id === null) continue;
    if (edgeIds.has(edge.id)) {
      issues.push(makeIssue('E_SCHEMA_ID_DUP', `/edges/${edge.index}/id`, `连线 id 重复：${edge.id}`, { edge }));
      edge.hasOwnIssue = true;
    } else {
      edgeIds.add(edge.id);
    }
  }

  validateEdgeReferences(edgeStates, nodesById, issues);

  // 各规则全局执行，最终按条目索引稳定归并；同一条目内保留固定规则执行顺序。
  issues.sort((left, right) => {
    const leftKind = left.nodeIndex === undefined ? 1 : 0;
    const rightKind = right.nodeIndex === undefined ? 1 : 0;
    if (leftKind !== rightKind) return leftKind - rightKind;
    const leftIndex = left.nodeIndex ?? left.edgeIndex ?? -1;
    const rightIndex = right.nodeIndex ?? right.edgeIndex ?? -1;
    return leftIndex - rightIndex;
  });

  const edges = edgeStates.flatMap((state) => {
    const edge = projectEdge(state);
    return edge === null ? [] : [edge];
  });
  const projection: CanvasProjection = { nodes, edges };
  return { issues, projection };
}
