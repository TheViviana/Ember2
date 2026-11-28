import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CANVAS_NODE_TYPES,
  inspect,
  isCanvasNodeType,
  type CanvasDocument,
  type CanvasSchemaIssueCode,
} from '#canvas-format';

function document(
  nodes: readonly unknown[] = [],
  edges: readonly unknown[] = [],
  extra: Readonly<Record<string, unknown>> = {},
): CanvasDocument {
  return { ...extra, schemaVersion: 3, nodes, edges };
}

function text(id: string, extra: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return { id, type: 'text', x: 0, y: 0, ...extra };
}

function edge(
  id: string,
  fromNodeId: string,
  toNodeId: string,
  extra: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    id,
    from: { nodeId: fromNodeId, portId: 'out' },
    to: { nodeId: toNodeId, portId: 'in' },
    ...extra,
  };
}

function issueCodes(value: CanvasDocument): readonly CanvasSchemaIssueCode[] {
  return inspect(value).issues.map((issue) => issue.code);
}

void test('CANVAS_NODE_TYPES：八种合法 type 全量且冻结', () => {
  assert.deepEqual([...CANVAS_NODE_TYPES], ['document', 'media', 'text', 'group', 'ai', 'prompt', 'split', 'merge']);
  assert.equal(Object.isFrozen(CANVAS_NODE_TYPES), true);
});

void test('isCanvasNodeType：8 合法通过、2 非法拒绝', () => {
  for (const type of CANVAS_NODE_TYPES) assert.equal(isCanvasNodeType(type), true);
  assert.equal(isCanvasNodeType('file'), false);
  assert.equal(isCanvasNodeType(null), false);
});

void test('inspect 归一化不变：缺 type→text，非法 type→E_SCHEMA_FIELD 并隔离', () => {
  const normalized = inspect(document([{ id: 'a', x: 0, y: 0 }]));
  assert.deepEqual(normalized.issues, []);
  assert.equal(normalized.projection.nodes[0]?.type, 'text');

  const invalid = inspect(document([{ id: 'b', type: 'file', x: 0, y: 0 }]));
  assert.deepEqual(
    invalid.issues.map((issue) => [issue.code, issue.path]),
    [['E_SCHEMA_FIELD', '/nodes/0/type']],
  );
  assert.deepEqual(invalid.projection.nodes, []);
});

void test('五类节点、media 四种 kind 与合法 group 引用均通过', () => {
  const value = document([
    { id: 'd', type: 'document', x: 0, y: 0, docPath: 'notes/a.md' },
    { id: 'i', type: 'media', kind: 'image', x: 1, y: 2 },
    { id: 'a', type: 'media', kind: 'audio', x: 1, y: 2 },
    { id: 'v', type: 'media', kind: 'video', x: 1, y: 2 },
    { id: 'm', type: 'media', kind: 'doc', x: 1, y: 2 },
    text('t'),
    { id: 'g', type: 'group', x: 0, y: 0 },
    text('child', { parentId: 'g' }),
    { id: 'ai', type: 'ai', x: 0, y: 0 },
  ]);

  const result = inspect(value);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.projection.nodes.map((node) => node.type), [
    'document',
    'media',
    'media',
    'media',
    'media',
    'text',
    'group',
    'text',
    'ai',
  ]);
  assert.equal(result.projection.nodes[7]?.parentId, 'g');
});

void test('旧 v2 缺 type/ports/portId 只规范化投影，不改原文且 label 不回退 id', () => {
  const value = document(
    [
      { id: 'a', label: '', x: 10, y: 20, custom: { kept: true } },
      { id: 'b', x: 30, y: 40 },
    ],
    [{ id: 'e', from: { nodeId: 'a' }, to: { nodeId: 'b' }, custom: true }],
  );

  const result = inspect(value);
  assert.deepEqual(result.issues, []);
  assert.equal(result.projection.nodes[0]?.type, 'text');
  assert.equal(result.projection.nodes[0]?.label, '');
  assert.deepEqual(result.projection.nodes[0]?.ports, [
    { id: 'in', dir: 'in' },
    { id: 'out', dir: 'out' },
  ]);
  assert.equal(result.projection.edges[0]?.from.portId, 'out');
  assert.equal(result.projection.edges[0]?.to.portId, 'in');
  assert.deepEqual(value.nodes[0], { id: 'a', label: '', x: 10, y: 20, custom: { kept: true } });
  assert.equal('ports' in (value.nodes[0] as object), false);
  assert.equal('portId' in ((value.edges[0] as { from: object }).from), false);
});

void test('显式非法 type/ports/portId 不触发兼容缺省', () => {
  const value = document(
    [
      { id: 'type', type: null, x: 0, y: 0 },
      { id: 'ports', type: 'text', ports: null, x: 0, y: 0 },
      { id: 'empty', type: 'text', ports: [], x: 0, y: 0 },
    ],
    [
      {
        id: 'e',
        from: { nodeId: 'type', portId: '' },
        to: { nodeId: 'empty', portId: null },
      },
    ],
  );

  const result = inspect(value);
  assert.deepEqual(
    result.issues.map((issue) => [issue.code, issue.path]),
    [
      ['E_SCHEMA_FIELD', '/nodes/0/type'],
      ['E_SCHEMA_FIELD', '/nodes/1/ports'],
      ['E_SCHEMA_FIELD', '/nodes/2/ports'],
      ['E_SCHEMA_FIELD', '/edges/0/from/portId'],
      ['E_SCHEMA_FIELD', '/edges/0/to/portId'],
    ],
  );
  assert.deepEqual(result.projection, { nodes: [], edges: [] });
});

void test('节点、连线及节点内端口 id 重复只隔离后出现项；节点与边可同 id', () => {
  const value = document(
    [
      text('same', { label: 'first' }),
      text('same', { label: 'second' }),
      {
        id: 'bad-ports',
        type: 'text',
        x: 0,
        y: 0,
        ports: [
          { id: 'p', dir: 'out' },
          { id: 'p', dir: 'in' },
        ],
      },
    ],
    [edge('same', 'same', 'same'), edge('same', 'same', 'same')],
  );

  const result = inspect(value);
  assert.deepEqual(
    result.issues.map((issue) => [issue.code, issue.path]),
    [
      ['E_SCHEMA_ID_DUP', '/nodes/1/id'],
      ['E_SCHEMA_ID_DUP', '/nodes/2/ports/1/id'],
      ['E_SCHEMA_ID_DUP', '/edges/1/id'],
    ],
  );
  assert.deepEqual(result.projection.nodes.map((node) => node.label), ['first']);
  assert.deepEqual(result.projection.edges.map((item) => item.id), ['same'], '首条合法自环保留');
});

void test('缺节点、缺端口与坏节点关联边均报 E_SCHEMA_EDGE_REF 并隔离', () => {
  const value = document(
    [text('a'), text('bad', { x: Number.NaN })],
    [
      edge('missing-node', 'a', 'absent'),
      edge('missing-port', 'a', 'a', { to: { nodeId: 'a', portId: 'absent' } }),
      edge('bad-node', 'bad', 'a'),
    ],
  );

  const result = inspect(value);
  assert.deepEqual(issueCodes(value), [
    'E_SCHEMA_FIELD',
    'E_SCHEMA_EDGE_REF',
    'E_SCHEMA_EDGE_REF',
    'E_SCHEMA_EDGE_REF',
  ]);
  assert.deepEqual(
    result.issues.slice(1).map((issue) => issue.path),
    ['/edges/0/to/nodeId', '/edges/1/to/portId', '/edges/2/from/nodeId'],
  );
  assert.deepEqual(result.projection.nodes.map((node) => node.id), ['a']);
  assert.deepEqual(result.projection.edges, []);
});

void test('组嵌套、组连线、parentId 错引用均报 E_SCHEMA_GROUP', () => {
  const value = document(
    [
      { id: 'outer', type: 'group', x: 0, y: 0 },
      { id: 'inner', type: 'group', parentId: 'outer', x: 0, y: 0 },
      text('missing', { parentId: 'absent' }),
      text('not-group', { parentId: 'plain' }),
      text('plain'),
    ],
    [edge('group-edge', 'outer', 'plain')],
  );

  const result = inspect(value);
  assert.deepEqual(
    result.issues.map((issue) => [issue.code, issue.path]),
    [
      ['E_SCHEMA_GROUP', '/nodes/1/parentId'],
      ['E_SCHEMA_GROUP', '/nodes/2/parentId'],
      ['E_SCHEMA_GROUP', '/nodes/3/parentId'],
      ['E_SCHEMA_GROUP', '/edges/0/from/nodeId'],
    ],
  );
  assert.deepEqual(result.projection.nodes.map((node) => node.id), ['outer', 'plain']);
  assert.deepEqual(result.projection.edges, []);
});

void test('document/docPath/docId 保留字段区分缺失、显式非法与禁止出现', () => {
  const value = document([
    { id: 'missing', type: 'document', x: 0, y: 0 },
    { id: 'empty', type: 'document', docPath: '', x: 0, y: 0 },
    { id: 'wrong', type: 'document', docPath: 42, x: 0, y: 0 },
    text('doc-id', { docId: '01ID' }),
    { id: 'both', type: 'document', docPath: 'a.md', docId: '01ID', x: 0, y: 0 },
    text('text-path', { docPath: 'a.md' }),
    { id: 'legacy-path', docPath: 'a.md', x: 0, y: 0 },
    text('undefined-id', { docId: undefined }),
  ]);

  const result = inspect(value);
  assert.deepEqual(
    result.issues.map((issue) => [issue.code, issue.path]),
    [
      ['E_SCHEMA_PATH_REF', '/nodes/0/docPath'],
      ['E_SCHEMA_FIELD', '/nodes/1/docPath'],
      ['E_SCHEMA_FIELD', '/nodes/2/docPath'],
      ['E_SCHEMA_PATH_REF', '/nodes/3/docId'],
      ['E_SCHEMA_PATH_REF', '/nodes/4/docId'],
      ['E_SCHEMA_PATH_REF', '/nodes/5/docPath'],
      ['E_SCHEMA_PATH_REF', '/nodes/6/docPath'],
      ['E_SCHEMA_PATH_REF', '/nodes/7/docId'],
    ],
  );
  assert.deepEqual(result.projection.nodes, []);
});

void test('字段类型、media kind、端口 dir/name 与边 label/flow 逐项校验', () => {
  const value = document(
    [
      { id: '', type: 'text', x: Infinity, y: '0', label: 1 },
      { id: 'media', type: 'media', kind: 'file', x: 0, y: 0 },
      {
        id: 'ports',
        type: 'text',
        x: 0,
        y: 0,
        ports: [
          { id: '', dir: 'sideways', name: 1 },
          42,
        ],
      },
    ],
    [{ id: 'e', from: null, to: 42, label: 1, flow: false }],
  );

  assert.deepEqual(issueCodes(value), [
    'E_SCHEMA_FIELD',
    'E_SCHEMA_FIELD',
    'E_SCHEMA_FIELD',
    'E_SCHEMA_FIELD',
    'E_SCHEMA_FIELD',
    'E_SCHEMA_FIELD',
    'E_SCHEMA_PORT_DIR',
    'E_SCHEMA_FIELD',
    'E_SCHEMA_FIELD',
    'E_SCHEMA_FIELD',
    'E_SCHEMA_FIELD',
    'E_SCHEMA_FIELD',
    'E_SCHEMA_FIELD',
  ]);
});

void test('坏条目只从投影隔离，合法节点与边及未知字段保留', () => {
  const value = document(
    [text('ok', { customNode: { kept: true } }), 42, text('bad', { y: '2' }), text('other')],
    [edge('ok-edge', 'ok', 'other', { customEdge: true }), 'bad-edge'],
    { customRoot: { kept: true } },
  );

  const result = inspect(value);
  assert.deepEqual(result.projection.nodes.map((node) => node.id), ['ok', 'other']);
  assert.deepEqual(result.projection.edges.map((item) => item.id), ['ok-edge']);
  assert.deepEqual(result.projection.nodes[0]?.customNode, { kept: true });
  assert.equal(result.projection.edges[0]?.customEdge, true);
  assert.deepEqual(value.nodes[1], 42);
  assert.deepEqual(value.edges[1], 'bad-edge');
  assert.deepEqual(value.customRoot, { kept: true });
});

void test('zoom 不参与校验，side 只是保留的未知扩展字段', () => {
  const value = document(
    [text('a', { side: 'custom', ports: [{ id: 'out', dir: 'out', side: 'right' }, { id: 'in', dir: 'in' }] })],
    [],
    { zoom: Number.NaN },
  );

  const result = inspect(value);
  assert.deepEqual(result.issues, []);
  assert.equal(result.projection.nodes[0]?.side, 'custom');
  assert.equal(result.projection.nodes[0]?.ports[0]?.side, 'right');
  assert.equal(result.projection.nodes[0]?.ports[0]?.dir, 'out');
});

void test('issues 按 nodes→edges、索引与固定规则顺序稳定生成并携带定位信息', () => {
  const value = document(
    [text('a', { label: 1 }), text('a', { x: 'bad' })],
    [edge('e', 'a', 'absent'), edge('e', 'a', 'a')],
  );

  const first = inspect(value);
  const second = inspect(value);
  assert.deepEqual(first, second);
  assert.deepEqual(first.issues.map((issue) => issue.path), [
    '/nodes/0/label',
    '/nodes/1/x',
    '/nodes/1/id',
    '/edges/0/from/nodeId',
    '/edges/0/to/nodeId',
    '/edges/1/id',
  ]);
  assert.equal(first.issues[0]?.nodeIndex, 0);
  assert.equal(first.issues[0]?.nodeId, 'a');
  assert.equal(first.issues[3]?.edgeIndex, 0);
  assert.equal(first.issues[3]?.edgeId, 'e');
});
