/**
 * CR-20261118-05 N1：节点可选 w/h 的格式层校验、变更与字节稳定性。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  inspect,
  mutate,
  type CanvasCommand,
  type CanvasDocument,
  type CanvasMutateResult,
} from '#canvas-format';
import {
  parseCanvasDocument,
  serializeCanvasDocument,
} from '../../../src/app/canvas/format.ts';

type MutateSuccess = Extract<CanvasMutateResult, { readonly ok: true }>;

function document(nodes: readonly unknown[]): CanvasDocument {
  return { schemaVersion: 3, nodes, edges: [] };
}

function succeed(result: CanvasMutateResult): MutateSuccess {
  if (!result.ok) assert.fail(`预期 mutate 成功，实际：${JSON.stringify(result)}`);
  return result;
}

function nodeAt(doc: CanvasDocument, index: number): Readonly<Record<string, unknown>> {
  const node = doc.nodes[index];
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    assert.fail(`第 ${index} 个节点不是对象`);
  }
  return node as Readonly<Record<string, unknown>>;
}

void test('inspect：显式 w/h 合法且投影原样保留，缺失不补字段', () => {
  const result = inspect(
    document([
      { id: 'sized', x: 0, y: 0, w: 120, h: 80 },
      { id: 'plain', x: 0, y: 0 },
      { id: 'only-w', x: 0, y: 0, w: 200 },
    ]),
  );
  assert.deepEqual(result.issues, []);
  const sized = result.projection.nodes[0];
  assert.equal(sized?.w, 120);
  assert.equal(sized?.h, 80);
  const plain = result.projection.nodes[1];
  assert.equal('w' in (plain ?? {}), false);
  assert.equal('h' in (plain ?? {}), false);
  const onlyW = result.projection.nodes[2];
  assert.equal(onlyW?.w, 200);
  assert.equal('h' in (onlyW ?? {}), false);
});

void test('inspect：w/h 为 0、负数、NaN、Infinity、超上限、非数字均报 E_SCHEMA_FIELD', () => {
  const invalidValues: readonly unknown[] = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 10001, '80'];
  for (const value of invalidValues) {
    const result = inspect(document([{ id: 'a', x: 0, y: 0, w: value }]));
    assert.deepEqual(
      result.issues.map((issue) => [issue.code, issue.path]),
      [['E_SCHEMA_FIELD', '/nodes/0/w']],
      `w=${String(value)}`,
    );
    assert.deepEqual(result.projection.nodes, []);
  }

  const height = inspect(document([{ id: 'a', x: 0, y: 0, h: -5 }]));
  assert.deepEqual(
    height.issues.map((issue) => [issue.code, issue.path]),
    [['E_SCHEMA_FIELD', '/nodes/0/h']],
  );
});

void test('updateNode 写入 w/h：inverse 用 null 删除，undo 字节与变更前一致', () => {
  const original = document([{ id: 'a', x: 0, y: 0, label: 'A' }]);
  const before = serializeCanvasDocument(original);
  const result = succeed(
    mutate(original, [{ kind: 'updateNode', id: 'a', changes: { w: 300, h: 200 } }]),
  );
  const node = nodeAt(result.document, 0);
  assert.equal(node.w, 300);
  assert.equal(node.h, 200);
  assert.deepEqual(result.inverse, [
    { kind: 'restoreNode', entry: original.nodes[0], index: 0 },
  ]);

  const undone = succeed(mutate(result.document, result.inverse));
  assert.equal(serializeCanvasDocument(undone.document), before);
});

void test('updateNode 用 null 清除 w/h：inverse 记录原值，往返字节一致', () => {
  const original = document([{ id: 'a', x: 0, y: 0, w: 300, h: 200 }]);
  const before = serializeCanvasDocument(original);
  const cleared = succeed(
    mutate(original, [{ kind: 'updateNode', id: 'a', changes: { w: null, h: null } }]),
  );
  const node = nodeAt(cleared.document, 0);
  assert.equal('w' in node, false);
  assert.equal('h' in node, false);
  assert.deepEqual(cleared.inverse, [
    { kind: 'restoreNode', entry: original.nodes[0], index: 0 },
  ]);

  const restored = succeed(mutate(cleared.document, cleared.inverse));
  assert.equal(serializeCanvasDocument(restored.document), before);
});

void test('updateNode 拒绝非法 w/h 与白名单外键，文档保持不变', () => {
  const original = document([{ id: 'a', x: 0, y: 0 }]);
  const before = serializeCanvasDocument(original);
  const invalidValues: readonly number[] = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 10001];
  for (const value of invalidValues) {
    const result = mutate(original, [
      { kind: 'updateNode', id: 'a', changes: { w: value } },
    ]);
    assert.equal(result.ok, false);
    if (result.ok || result.kind !== 'command') assert.fail('预期命令级失败');
    assert.deepEqual(
      result.errors.map((error) => [error.code, error.path]),
      [['E_MUTATE_COMMAND', '/commands/0/changes/w']],
      `w=${String(value)}`,
    );
  }

  const stringSize = {
    kind: 'updateNode',
    id: 'a',
    changes: { h: '80' },
  } as unknown as CanvasCommand;
  const stringResult = mutate(original, [stringSize]);
  assert.equal(stringResult.ok, false);
  if (stringResult.ok || stringResult.kind !== 'command') assert.fail('预期命令级失败');
  assert.deepEqual(
    stringResult.errors.map((error) => [error.code, error.path]),
    [['E_MUTATE_COMMAND', '/commands/0/changes/h']],
  );

  const unknownKey = {
    kind: 'updateNode',
    id: 'a',
    changes: { label: 'x', color: 'red' },
  } as unknown as CanvasCommand;
  const unknownResult = mutate(original, [unknownKey]);
  assert.equal(unknownResult.ok, false);
  if (unknownResult.ok || unknownResult.kind !== 'command') assert.fail('预期命令级失败');
  assert.deepEqual(
    unknownResult.errors.map((error) => [error.code, error.path]),
    [['E_MUTATE_COMMAND', '/commands/0/changes']],
  );

  const empty = mutate(original, [{ kind: 'updateNode', id: 'a', changes: {} }]);
  assert.equal(empty.ok, false);
  assert.equal(serializeCanvasDocument(original), before);
});

void test('旧文档无 w/h 往返字节不变；带 w/h 只保留显式字段；addNode 不补 w/h', () => {
  const legacy = {
    schemaVersion: 3,
    nodes: [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 10, y: 20, w: 160 },
    ],
    edges: [],
  } as CanvasDocument;
  const text = serializeCanvasDocument(legacy);
  const parsed = parseCanvasDocument(text);
  assert.equal(serializeCanvasDocument(parsed), text);
  assert.equal('h' in nodeAt(parsed, 1), false);

  const added = succeed(mutate(document([]), [{ kind: 'addNode', node: { id: 'n', x: 0, y: 0 } }]));
  const node = nodeAt(added.document, 0);
  assert.equal('w' in node, false);
  assert.equal('h' in node, false);
});
