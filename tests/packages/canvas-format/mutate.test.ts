import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  inspect,
  mutate,
  type CanvasCommand,
  type CanvasDocument,
  type CanvasEdgeInput,
  type CanvasMutateResult,
} from '#canvas-format';
import type { CanvasMoveCommand } from '../../../src/app/canvas/interaction.ts';

type MutateSuccess = Extract<CanvasMutateResult, { readonly ok: true }>;

function document(nodes: readonly unknown[] = [], edges: readonly unknown[] = []): CanvasDocument {
  return { schemaVersion: 2, nodes, edges, customRoot: { kept: true } };
}

function text(id: string, extra: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return { id, x: 0, y: 0, ...extra };
}

function edge(id: string, fromNodeId: string, toNodeId: string): CanvasEdgeInput {
  return { id, from: { nodeId: fromNodeId }, to: { nodeId: toNodeId } };
}

function succeed(result: CanvasMutateResult): MutateSuccess {
  if (!result.ok) assert.fail(`预期 mutate 成功，实际：${JSON.stringify(result)}`);
  return result;
}

void test('非空批次遇既有 issues 返回 kind:document；空批次不写文档', () => {
  const invalid = document([text('a', { label: 42 })]);
  const inspection = inspect(invalid);
  const rejected = mutate(invalid, [{ kind: 'updateNode', id: 'a', changes: { label: 'fixed' } }]);

  assert.deepEqual(rejected, { ok: false, kind: 'document', issues: inspection.issues });

  const empty = succeed(mutate(invalid, []));
  assert.equal(empty.document, invalid);
  assert.deepEqual(empty.inverse, []);
  assert.deepEqual(empty.inspection, inspection);
});

void test('命令形状非法返回 E_MUTATE_COMMAND，并钉住 commandIndex/path', () => {
  const original = document([text('a')]);
  const malformed = {
    kind: 'addNode',
    node: { id: 'b', x: 0 },
  } as unknown as CanvasCommand;
  const result = mutate(original, [{ kind: 'removeNode', id: 'a' }, malformed]);

  assert.equal(result.ok, false);
  if (result.ok || result.kind !== 'command') assert.fail('预期命令形状失败');
  assert.deepEqual(
    result.errors.map((error) => [error.commandIndex, error.code, error.path]),
    [[1, 'E_MUTATE_COMMAND', '/commands/1/node/y']],
  );
  assert.deepEqual(original.nodes, [{ id: 'a', x: 0, y: 0 }]);
});

void test('缺失目标统一返回 E_MUTATE_TARGET', () => {
  const commands: readonly CanvasCommand[] = [
    { kind: 'move', entries: [{ id: 'missing', dx: 1, dy: 2 }] },
    { kind: 'removeNode', id: 'missing' },
    { kind: 'removeEdge', id: 'missing' },
    { kind: 'updateNode', id: 'missing', changes: { label: 'x' } },
  ];

  for (const command of commands) {
    const result = mutate(document(), [command]);
    assert.equal(result.ok, false);
    if (result.ok || result.kind !== 'command') assert.fail('预期命令失败');
    assert.equal(result.errors[0]?.code, 'E_MUTATE_TARGET');
    assert.equal(result.errors[0]?.commandIndex, 0);
  }
});

void test('命令产生 schema issues 时原样映射 code/path，整批原子失败', () => {
  const original = document([text('a')]);
  const before = JSON.stringify(original);
  const result = mutate(original, [
    { kind: 'addNode', node: { id: 'b', x: 1, y: 2 } },
    { kind: 'updateNode', id: 'a', changes: { docPath: 'forbidden.md' } },
  ]);

  assert.equal(result.ok, false);
  if (result.ok || result.kind !== 'command') assert.fail('预期 schema 命令失败');
  assert.deepEqual(
    result.errors.map((error) => [error.commandIndex, error.code, error.path]),
    [[1, 'E_SCHEMA_PATH_REF', '/nodes/0/docPath']],
  );
  assert.equal(JSON.stringify(original), before, '第一条已应用命令也不得污染原文');
});

void test('addNode/addEdge 保持最小形状、显式扩展字段和未触碰对象引用', () => {
  const first = text('a', { custom: 'untouched' });
  const second = text('b');
  const original = document([first, second]);
  const node = { id: 'c', x: 8, y: 9, customNode: { kept: true } };
  const edgeInput = {
    id: 'new-edge',
    from: { nodeId: 'a' },
    to: { nodeId: 'c' },
    customEdge: { kept: true },
  };
  const commands: readonly CanvasCommand[] = [
    { kind: 'addNode', node, index: 1 },
    { kind: 'addEdge', edge: edgeInput },
  ];
  const result = succeed(mutate(original, commands));

  assert.equal(result.document.nodes[0], first);
  assert.equal(result.document.nodes[2], second);
  assert.deepEqual(result.document.nodes[1], node);
  assert.equal('type' in node, false);
  assert.equal('ports' in node, false);
  assert.equal('index' in node, false);
  assert.deepEqual(result.document.edges[0], edgeInput);
  assert.equal('portId' in edgeInput.from, false);
  assert.equal('portId' in edgeInput.to, false);
  assert.equal('index' in edgeInput, false);
  assert.equal(result.document.customRoot, original.customRoot);
  assert.deepEqual(result.inspection, inspect(result.document));
  assert.equal(result.inspection.projection.nodes[1]?.type, 'text');
  assert.equal(result.inspection.projection.edges[0]?.from.portId, 'out');
  assert.deepEqual(result.inverse.map((command) => command.kind), ['removeEdge', 'removeNode']);

  const undone = succeed(mutate(result.document, result.inverse));
  assert.deepEqual(undone.document, original);
  const redone = succeed(mutate(undone.document, commands));
  assert.deepEqual(redone.document, result.document);
  assert.deepEqual(redone.document.nodes[1], node);
  assert.deepEqual(redone.document.edges[0], edgeInput);
});

void test('move 与既有 CanvasMoveCommand 同形，inverse 同序反向 delta', () => {
  const original = document([text('a', { x: 10, y: 20 }), text('b', { x: -5, y: 7 })]);
  const legacy: CanvasMoveCommand = {
    kind: 'move',
    entries: [
      { id: 'a', dx: 5, dy: -2 },
      { id: 'b', dx: 0, dy: 3 },
    ],
  };
  const result = succeed(mutate(original, [legacy]));

  assert.deepEqual(
    result.document.nodes.map((node) => (node as { x: number; y: number }).x),
    [15, -5],
  );
  assert.deepEqual(
    result.document.nodes.map((node) => (node as { x: number; y: number }).y),
    [18, 10],
  );
  assert.deepEqual(result.inverse, [
    {
      kind: 'move',
      entries: [
        { id: 'a', dx: -5, dy: 2 },
        { id: 'b', dx: -0, dy: -3 },
      ],
    },
  ]);

  const undone = succeed(mutate(result.document, result.inverse));
  assert.deepEqual(undone.document, original);
  const redone = succeed(mutate(undone.document, [legacy]));
  assert.deepEqual(redone.document, result.document);
});

void test('removeNode 级联多边，inverse 按 node→edges 恢复原顺序与完整字段', () => {
  const original = document(
    [text('before'), text('target', { customNode: { kept: true } }), text('after')],
    [
      { ...edge('e0', 'before', 'target'), custom0: true },
      { ...edge('keep', 'before', 'after'), customKeep: true },
      { ...edge('e2', 'target', 'after'), custom2: { kept: true } },
      { ...edge('e3', 'after', 'target'), custom3: true },
    ],
  );
  const result = succeed(mutate(original, [{ kind: 'removeNode', id: 'target' }]));

  assert.deepEqual(result.document.nodes.map((node) => (node as { id: string }).id), ['before', 'after']);
  assert.deepEqual(result.document.edges.map((item) => (item as { id: string }).id), ['keep']);
  assert.deepEqual(result.inverse.map((command) => command.kind), ['restoreNode', 'addEdge', 'addEdge', 'addEdge']);
  assert.deepEqual(result.inverse[0], {
    kind: 'restoreNode',
    entry: original.nodes[1],
    index: 1,
  });
  assert.deepEqual(
    result.inverse.slice(1).map((command) => (command as { edge: unknown; index: number }).index),
    [0, 2, 3],
  );
  assert.deepEqual(result.inverse[1], { kind: 'addEdge', edge: original.edges[0], index: 0 });
  assert.deepEqual(result.inverse[2], { kind: 'addEdge', edge: original.edges[2], index: 2 });
  assert.deepEqual(result.inverse[3], { kind: 'addEdge', edge: original.edges[3], index: 3 });

  const undone = succeed(mutate(result.document, result.inverse));
  assert.deepEqual(undone.document, original);
});

void test('removeEdge inverse 恢复原边、完整字段和数组位置', () => {
  const original = document(
    [text('a'), text('b')],
    [edge('e0', 'a', 'b'), { ...edge('e1', 'b', 'a'), custom: true }, edge('e2', 'a', 'a')],
  );
  const result = succeed(mutate(original, [{ kind: 'removeEdge', id: 'e1' }]));

  assert.deepEqual(result.document.edges, [original.edges[0], original.edges[2]]);
  assert.deepEqual(result.inverse, [{ kind: 'addEdge', edge: original.edges[1], index: 1 }]);
  const undone = succeed(mutate(result.document, result.inverse));
  assert.deepEqual(undone.document, original);
});

void test('updateNode inverse 区分字段原缺失与原空串，并恢复字段存在性', () => {
  const missing = document([text('a', { custom: true })]);
  const addedEmpty = succeed(mutate(missing, [{ kind: 'updateNode', id: 'a', changes: { label: '' } }]));
  assert.deepEqual(addedEmpty.inverse, [{ kind: 'restoreNode', entry: missing.nodes[0], index: 0 }]);
  assert.equal(Object.hasOwn(addedEmpty.document.nodes[0] as object, 'label'), true);
  const removed = succeed(mutate(addedEmpty.document, addedEmpty.inverse));
  assert.equal(Object.hasOwn(removed.document.nodes[0] as object, 'label'), false);
  assert.deepEqual(removed.document, missing);

  const empty = document([text('a', { label: '' })]);
  const filled = succeed(mutate(empty, [{ kind: 'updateNode', id: 'a', changes: { label: 'filled' } }]));
  assert.deepEqual(filled.inverse, [{ kind: 'restoreNode', entry: empty.nodes[0], index: 0 }]);
  const restored = succeed(mutate(filled.document, filled.inverse));
  assert.deepEqual(restored.document, empty);
  assert.equal((restored.document.nodes[0] as { label: string }).label, '');
});

void test('updateNode 只开放 label/docPath；非法路径更新由 inspection 拒绝', () => {
  const extra = {
    kind: 'updateNode',
    id: 'a',
    changes: { label: 'ok', x: 99 },
  } as unknown as CanvasCommand;
  const extraResult = mutate(document([text('a')]), [extra]);
  assert.equal(extraResult.ok, false);
  if (extraResult.ok || extraResult.kind !== 'command') assert.fail('预期命令形状失败');
  assert.equal(extraResult.errors[0]?.code, 'E_MUTATE_COMMAND');
  assert.equal(extraResult.errors[0]?.path, '/commands/0/changes');

  const documentNode = document([{ id: 'd', type: 'document', x: 0, y: 0, docPath: 'a.md' }]);
  const removedPath = mutate(documentNode, [{ kind: 'updateNode', id: 'd', changes: { docPath: null } }]);
  assert.equal(removedPath.ok, false);
  if (removedPath.ok || removedPath.kind !== 'command') assert.fail('预期路径规则失败');
  assert.deepEqual(
    removedPath.errors.map((error) => [error.code, error.path]),
    [['E_SCHEMA_PATH_REF', '/nodes/0/docPath']],
  );
});

void test('批处理 inverse 整批逆序，undo 直接重放 inverse、redo 重放原命令', () => {
  const original = document([text('a')]);
  const commands: readonly CanvasCommand[] = [
    { kind: 'addNode', node: { id: 'b', x: 5, y: 6 } },
    { kind: 'addEdge', edge: edge('e', 'a', 'b') },
    { kind: 'updateNode', id: 'a', changes: { label: 'A' } },
    { kind: 'move', entries: [{ id: 'b', dx: 2, dy: -1 }] },
  ];
  const result = succeed(mutate(original, commands));

  assert.deepEqual(result.inverse.map((command) => command.kind), [
    'move',
    'restoreNode',
    'removeEdge',
    'removeNode',
  ]);
  const undone = succeed(mutate(result.document, result.inverse));
  assert.deepEqual(undone.document, original);
  const redone = succeed(mutate(undone.document, commands));
  assert.deepEqual(redone.document, result.document);
});

void test('CR-20261121-53：updateNode 接受 text/model，null 删除字段，未知键仍被拒', () => {
  const original = document([text('p', { type: 'prompt' }), text('ai', { type: 'ai' })]);
  const result = succeed(
    mutate(original, [
      { kind: 'updateNode', id: 'p', changes: { text: '汇总要点' } },
      { kind: 'updateNode', id: 'ai', changes: { model: 'qwen3:8b' } },
    ]),
  );
  const nodes = result.document.nodes as readonly Readonly<Record<string, unknown>>[];
  assert.equal(nodes[0]?.text, '汇总要点');
  assert.equal(nodes[1]?.model, 'qwen3:8b');

  const cleared = succeed(
    mutate(result.document, [
      { kind: 'updateNode', id: 'p', changes: { text: null } },
      { kind: 'updateNode', id: 'ai', changes: { model: null } },
    ]),
  );
  const clearedNodes = cleared.document.nodes as readonly Readonly<Record<string, unknown>>[];
  assert.equal('text' in (clearedNodes[0] ?? {}), false, 'null 删除 text 字段');
  assert.equal('model' in (clearedNodes[1] ?? {}), false, 'null 删除 model 字段');

  const badChanges = { color: 'red' } as unknown as { label: string };
  const rejected = mutate(original, [{ kind: 'updateNode', id: 'p', changes: badChanges }]);
  assert.equal(rejected.ok, false, '夹带未知键仍被拒');
});
