/**
 * C1 点阵：LOD 数量、只画视口内、设备像素对齐、硬上限与绘制调用。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_DOTS,
  drawGrid,
  gridPoints,
  type GridContext,
} from '../../../src/app/canvas/grid.ts';
import { createViewportTransform } from '../../../src/app/canvas/viewport.ts';

interface FakeContext extends GridContext {
  fills: number;
  clears: number;
}

function createFakeContext(): FakeContext {
  return {
    fillStyle: '',
    fills: 0,
    clears: 0,
    clearRect(): void {
      this.clears += 1;
    },
    fillRect(): void {
      this.fills += 1;
    },
  };
}

void test('点阵只落在视口内，且首尾与 ceil/floor 一致', () => {
  const points = gridPoints(createViewportTransform(), { width: 1920, height: 1080 }, 1);

  assert.equal(points.stepWorld, 24);
  assert.equal(points.vertical.length, 81);
  assert.equal(points.horizontal.length, 46);
  assert.equal(points.vertical[0]?.screen, 0.5);
  assert.equal(points.vertical.at(-1)?.screen, 1920.5);

  for (const point of points.vertical) {
    assert.ok(point.screen >= -0.5 && point.screen <= 1920.5, `竖向点越界：${String(point.screen)}`);
  }
  for (const point of points.horizontal) {
    assert.ok(point.screen >= -0.5 && point.screen <= 1080.5, `横向点越界：${String(point.screen)}`);
  }
});

void test('视口裁剪：平移后第一个点从 ceil(x0/step) 开始，不画视口外', () => {
  const points = gridPoints(createViewportTransform(-100, -50, 1), { width: 1920, height: 1080 }, 1);

  assert.equal(points.vertical[0]?.screen, 20.5);
  assert.equal(points.vertical.at(-1)?.screen, 1916.5);
  assert.equal(points.vertical.length, 80);
  assert.equal(points.horizontal[0]?.screen, 22.5);
});

void test('点阵间距与 LOD：相邻点间距等于 stepWorld * scale（设备像素对齐后）', () => {
  const dpr = 16;
  const points = gridPoints(createViewportTransform(0, 0, 0.05), { width: 1920, height: 1080 }, dpr);
  const first = points.vertical[0];
  const second = points.vertical[1];

  assert.ok(first !== undefined && second !== undefined);
  // dpr=16 时半像素对齐量化误差 ≤ 1/16，留 0.1 容差验证 768 * 0.05 = 38.4。
  assert.ok(Math.abs(second.screen - first.screen - 38.4) < 0.1);
});

void test('硬上限：超大视口提升 LOD，点阵总数 ≤ MAX_DOTS', () => {
  const points = gridPoints(createViewportTransform(), { width: 100000, height: 100000 }, 1);

  assert.ok(points.vertical.length * points.horizontal.length <= MAX_DOTS);
  assert.equal(points.stepWorld, 768);
});

void test('drawGrid：一次清屏 + 点阵填充，不再描线', () => {
  const ctx = createFakeContext();
  const result = drawGrid(
    ctx,
    createViewportTransform(),
    { width: 800, height: 600 },
    2,
    { background: '#000', dot: '#111' },
  );

  assert.equal(ctx.clears, 1);
  assert.equal(ctx.fills, 1 + result.dots);
  assert.equal(result.dots, 34 * 26);
  assert.equal(result.stepWorld, 24);
});

void test('性能软断言：1920×1080 单帧点阵绘制 P95 ≤ 2ms（假 ctx 基准）', () => {
  const ctx = createFakeContext();
  const transform = createViewportTransform(0, 0, 1);
  const size = { width: 1920, height: 1080 };
  const palette = { background: '#000', dot: '#111' };
  const samples: number[] = [];

  for (let i = 0; i < 200; i += 1) {
    const start = performance.now();
    drawGrid(ctx, transform, size, 1, palette);
    samples.push(performance.now() - start);
  }

  samples.sort((left, right) => left - right);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  assert.ok(p95 !== undefined);
  assert.ok(p95 <= 2, `P95=${p95.toFixed(3)}ms 超过 2ms 软目标`);
});

void test('CR-20261121-57 反馈修复：透明背景 clearRect 清屏且不填底色', () => {
  const ctx = createFakeContext();
  const transform = createViewportTransform(0, 0, 1);
  const size = { width: 800, height: 600 };

  for (const transparent of ['transparent', 'rgba(0, 0, 0, 0)']) {
    ctx.clears = 0;
    ctx.fills = 0;
    const result = drawGrid(ctx, transform, size, 2, { background: transparent, dot: '#111' });
    assert.equal(ctx.clears, 1, `${transparent} 也要真清屏`);
    assert.equal(ctx.fills, result.dots, `${transparent} 只填充点阵`);
  }

  ctx.clears = 0;
  ctx.fills = 0;
  const opaque = drawGrid(ctx, transform, size, 2, { background: '#000', dot: '#111' });
  assert.equal(ctx.clears, 1, '不透明背景同样先清屏');
  assert.equal(ctx.fills, 1 + opaque.dots, '不透明背景额外填充一次底色');
});
