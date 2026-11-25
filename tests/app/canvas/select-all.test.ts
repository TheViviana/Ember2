import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanvasSelectAllSelection } from '../../../src/app/canvas/canvas-interactions.ts';
import type { CanvasDocument } from '../../../src/app/canvas/format.ts';

void test('⌘/Ctrl+A 全选映射包含全部有效节点与连线', () => {
  const document: CanvasDocument = {
    schemaVersion: 2,
    nodes: [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 160, y: 0 },
      { id: 'c', x: 320, y: 0 },
    ],
    edges: [
      { id: 'e1', from: { nodeId: 'a' }, to: { nodeId: 'b' } },
      { id: 'e2', from: { nodeId: 'b' }, to: { nodeId: 'c' } },
    ],
  };

  const selection = createCanvasSelectAllSelection(document);
  assert.deepEqual([...selection.nodes], ['a', 'b', 'c']);
  assert.deepEqual([...selection.edges], ['e1', 'e2']);
});

void test('全选映射不写入文档，空画布返回两个空集合', () => {
  const document: CanvasDocument = { schemaVersion: 2, nodes: [], edges: [] };
  const before = structuredClone(document);
  const selection = createCanvasSelectAllSelection(document);

  assert.equal(selection.nodes.size, 0);
  assert.equal(selection.edges.size, 0);
  assert.deepEqual(document, before);
});

void test('全选映射排除无法进入渲染投影的坏条目', () => {
  const document: CanvasDocument = {
    schemaVersion: 2,
    nodes: [{ id: 'valid', x: 0, y: 0 }, { id: 'missing-coordinates' }],
    edges: [
      { id: 'valid-edge', from: { nodeId: 'valid' }, to: { nodeId: 'valid' } },
      { id: 'missing-endpoints' },
    ],
  };

  const selection = createCanvasSelectAllSelection(document);
  assert.deepEqual([...selection.nodes], ['valid']);
  assert.deepEqual([...selection.edges], ['valid-edge']);
});
