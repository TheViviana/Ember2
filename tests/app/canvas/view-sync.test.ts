/**
 * C0-B B1/B3：外部文档视图重建、dpr 读取与挂载代次守卫。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from '#canvas-format';
import type { CanvasDocument } from '../../../src/app/canvas/format.ts';
import { createViewportTransform } from '../../../src/app/canvas/viewport.ts';
import {
  createCanvasDocumentView,
  createCanvasMountGuard,
  readCanvasDpr,
} from '../../../src/app/canvas/view-sync.ts';

function documentWithOrigin(): CanvasDocument {
  return {
    schemaVersion: 2,
    lastOrigin: { x: 24, y: -48 },
    nodes: [
      { id: 'a', label: 'A', x: 1, y: 2 },
      { id: 'bad', label: 'Bad' },
    ],
    edges: [{ id: 'e1', from: { nodeId: 'a' }, to: { nodeId: 'bad' } }],
  };
}

void test('accept-external：重新应用 lastOrigin、按投影重建视图并清空选中/手势', () => {
  const document = documentWithOrigin();
  const projection = inspect(document).projection;
  const before = { ...createViewportTransform(), originX: 999, originY: 999 };

  const view = createCanvasDocumentView({ document, projection, transform: before });

  assert.equal(view.transform.originX, 24);
  assert.equal(view.transform.originY, -48);
  assert.deepEqual(
    view.nodeViews.map((node) => node.id),
    ['a'],
  );
  assert.deepEqual(view.edgeViews, []);
  assert.equal(view.interaction.gesture, null);
  assert.equal(view.interaction.selection.nodes.size, 0);
  assert.equal(view.interaction.selection.edges.size, 0);
});

void test('readCanvasDpr：无效值回退 1，上限 2，合法值原样（含小数）', () => {
  assert.equal(readCanvasDpr(1), 1);
  assert.equal(readCanvasDpr(1.5), 1.5);
  assert.equal(readCanvasDpr(3), 2);
  assert.equal(readCanvasDpr(0), 1);
  assert.equal(readCanvasDpr(Number.NaN), 1);
  assert.equal(readCanvasDpr(Number.POSITIVE_INFINITY), 1);
});

void test('挂载代次：新代次令旧代次失效，invalidate 后全部失效', () => {
  const guard = createCanvasMountGuard();
  const first = guard.begin();
  assert.equal(guard.isCurrent(first), true);

  const second = guard.begin();
  assert.equal(guard.isCurrent(first), false);
  assert.equal(guard.isCurrent(second), true);

  guard.invalidate();
  assert.equal(guard.isCurrent(second), false);
});
