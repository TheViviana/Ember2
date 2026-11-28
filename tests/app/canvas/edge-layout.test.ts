/**
 * C3 连线布局纯模块单测：端点契约、投影同源、坏边提取、视口裁剪、LOD、
 * E_EDGE_BUDGET、命中测试（CSS px + 动态容差）与 AABB 预筛。
 *
 * 端点 JSON（§13.1 方案 C）：节点盒 CSS 固定 160×96，out = 右边缘中点，in = 左边缘中点。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  absoluteToScreen,
  buildNodeAdjacency,
  buildScreenEdges,
  createScreenEdgeCache,
  cubicAt,
  distanceToPolyline,
  edgeAnchor,
  edgeHitTolerance,
  edgeSamples,
  EDGE_HIT_TOLERANCE_MAX_PX,
  EDGE_HIT_TOLERANCE_PX,
  EDGE_VISIBLE_LIMIT,
  extractEdges,
  hitTestEdges,
  planEdgeDraw,
  pointSegmentDistance,
  polylineLength,
  type CanvasEdgeView,
  type ScreenEdge,
} from '../../../src/app/canvas/edge-layout.ts';
import { parseCanvasDocument } from '../../../src/app/canvas/format.ts';
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  type CanvasNodeView,
} from '../../../src/app/canvas/node-layout.ts';
import { createViewportTransform, worldToScreen } from '../../../src/app/canvas/viewport.ts';

const EPSILON = 1e-9;

function node(id: string, x: number, y: number): CanvasNodeView {
  return { type: 'text', id, label: id, x, y };
}

function edgeView(id: string, from: string, to: string): CanvasEdgeView {
  return { id, from, to };
}

function lineEdge(id: string, x1: number, y1: number, x2: number, y2: number): ScreenEdge {
  return {
    id,
    straight: true,
    p0: { x: x1, y: y1 },
    c1: { x: x1, y: y1 },
    c2: { x: x2, y: y2 },
    p3: { x: x2, y: y2 },
    aabb: {
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      right: Math.max(x1, x2),
      bottom: Math.max(y1, y2),
    },
  };
}

/** 先向下鼓、再回落的曲线：AABB 覆盖很大，但曲线本身只在下缘。 */
function bulgingEdge(id: string): ScreenEdge {
  return {
    id,
    straight: false,
    p0: { x: 0, y: 0 },
    c1: { x: 0, y: 100 },
    c2: { x: 100, y: 100 },
    p3: { x: 100, y: 0 },
    aabb: { left: 0, top: 0, right: 100, bottom: 100 },
  };
}

void test('节点盒契约：CSS 的 .node 固定 160×96，与 node-layout 常量一致', () => {
  const css = readFileSync(
    new URL('../../../src/app/canvas/canvas.module.css', import.meta.url),
    'utf8',
  );
  const match = /\.node\s*\{([\s\S]*?)\}/.exec(css);
  const block = match?.[1] ?? '';

  assert.match(block, new RegExp(`(^|\\s)width:\\s*${NODE_WIDTH}px`));
  assert.match(block, new RegExp(`(^|\\s)height:\\s*${NODE_HEIGHT}px`));
  assert.match(block, /overflow:\s*hidden/);
});

void test('端点：out = 右边缘中点，in = 左边缘中点（绝对世界坐标，1e-9）', () => {
  const position = { x: 100, y: 200 };
  const out = edgeAnchor(position, 'out');
  const input = edgeAnchor(position, 'in');

  assert.ok(Math.abs(out.x - (100 + NODE_WIDTH)) < EPSILON);
  assert.ok(Math.abs(out.y - (200 + NODE_HEIGHT / 2)) < EPSILON);
  assert.deepEqual(input, { x: 100, y: 248 });
});

void test('端点投影：absoluteToScreen 与三式 worldToScreen 在 1e-9 内一致', () => {
  const transform = createViewportTransform(10, 20, 3, 24, 48);
  const anchor = edgeAnchor({ x: 100, y: 200 }, 'out');

  const composed = absoluteToScreen(anchor, transform);
  const expected = worldToScreen(transform, anchor);

  assert.ok(Math.abs(composed.x - expected.x) < EPSILON);
  assert.ok(Math.abs(composed.y - expected.y) < EPSILON);
  assert.equal(composed.x, 790);
  assert.equal(composed.y, 764);
});

void test('buildScreenEdges：p0/p3 落在两节点边缘中点，曲线端点切线水平', () => {
  const transform = createViewportTransform(0, 0, 1);
  const nodes = [node('a', 100, 200), node('b', 400, 200)];

  const [screen] = buildScreenEdges([edgeView('e1', 'a', 'b')], nodes, transform);
  assert.ok(screen !== undefined);

  assert.deepEqual(screen.p0, { x: 260, y: 248 });
  assert.deepEqual(screen.p3, { x: 400, y: 248 });
  assert.equal(screen.p0.y, screen.p3.y);
  assert.ok(Math.abs(cubicAt(screen, 0).x - screen.p0.x) < EPSILON);
  assert.ok(Math.abs(cubicAt(screen, 1).y - screen.p3.y) < EPSILON);
});

void test('buildScreenEdges：节点缺失时跳过该边，不抛错', () => {
  const transform = createViewportTransform();
  const nodes = [node('a', 0, 0)];

  assert.deepEqual(buildScreenEdges([edgeView('e1', 'a', 'ghost')], nodes, transform), []);
});

void test('extractEdges：坏边逐条跳过（缺 id / 缺端点 / 引用不存在 / 重复 id）', () => {
  const document = parseCanvasDocument(
    JSON.stringify({
      schemaVersion: 3,
      nodes: [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 200, y: 0 },
      ],
      edges: [
        { id: 'ok', from: { nodeId: 'a', portId: 'out' }, to: { nodeId: 'b', portId: 'in' } },
        { from: { nodeId: 'a' }, to: { nodeId: 'b' } },
        { id: 'no-from', to: { nodeId: 'b' } },
        { id: 'ghost', from: { nodeId: 'a' }, to: { nodeId: 'ghost' } },
        { id: 'ok', from: { nodeId: 'b' }, to: { nodeId: 'a' } },
        'bad',
      ],
    }),
  );

  assert.deepEqual(
    extractEdges(document, [
      { type: 'text', id: 'a', label: 'a', x: 0, y: 0 },
      { type: 'text', id: 'b', label: 'b', x: 200, y: 0 },
    ]),
    [{ id: 'ok', from: 'a', to: 'b' }],
  );
});

void test('视口裁剪：只保留与视口（含 pad）相交的边，跨越视口的长边保留', () => {
  const transform = createViewportTransform(0, 0, 1);
  const nodes = [
    node('a', 100, 200),
    node('b', 400, 200),
    node('far1', 5000, 5000),
    node('far2', 5100, 5000),
    node('left', -1000, 300),
    node('right', 1000, 300),
  ];
  const edges = [
    edgeView('near', 'a', 'b'),
    edgeView('far', 'far1', 'far2'),
    edgeView('cross', 'left', 'right'),
  ];

  const plan = planEdgeDraw(
    buildScreenEdges(edges, nodes, transform),
    { width: 800, height: 600 },
  );

  assert.equal(plan.visibleCount, 2);
  assert.deepEqual(
    plan.edges.map((edge) => edge.id),
    ['near', 'cross'],
  );
  assert.equal(plan.warning, null);
});

void test('LOD：scale < 0.3 退化为直线（2 个采样点），≥ 0.3 为曲线', () => {
  const nodes = [node('a', 0, 0), node('b', 400, 0)];
  const edges = [edgeView('e1', 'a', 'b')];

  const dense = buildScreenEdges(edges, nodes, createViewportTransform(0, 0, 0.29));
  const normal = buildScreenEdges(edges, nodes, createViewportTransform(0, 0, 0.3));

  assert.equal(dense[0]?.straight, true);
  assert.equal(normal[0]?.straight, false);
  const denseEdge = dense[0];
  const normalEdge = normal[0];
  assert.ok(denseEdge !== undefined && normalEdge !== undefined);
  assert.equal(edgeSamples(denseEdge).length, 2);
  assert.equal(edgeSamples(normalEdge).length, 17);
  assert.equal(planEdgeDraw(dense, { width: 800, height: 600 }).straight, true);
});

void test('E_EDGE_BUDGET：可见边 > 5000 时不绘制，并给出告警', () => {
  const nodes = [node('a', 0, 0), node('b', 400, 0)];
  const edges: CanvasEdgeView[] = [];
  for (let index = 0; index <= EDGE_VISIBLE_LIMIT; index += 1) {
    edges.push(edgeView(`e${index}`, 'a', 'b'));
  }
  const plan = planEdgeDraw(
    buildScreenEdges(edges, nodes, createViewportTransform(0, 0, 0.1)),
    { width: 800, height: 600 },
  );

  assert.equal(plan.visibleCount, EDGE_VISIBLE_LIMIT + 1);
  assert.deepEqual(plan.edges, []);
  assert.deepEqual(plan.warning, {
    code: 'E_EDGE_BUDGET',
    visible: EDGE_VISIBLE_LIMIT + 1,
    limit: EDGE_VISIBLE_LIMIT,
  });
});

void test('命中：6 CSS px 容差，超出即不命中（与 dpr 无关）', () => {
  const edge = lineEdge('e1', 0, 0, 100, 0);

  assert.deepEqual(hitTestEdges([edge], { x: 50, y: 5 }), { edgeId: 'e1', distance: 5 });
  assert.equal(hitTestEdges([edge], { x: 50, y: 7 }), null);
  assert.equal(edgeHitTolerance(edge), EDGE_HIT_TOLERANCE_PX);
});

void test('命中：动态容差随线长增长，封顶 24 px', () => {
  const long = lineEdge('long', 0, 0, 2000, 0);

  assert.equal(edgeHitTolerance(long), EDGE_HIT_TOLERANCE_MAX_PX);
  assert.deepEqual(hitTestEdges([long], { x: 1000, y: 20 }), {
    edgeId: 'long',
    distance: 20,
  });
  assert.equal(hitTestEdges([long], { x: 1000, y: 25 }), null);
});

void test('AABB 预筛不是判据：点在包围盒内但离曲线远，不命中', () => {
  const edge = bulgingEdge('curve');
  const samples = edgeSamples(edge);

  assert.ok(distanceToPolyline({ x: 50, y: 50 }, samples) > EDGE_HIT_TOLERANCE_PX);
  assert.equal(hitTestEdges([edge], { x: 50, y: 50 }), null);
  // 曲线最低点附近应命中
  assert.equal(hitTestEdges([edge], { x: 50, y: 75 })?.edgeId, 'curve');
});

void test('命中：同距取数组靠后者（绘制顺序更靠上）', () => {
  const edges = [lineEdge('under', 0, 0, 100, 0), lineEdge('over', 0, 0, 100, 0)];

  assert.equal(hitTestEdges(edges, { x: 50, y: 3 })?.edgeId, 'over');
});

void test('点到线段距离与折线长度：端点、垂足、退化线段', () => {
  assert.equal(pointSegmentDistance({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 5);
  assert.equal(pointSegmentDistance({ x: -5, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 5);
  assert.equal(pointSegmentDistance({ x: 3, y: 4 }, { x: 3, y: 4 }, { x: 3, y: 4 }), 0);
  assert.equal(
    polylineLength([
      { x: 0, y: 0 },
      { x: 3, y: 4 },
      { x: 3, y: 10 },
    ]),
    11,
  );
});

function assertPointClose(
  actual: { readonly x: number; readonly y: number },
  expected: { readonly x: number; readonly y: number },
): void {
  assert.ok(Math.abs(actual.x - expected.x) <= EPSILON, `${actual.x} != ${expected.x}`);
  assert.ok(Math.abs(actual.y - expected.y) <= EPSILON, `${actual.y} != ${expected.y}`);
}

function assertEdgesClose(actual: readonly ScreenEdge[], expected: readonly ScreenEdge[]): void {
  assert.deepEqual(
    actual.map((edge) => edge.id),
    expected.map((edge) => edge.id),
    '保持 edgeViews 顺序',
  );
  for (let index = 0; index < actual.length; index += 1) {
    const left = actual[index];
    const right = expected[index];
    assert.ok(left !== undefined && right !== undefined);
    assert.equal(left.straight, right.straight);
    assertPointClose(left.p0, right.p0);
    assertPointClose(left.c1, right.c1);
    assertPointClose(left.c2, right.c2);
    assertPointClose(left.p3, right.p3);
    for (const key of ['left', 'top', 'right', 'bottom'] as const) {
      assert.ok(Math.abs(left.aabb[key] - right.aabb[key]) <= EPSILON);
    }
  }
}

void test('C4 首条：50 节点/120 边/10 组位置，增量与全量逐数值 1e-9 等价', () => {
  let seed = 0x4c4f574c;
  const random = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const nodes: CanvasNodeView[] = [];
  const edges: CanvasEdgeView[] = [];
  for (let index = 0; index < 50; index += 1) {
    nodes.push(node(`n${index}`, (index % 10) * 190, Math.floor(index / 10) * 130));
  }
  for (let index = 0; index < 120; index += 1) {
    edges.push(edgeView(`e${index}`, `n${index % 50}`, `n${(index * 17 + 7) % 50}`));
  }
  const transform = createViewportTransform(13, -7, 1.25, 17, -23);
  const size = { width: 10_000, height: 10_000 };
  const cache = createScreenEdgeCache();
  cache.update(edges, nodes, transform, size);

  for (let round = 0; round < 10; round += 1) {
    const moved = new Set([`n${round}`, `n${round + 10}`, `n${round + 20}`]);
    const next = nodes.map((item) =>
      moved.has(item.id)
        ? { ...item, x: item.x + random() * 37 - 18, y: item.y + random() * 29 - 14 }
        : item,
    );
    const incremental = cache.update(edges, next, transform, size, moved);
    const full = buildScreenEdges(edges, next, transform);
    assert.equal(incremental.degenerated, false);
    assertEdgesClose(incremental.edges, full);
    nodes.splice(0, nodes.length, ...next);
  }
});

void test('邻接表跳过重复/坏边/缺节点，自环只计一次', () => {
  const nodes = [node('a', 0, 0), node('b', 200, 0), node('c', 400, 0)];
  const adjacency = buildNodeAdjacency(
    [
      edgeView('loop', 'a', 'a'),
      edgeView('ok', 'a', 'b'),
      edgeView('ok', 'b', 'c'),
      edgeView('', 'a', 'b'),
      edgeView('ghost', 'a', 'missing'),
    ],
    nodes,
  );

  assert.deepEqual(adjacency.get('a'), ['loop', 'ok']);
  assert.deepEqual(adjacency.get('b'), ['ok']);
  assert.equal(adjacency.get('c'), undefined);
});

void test('增量退化：incident > 200 立即全量并标记', () => {
  const nodes = [node('hub', 400, 300)];
  const edges: CanvasEdgeView[] = [];
  for (let index = 0; index < 201; index += 1) {
    nodes.push(node(`n${index}`, (index % 20) * 100, Math.floor(index / 20) * 100));
    edges.push(edgeView(`e${index}`, 'hub', `n${index}`));
  }
  const cache = createScreenEdgeCache();
  const transform = createViewportTransform();
  const size = { width: 2400, height: 1400 };
  cache.update(edges, nodes, transform, size);
  const result = cache.update(edges, nodes, transform, size, new Set(['hub']));

  assert.equal(result.incidentCount, 201);
  assert.equal(result.degenerated, true);
  assertEdgesClose(result.edges, buildScreenEdges(edges, nodes, transform));
});

void test('增量未超阈值时保留非 incident 缓存对象', () => {
  const nodes = Array.from({ length: 11 }, (_, index) => node(`n${index}`, index * 200, 100));
  const edges = Array.from({ length: 10 }, (_, index) =>
    edgeView(`e${index}`, `n${index}`, `n${index + 1}`),
  );
  const transform = createViewportTransform();
  const size = { width: 2400, height: 600 };
  const cache = createScreenEdgeCache();
  const initial = cache.update(edges, nodes, transform, size);
  const unchanged = initial.edges.find((edge) => edge.id === 'e9');

  const incremental = cache.update(edges, nodes, transform, size, new Set(['n0']));
  assert.equal(incremental.incidentCount, 1);
  assert.equal(incremental.degenerated, false);
  assert.equal(incremental.edges.find((edge) => edge.id === 'e9'), unchanged);
});

void test('增量退化：incident > 可见边 40% 时全量', () => {
  const nodes = Array.from({ length: 4 }, (_, index) => node(`n${index}`, index * 200, 100));
  const edges = Array.from({ length: 3 }, (_, index) =>
    edgeView(`e${index}`, `n${index}`, `n${index + 1}`),
  );
  const transform = createViewportTransform();
  const size = { width: 1000, height: 600 };
  const cache = createScreenEdgeCache();
  cache.update(edges, nodes, transform, size);

  const result = cache.update(edges, nodes, transform, size, new Set(['n1']));
  assert.equal(result.incidentCount, 2);
  assert.equal(result.degenerated, true);
  assertEdgesClose(result.edges, buildScreenEdges(edges, nodes, transform));
});
