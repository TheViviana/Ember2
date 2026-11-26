/**
 * CR-20261118-05 N2：命中 / 端点 / 渲染视图按节点显式 w/h 适配。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AI_NODE_HEIGHT,
  AI_NODE_WIDTH,
  extractNodeViews,
  hitTestNodes,
  marqueeNodeIds,
  nodeScreenRect,
  nodeSizeOf,
  NODE_HEIGHT,
  NODE_WIDTH,
  PROMPT_NODE_HEIGHT,
  PROMPT_NODE_WIDTH,
  type CanvasNodeView,
} from '../../../src/app/canvas/node-layout.ts';
import { buildScreenEdges } from '../../../src/app/canvas/edge-layout.ts';
import { createNodeLayer } from '../../../src/app/canvas/node-layer.ts';
import { createViewportTransform } from '../../../src/app/canvas/viewport.ts';

void test('nodeSizeOf：合法显式值优先，缺失或非法各自回退 160/96', () => {
  assert.deepEqual(nodeSizeOf({ w: 240, h: 120 }), { w: 240, h: 120 });
  assert.deepEqual(nodeSizeOf({}), { w: NODE_WIDTH, h: NODE_HEIGHT });
  assert.deepEqual(nodeSizeOf({ w: 240 }), { w: 240, h: NODE_HEIGHT });

  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 10001]) {
    assert.deepEqual(nodeSizeOf({ w: value, h: value }), {
      w: NODE_WIDTH,
      h: NODE_HEIGHT,
    });
  }
  assert.deepEqual(nodeSizeOf({ w: 10000, h: 10000 }), { w: 10000, h: 10000 });
});

void test('nodeScreenRect：显式尺寸乘 scale，缺失回退默认盒', () => {
  const transform = { ...createViewportTransform(), scale: 2 };
  const sized = nodeScreenRect({ type: 'text', id: 'a', label: 'A', x: 0, y: 0, w: 200, h: 100 }, transform);
  assert.deepEqual(sized, { left: 0, top: 0, right: 400, bottom: 200 });

  const fallback = nodeScreenRect({ type: 'text', id: 'b', label: 'B', x: 0, y: 0 }, transform);
  assert.deepEqual(fallback, {
    left: 0,
    top: 0,
    right: NODE_WIDTH * 2,
    bottom: NODE_HEIGHT * 2,
  });
});

void test('hitTestNodes：默认盒之外的点击不命中显式缩小节点', () => {
  const nodes: readonly CanvasNodeView[] = [
    { type: 'text', id: 'small', label: 'small', x: 0, y: 0, w: 80, h: 48 },
  ];
  const transform = createViewportTransform();
  assert.equal(hitTestNodes(nodes, transform, { x: 70, y: 20 })?.id, 'small');
  assert.equal(hitTestNodes(nodes, transform, { x: 150, y: 20 }), null);
  assert.equal(hitTestNodes(nodes, transform, { x: 70, y: 60 }), null);
});

void test('marqueeNodeIds：框选相交按显式尺寸判定', () => {
  const nodes: readonly CanvasNodeView[] = [
    { type: 'text', id: 'small', label: 'small', x: 0, y: 0, w: 80, h: 48 },
  ];
  const transform = createViewportTransform();
  assert.deepEqual(
    marqueeNodeIds(nodes, transform, { left: 79, top: 0, right: 200, bottom: 48 }),
    ['small'],
  );
  assert.deepEqual(
    marqueeNodeIds(nodes, transform, { left: 90, top: 0, right: 200, bottom: 48 }),
    [],
  );
});

void test('buildScreenEdges：out/in 端点按源/目标各自尺寸贴合边缘中线', () => {
  const nodes: readonly CanvasNodeView[] = [
    { type: 'text', id: 'a', label: 'a', x: 0, y: 0, w: 200, h: 100 },
    { type: 'text', id: 'b', label: 'b', x: 300, y: 0, w: 80, h: 40 },
  ];
  const [edge] = buildScreenEdges([{ id: 'e', from: 'a', to: 'b' }], nodes, createViewportTransform());
  assert.ok(edge !== undefined);
  assert.deepEqual(edge.p0, { x: 200, y: 50 });
  assert.deepEqual(edge.p3, { x: 300, y: 20 });
});

void test('extractNodeViews：仅透出合法 w/h，非法值不回写且节点仍保留', () => {
  const views = extractNodeViews([
    { type: 'text', id: 'sized', x: 0, y: 0, w: 120, h: 80 },
    { type: 'text', id: 'partial', x: 0, y: 0, w: 0, h: 60 },
    { type: 'text', id: 'bad', x: '0', y: 0 },
  ]);
  assert.deepEqual(views.map((view) => view.id), ['sized', 'partial']);
  assert.equal(views[0]?.w, 120);
  assert.equal(views[0]?.h, 80);
  assert.equal('w' in (views[1] ?? {}), false);
  assert.equal(views[1]?.h, 60);
});

interface FakeElement {
  className: string;
  textContent: string;
  style: Record<string, string>;
  dataset: Record<string, string>;
  children: FakeElement[];
  append(child: FakeElement): void;
  remove(): void;
}

function fakeElement(): FakeElement {
  const element: FakeElement = {
    className: '',
    textContent: '',
    style: {},
    dataset: {},
    children: [],
    append(child: FakeElement): void {
      element.children.push(child);
    },
    remove(): void {
      element.children.length = 0;
    },
  };
  return element;
}

void test('node-layer：显式 w/h 写内联 px，撤销尺寸后清空由 CSS 兜底', () => {
  const root = fakeElement();
  const layer = createNodeLayer(
    { append: (element) => root.append(element as unknown as FakeElement) },
    {
      className: 'nodes',
      nodeClassName: 'node',
      createElement: () => fakeElement() as unknown as HTMLElement,
      createChildElement: () => fakeElement() as unknown as HTMLElement,
    },
  );
  const transform = createViewportTransform();
  layer.setNodes([{ type: 'text', id: 'a', label: 'A', x: 0, y: 0, w: 200, h: 100 }], transform);
  const item = root.children[0]?.children[0];
  assert.equal(item?.style.width, '200px');
  assert.equal(item?.style.height, '100px');

  layer.setNodes([{ type: 'text', id: 'a', label: 'A', x: 0, y: 0 }], transform);
  assert.equal(item?.style.width, '');
  assert.equal(item?.style.height, '');
});

void test('AI / 提示词节点尺寸固定：忽略磁盘历史 w/h，连线端点同步用固定盒', () => {
  assert.equal(AI_NODE_WIDTH, 420);
  assert.equal(AI_NODE_HEIGHT, 190);
  assert.deepEqual(nodeSizeOf({ kind: 'ai' }), { w: AI_NODE_WIDTH, h: AI_NODE_HEIGHT });
  assert.deepEqual(nodeSizeOf({ kind: 'prompt' }), { w: PROMPT_NODE_WIDTH, h: PROMPT_NODE_HEIGHT });
  assert.deepEqual(nodeSizeOf({ kind: 'ai', w: 999, h: 999 }), {
    w: AI_NODE_WIDTH,
    h: AI_NODE_HEIGHT,
  });

  const nodes: readonly CanvasNodeView[] = [
    { type: 'ai', id: 'a', label: 'AI', x: 0, y: 0, w: 160, h: 96, kind: 'ai' },
    { type: 'prompt', id: 'p', label: '提示词', x: 400, y: 0, kind: 'prompt' },
  ];
  const [edge] = buildScreenEdges(
    [{ id: 'e', from: 'a', to: 'p' }],
    nodes,
    createViewportTransform(),
  );
  assert.ok(edge !== undefined);
  assert.equal(edge.p0.x, AI_NODE_WIDTH);
  assert.equal(edge.p0.y, AI_NODE_HEIGHT / 2);
  assert.equal(edge.p3.x, 400);
  assert.equal(edge.p3.y, PROMPT_NODE_HEIGHT / 2);
});
