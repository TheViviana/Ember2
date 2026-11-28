/**
 * C0-B B4：app 适配层必须复用 #canvas-format 的唯一规则源。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanvasDocument } from '../../../src/app/canvas/format.ts';
import {
  applyCanvasCommands,
  inspectCanvasDocument,
  validateCanvasDocument,
} from '../../../src/app/canvas/schema-adapter.ts';

function validDocument(): CanvasDocument {
  return {
    schemaVersion: 3,
    nodes: [
      { id: 'a', label: 'A', x: 0, y: 0 },
      { id: 'b', label: 'B', x: 100, y: 0 },
    ],
    edges: [
      { id: 'e1', from: { nodeId: 'a' }, to: { nodeId: 'b' } },
    ],
  };
}

void test('合法文档：无 issues、不锁写，投影补默认 type/ports/portId', () => {
  const state = inspectCanvasDocument(validDocument());
  assert.deepEqual(state.issues, []);
  assert.equal(state.readOnly, false);

  const [node] = state.projection.nodes;
  assert.equal(node?.type, 'text');
  assert.deepEqual(
    node?.ports.map((port) => port.id),
    ['in', 'out'],
  );
  const [edge] = state.projection.edges;
  assert.equal(edge?.from.portId, 'out');
  assert.equal(edge?.to.portId, 'in');
});

void test('非法条目：issues 与 readOnly 同源，投影隔离但原文不变', () => {
  const document: CanvasDocument = {
    schemaVersion: 3,
    nodes: [
      { id: 'a', label: 'A', x: 0, y: 0 },
      { id: 'bad', label: 'Bad', x: 'nope', y: 0 },
    ],
    edges: [],
  };
  const state = inspectCanvasDocument(document);
  assert.equal(state.readOnly, true);
  assert.ok(state.issues.length >= 1);
  assert.deepEqual(
    state.projection.nodes.map((node) => node.id),
    ['a'],
  );
  // 原文（含坏条目）不被投影过滤改写。
  assert.equal(document.nodes.length, 2);
});

void test('validate 包装同一 inspection：issues 深相等且 valid === (issues.length === 0)', () => {
  for (const document of [validDocument(), { ...validDocument(), nodes: [] }]) {
    const validation = validateCanvasDocument(document);
    const state = inspectCanvasDocument(document);
    assert.deepEqual(validation.issues, state.issues);
    assert.equal(validation.valid, state.issues.length === 0);
  }
});

void test('mutate 委托：addNode 只落显式形状，inverse 为 removeNode', () => {
  const result = applyCanvasCommands(validDocument(), [
    { kind: 'addNode', node: { id: 'c', x: 10, y: 20 } },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const added = result.document.nodes.at(-1) as Record<string, unknown>;
  assert.deepEqual(Object.keys(added).sort(), ['id', 'x', 'y']);
  assert.deepEqual(result.inverse, [{ kind: 'removeNode', id: 'c' }]);
});

void test('mutate 在既有 issues 文档上整批拒绝（R8）', () => {
  const document: CanvasDocument = {
    schemaVersion: 3,
    nodes: [{ id: 'a', x: 0, y: 0, docPath: '/note.md' }],
    edges: [],
  };
  const result = applyCanvasCommands(document, [{ kind: 'move', entries: [{ id: 'a', dx: 1, dy: 1 }] }]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, 'document');
});
