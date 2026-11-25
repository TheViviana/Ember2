import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect, validate, type CanvasDocument } from '#canvas-format';

function document(nodes: readonly unknown[], edges: readonly unknown[]): CanvasDocument {
  return { schemaVersion: 2, nodes, edges };
}

function text(id: string): Readonly<Record<string, unknown>> {
  return { id, x: 0, y: 0 };
}

function edge(id: string, fromNodeId: string, toNodeId: string): Readonly<Record<string, unknown>> {
  return { id, from: { nodeId: fromNodeId }, to: { nodeId: toNodeId } };
}

void test('validate 与 inspect 对同一语料返回完全一致 issues，valid 恒等于 issues 为空', () => {
  const corpus = [
    document([text('a'), text('b')], [edge('e', 'a', 'b')]),
    document([text('a'), text('a')], [edge('e', 'a', 'absent')]),
    document([{ id: 'd', type: 'document', x: 0, y: 0 }], []),
    document([{ id: 'm', type: 'media', kind: 'image', x: 0, y: 0 }], []),
  ];

  for (const value of corpus) {
    const inspection = inspect(value);
    const validation = validate(value);
    assert.deepEqual(validation.issues, inspection.issues);
    assert.equal(validation.valid, validation.issues.length === 0);
    assert.equal(validation.valid, inspection.issues.length === 0);
  }
});

void test('同一输出可分叉、同一输入可汇入，合法自环也放行', () => {
  const value = document(
    [text('a'), text('b'), text('c')],
    [
      edge('fan-out-1', 'a', 'b'),
      edge('fan-out-2', 'a', 'c'),
      edge('fan-in', 'c', 'b'),
      edge('self', 'a', 'a'),
    ],
  );

  assert.deepEqual(validate(value), { valid: true, issues: [] });
  assert.equal(inspect(value).projection.edges.length, 4);
});

void test('只有完全相同的 from/to 端口对重复才拒绝', () => {
  const duplicate = document(
    [text('a'), text('b')],
    [edge('first', 'a', 'b'), edge('second', 'a', 'b')],
  );
  const result = validate(duplicate);

  assert.equal(result.valid, false);
  assert.deepEqual(result.issues.map((issue) => [issue.code, issue.path]), [
    ['E_SCHEMA_EDGE_REF', '/edges/1'],
  ]);

  const differentPair = document(
    [text('a'), text('b'), text('c')],
    [edge('first', 'a', 'b'), edge('second', 'a', 'c')],
  );
  assert.equal(validate(differentPair).valid, true);
});

void test('in→out 反方向连线由同一规则源报 E_SCHEMA_PORT_DIR', () => {
  const value = document(
    [
      {
        id: 'a',
        x: 0,
        y: 0,
        ports: [
          { id: 'in', dir: 'in' },
          { id: 'out', dir: 'out' },
        ],
      },
    ],
    [{ id: 'reverse', from: { nodeId: 'a', portId: 'in' }, to: { nodeId: 'a', portId: 'out' } }],
  );

  const result = validate(value);
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues.map((issue) => [issue.code, issue.path]), [
    ['E_SCHEMA_PORT_DIR', '/edges/0/from/portId'],
    ['E_SCHEMA_PORT_DIR', '/edges/0/to/portId'],
  ]);
  assert.deepEqual(inspect(value).issues, result.issues);
});

void test('CR-20261121-53：prompt 节点与 ai.model 合法；跨类型携带与形状错误被拒', () => {
  const ok = document(
    [
      { id: 'p', type: 'prompt', x: 0, y: 0, text: '检测两篇文章的关联性' },
      { id: 'ai', type: 'ai', x: 1, y: 1 },
      { id: 'ai2', type: 'ai', x: 2, y: 2, model: 'qwen3:8b' },
      { id: 'p2', type: 'prompt', x: 3, y: 3 },
    ],
    [],
  );
  assert.deepEqual(validate(ok), { valid: true, issues: [] });

  const bad = document(
    [
      { id: 'p', type: 'prompt', x: 0, y: 0, text: 42 },
      { id: 't', type: 'text', x: 1, y: 1, text: '不该有' },
      { id: 'g', type: 'group', x: 2, y: 2, model: 'm' },
      { id: 'b', type: 'unknown-type', x: 3, y: 3 },
    ],
    [],
  );
  const result = validate(bad);
  assert.equal(result.valid, false);
  const paths = result.issues.map((issue) => issue.path);
  assert.ok(paths.includes('/nodes/0/text'), 'prompt.text 必须是字符串');
  assert.ok(paths.includes('/nodes/1/text'), '非 prompt 节点禁止携带 text');
  assert.ok(paths.includes('/nodes/2/model'), '非 ai 节点禁止携带 model');
  assert.ok(paths.includes('/nodes/3/type'), '未知 type 非法');
});
