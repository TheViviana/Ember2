/**
 * 跨层组合说明：package 只产生无损原文/投影/命令；这里把其结果交给既有
 * app serializer，验证 C0-B 接线前的真实序列化消费者能保持字节稳定。
 * tests 侧只读导入 src 合法，package 自身不反向依赖 app。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as canvasFormat from '#canvas-format';
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

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value) as unknown[]) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function succeed(result: CanvasMutateResult): MutateSuccess {
  if (!result.ok) assert.fail(`预期 mutate 成功，实际：${JSON.stringify(result)}`);
  return result;
}

function document(nodes: readonly unknown[], edges: readonly unknown[]): CanvasDocument {
  return {
    schemaVersion: 3,
    nodes,
    edges,
    lastOrigin: { x: 17, y: -29 },
    customRoot: { kept: true },
  };
}

void test('深冻结坏文档：inspect/R8 拒绝写均不改字节，serializer 二次保存稳定', () => {
  const original = deepFreeze(document(
    [
      { id: 'ok', label: '', x: 1, y: 2, customNode: { kept: true } },
      { id: 'bad', x: '1', y: 2, customBad: true },
      42,
    ],
    [
      { id: 'bad-edge', from: { nodeId: 'bad' }, to: { nodeId: 'ok' }, customEdge: true },
      'broken',
    ],
  ));
  assert.equal(Object.isFrozen(original.nodes), true);
  assert.equal(Object.isFrozen(original.nodes[0]), true);
  assert.equal(Object.isFrozen(original.customRoot), true);
  const before = serializeCanvasDocument(original);

  const inspection = inspect(original);
  assert.ok(inspection.issues.length > 0);
  assert.deepEqual(inspection.projection.nodes.map((node) => node.id), ['ok']);
  assert.equal(inspection.projection.nodes[0]?.label, '', 'package 不复制 app 的 label 缺省回退');
  assert.deepEqual(inspection.projection.edges, []);
  assert.equal(serializeCanvasDocument(original), before);

  const rejected = mutate(original, [{ kind: 'removeNode', id: 'ok' }]);
  assert.equal(rejected.ok, false);
  if (rejected.ok || rejected.kind !== 'document') assert.fail('R8 必须拒绝含既有 issues 的非空批次');
  assert.deepEqual(rejected.issues, inspection.issues);
  assert.equal(serializeCanvasDocument(original), before);
  assert.equal(serializeCanvasDocument(parseCanvasDocument(before)), before);
});

void test('深冻结原文下批量 mutate：未触碰引用、顶层字段、undo/redo 与字节全部稳定', () => {
  const untouchedNode = { id: 'b', x: 10, y: 10, customNode: { kept: true } };
  const untouchedEdge = {
    id: 'e0',
    from: { nodeId: 'a' },
    to: { nodeId: 'b' },
    customEdge: { kept: true },
  };
  const original = deepFreeze(document(
    [{ id: 'a', label: 'A', x: 0, y: 0, customA: true }, untouchedNode],
    [untouchedEdge],
  ));
  const before = serializeCanvasDocument(original);
  const commands = deepFreeze<readonly CanvasCommand[]>([
    { kind: 'move', entries: [{ id: 'a', dx: 5, dy: -2 }] },
    { kind: 'updateNode', id: 'a', changes: { label: 'B' } },
    { kind: 'addNode', node: { id: 'c', x: 20, y: 30, customC: true }, index: 1 },
    { kind: 'addEdge', edge: { id: 'e1', from: { nodeId: 'c' }, to: { nodeId: 'b' }, customE1: true } },
  ]);

  const forward = succeed(mutate(original, commands));
  assert.equal(serializeCanvasDocument(original), before, '输入原文深冻结且序列化字节不变');
  assert.equal(forward.document.nodes[2], untouchedNode);
  assert.equal(forward.document.edges[0], untouchedEdge);
  assert.equal(forward.document.customRoot, original.customRoot);
  assert.equal(forward.document.lastOrigin, original.lastOrigin);
  const forwardText = serializeCanvasDocument(forward.document);
  assert.equal(serializeCanvasDocument(parseCanvasDocument(forwardText)), forwardText);

  const undone = succeed(mutate(forward.document, forward.inverse));
  assert.equal(serializeCanvasDocument(undone.document), before, '整批 inverse 直接 undo 恢复原字节');
  const redone = succeed(mutate(undone.document, commands));
  assert.equal(serializeCanvasDocument(redone.document), forwardText, '原序 redo 恢复相同字段集与字节');
});

void test('removeNode 级联 inverse 在深冻结快照下恢复原始字节', () => {
  const original = deepFreeze(document(
    [
      { id: 'a', x: 0, y: 0 },
      { id: 'target', x: 1, y: 1, customNode: { kept: true } },
      { id: 'b', x: 2, y: 2 },
    ],
    [
      { id: 'e0', from: { nodeId: 'a' }, to: { nodeId: 'target' }, custom0: true },
      { id: 'keep', from: { nodeId: 'a' }, to: { nodeId: 'b' }, customKeep: true },
      { id: 'e2', from: { nodeId: 'target' }, to: { nodeId: 'b' }, custom2: true },
    ],
  ));
  const before = serializeCanvasDocument(original);
  const commands: readonly CanvasCommand[] = [{ kind: 'removeNode', id: 'target' }];

  const forward = succeed(mutate(original, commands));
  const forwardText = serializeCanvasDocument(forward.document);
  const undone = succeed(mutate(forward.document, forward.inverse));
  assert.equal(serializeCanvasDocument(undone.document), before);
  assert.equal(undone.document.nodes[1], original.nodes[1]);
  assert.equal(undone.document.edges[0], original.edges[0]);
  assert.equal(undone.document.edges[2], original.edges[2]);
  const redone = succeed(mutate(undone.document, commands));
  assert.equal(serializeCanvasDocument(redone.document), forwardText);
});

void test('updateNode 新增后删除的 inverse 恢复原字段集与字节', () => {
  const original = deepFreeze(document([{ id: 'a', x: 0, y: 0, custom: true }], []));
  const before = serializeCanvasDocument(original);
  const commands: readonly CanvasCommand[] = [{ kind: 'updateNode', id: 'a', changes: { label: '' } }];

  const forward = succeed(mutate(original, commands));
  const forwardText = serializeCanvasDocument(forward.document);
  const undone = succeed(mutate(forward.document, forward.inverse));
  assert.equal(Object.hasOwn(undone.document.nodes[0] as object, 'label'), false);
  assert.equal(serializeCanvasDocument(undone.document), before);
  const redone = succeed(mutate(undone.document, commands));
  assert.equal(serializeCanvasDocument(redone.document), forwardText);
});

void test('updateNode 清除非末位 label：restoreNode 恢复键序且 redo 字节一致', () => {
  const original = deepFreeze(document([{ id: 'a', label: 'A', x: 1, y: 2 }], []));
  const before = serializeCanvasDocument(original);
  const commands: readonly CanvasCommand[] = [
    { kind: 'updateNode', id: 'a', changes: { label: null } },
  ];

  const forward = succeed(mutate(original, commands));
  const forwardText = serializeCanvasDocument(forward.document);
  assert.deepEqual(forward.inverse, [{ kind: 'restoreNode', entry: original.nodes[0], index: 0 }]);
  const undone = succeed(mutate(forward.document, forward.inverse));
  assert.equal(undone.document.nodes[0], original.nodes[0]);
  assert.equal(serializeCanvasDocument(undone.document), before);
  const redone = succeed(mutate(undone.document, commands));
  assert.equal(serializeCanvasDocument(redone.document), forwardText);
});

void test('updateNode 仅清除非末位 w：restoreNode 恢复键序且 redo 字节一致', () => {
  const original = deepFreeze(document([{ id: 'a', x: 1, y: 2, w: 160, h: 96 }], []));
  const before = serializeCanvasDocument(original);
  const commands: readonly CanvasCommand[] = [
    { kind: 'updateNode', id: 'a', changes: { w: null } },
  ];

  const forward = succeed(mutate(original, commands));
  const forwardText = serializeCanvasDocument(forward.document);
  assert.deepEqual(forward.inverse, [{ kind: 'restoreNode', entry: original.nodes[0], index: 0 }]);
  const undone = succeed(mutate(forward.document, forward.inverse));
  assert.equal(undone.document.nodes[0], original.nodes[0]);
  assert.equal(serializeCanvasDocument(undone.document), before);
  const redone = succeed(mutate(undone.document, commands));
  assert.equal(serializeCanvasDocument(redone.document), forwardText);
});

void test('公共入口不暴露 v1 upgrade 或 side 模型 API', () => {
  assert.equal('upgrade' in canvasFormat, false);
  assert.equal('side' in canvasFormat, false);
  assert.equal(canvasFormat.CANVAS_SCHEMA_VERSION, 3);
});
