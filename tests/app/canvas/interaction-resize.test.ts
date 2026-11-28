/**
 * CR-20261118-05 N3：右下角缩放手柄状态机与统一历史。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanvasDocument } from '#canvas-format';
import { CanvasInteractionController } from '../../../src/app/canvas/document-controller.ts';
import {
  createInteractionState,
  reduceInteraction,
  setInteractionSelection,
  type InteractionEffect,
} from '../../../src/app/canvas/interaction.ts';
import type { CanvasNodeView } from '../../../src/app/canvas/node-layout.ts';

const nodes: readonly CanvasNodeView[] = [{ type: 'text', id: 'a', label: 'A', x: 0, y: 0 }];

function down(options: { readOnly?: boolean; w?: number; h?: number } = {}) {
  const sized: readonly CanvasNodeView[] =
    options.w === undefined && options.h === undefined
      ? nodes
      : [
          {
            type: 'text',
            id: 'a',
            label: 'A',
            x: 0,
            y: 0,
            ...(options.w === undefined ? {} : { w: options.w }),
            ...(options.h === undefined ? {} : { h: options.h }),
          },
        ];
  return reduceInteraction(
    setInteractionSelection(createInteractionState(), {
      nodes: new Set(['a']),
      edges: new Set(),
    }),
    {
      type: 'pointerDown',
      point: { x: 10, y: 10 },
      button: 0,
      shiftKey: false,
      toggleKey: false,
      altKey: false,
      pan: false,
      target: { kind: 'resize', id: 'a', direction: 'se' },
      nodes: sized,
      ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    },
  );
}

function move(state: ReturnType<typeof down>['state'], x: number, y: number, scale = 1) {
  return reduceInteraction(state, { type: 'pointerMove', point: { x, y }, scale });
}

function up(state: ReturnType<typeof down>['state'], x: number, y: number, scale = 1) {
  return reduceInteraction(state, { type: 'pointerUp', point: { x, y }, scale });
}

function resizeEffects(effects: readonly InteractionEffect[]) {
  return effects.filter(
    (effect) => effect.type === 'resizePreview' || effect.type === 'resizeCommit',
  );
}

void test('resize 按下：单选命中建立手势并记录 origin，只读态不建', () => {
  const result = down();
  assert.equal(result.state.gesture?.kind, 'resize');
  assert.deepEqual(result.effects, []);

  const sized = down({ w: 240, h: 120 });
  assert.equal(sized.state.gesture?.kind, 'resize');

  const readOnly = down({ readOnly: true });
  assert.equal(readOnly.state.gesture, null);
  assert.deepEqual(readOnly.effects, []);
});

void test('resize 拖动：只发 preview，不改文档也不入历史', () => {
  const started = down();
  const moved = move(started.state, 90, 50);
  assert.equal(moved.state.gesture?.kind, 'resize');
  assert.deepEqual(resizeEffects(moved.effects), [
    { type: 'resizePreview', id: 'a', x: 0, y: 0, w: 240, h: 136, dir: 'se' },
  ]);
  assert.equal(moved.effects.some((effect) => effect.type === 'resizeCommit'), false);
});

void test('resize 边界：最小 80×48，最大 10000×10000', () => {
  const started = down();
  const shrunk = move(started.state, -1000, -1000);
  assert.deepEqual(resizeEffects(shrunk.effects), [
    { type: 'resizePreview', id: 'a', x: 0, y: 0, w: 80, h: 48, dir: 'se' },
  ]);
  const grown = move(started.state, 20000, 20000);
  assert.deepEqual(resizeEffects(grown.effects), [
    { type: 'resizePreview', id: 'a', x: 0, y: 0, w: 10000, h: 10000, dir: 'se' },
  ]);
});

void test('resize 结束：无位移只还原预览；有位移只发一条 resizeCommit', () => {
  const started = down();
  const unchanged = up(started.state, 10, 10);
  assert.equal(unchanged.state.gesture, null);
  assert.deepEqual(unchanged.effects, [{ type: 'resizePreview', id: 'a', x: 0, y: 0, w: 160, h: 96, dir: 'se' }]);

  const committed = up(started.state, 50, 30);
  assert.equal(committed.state.gesture, null);
  assert.deepEqual(committed.effects, [{ type: 'resizeCommit', id: 'a', x: 0, y: 0, w: 200, h: 116, dir: 'se' }]);
});

void test('resize Esc：还原 origin 且不产生提交', () => {
  const started = down();
  const moved = move(started.state, 120, 90);
  const cancelled = reduceInteraction(moved.state, { type: 'cancel' });
  assert.equal(cancelled.state.gesture, null);
  assert.deepEqual(cancelled.effects, [{ type: 'resizePreview', id: 'a', x: 0, y: 0, w: 160, h: 96, dir: 'se' }]);
  assert.equal(cancelled.effects.some((effect) => effect.type === 'resizeCommit'), false);
});

void test('resizeCommit 走 controller：单条 updateNode 历史，⌘Z 一次还原尺寸', () => {
  const document: CanvasDocument = {
    schemaVersion: 3,
    nodes: [{ id: 'a', type: 'text', x: 0, y: 0 }],
    edges: [],
  };
  const controller = new CanvasInteractionController({
    canvasId: 'n3',
    store: {
      save: () => Promise.resolve({}),
      open: () =>
        Promise.resolve({ exists: false, text: null, sha256: '', modifiedMs: null }),
    },
    document,
    applyPositions: () => {},
    onConflict: () => {},
    schedule: () => 0,
    cancelSchedule: () => {},
  });
  const started = down();
  const committed = up(started.state, 50, 30);
  const effect = committed.effects.find((item) => item.type === 'resizeCommit');
  assert.ok(effect?.type === 'resizeCommit');

  const ok = controller.execute([
    { kind: 'updateNode', id: effect.id, changes: { w: effect.w, h: effect.h } },
  ]);
  assert.equal(ok, true);
  assert.equal(controller.getHistory().past.length, 1);
  const node = controller.getDocument().nodes[0] as Record<string, unknown>;
  assert.equal(node.w, 200);
  assert.equal(node.h, 116);

  assert.equal(controller.undo(), true);
  const restored = controller.getDocument().nodes[0] as Record<string, unknown>;
  assert.equal('w' in restored, false);
  assert.equal('h' in restored, false);
});

// ---- CR-20261119-12：origin.h 从 nodeSizeOf 取，autoH 自动参与 ----

void test('A7 pointerDown origin.h = nodeSizeOf：h 缺省 + autoH=150 → 150；显式 h=200 → 200', () => {
  // h 缺省 + autoH=150 → origin.h 应该是 150（不是 NODE_HEIGHT 96）
  const viewAuto: readonly CanvasNodeView[] = [{ type: 'text', id: 'a', label: 'A', x: 0, y: 0, autoH: 150 }];
  const stA = reduceInteraction(
    createInteractionState(),
    {
      type: 'pointerDown',
      point: { x: 10, y: 10 },
      button: 0,
      shiftKey: false,
      toggleKey: false,
      altKey: false,
      pan: false,
      target: { kind: 'resize', id: 'a', direction: 'se' },
      nodes: viewAuto,
    },
  );
  const geoA = stA.state.gesture;
  assert.ok(geoA && 'origin' in geoA);
  assert.equal(geoA.origin.h, 150);

  // 显式 h=200 → origin.h 是 200（显式 h 优先于 autoH）
  const viewExplicit: readonly CanvasNodeView[] = [{ type: 'text', id: 'a', label: 'A', x: 0, y: 0, h: 200, autoH: 150 }];
  const stE = reduceInteraction(
    createInteractionState(),
    {
      type: 'pointerDown',
      point: { x: 10, y: 10 },
      button: 0,
      shiftKey: false,
      toggleKey: false,
      altKey: false,
      pan: false,
      target: { kind: 'resize', id: 'a', direction: 'se' },
      nodes: viewExplicit,
    },
  );
  const geoE = stE.state.gesture;
  assert.ok(geoE && 'origin' in geoE);
  assert.equal(geoE.origin.h, 200);
});
