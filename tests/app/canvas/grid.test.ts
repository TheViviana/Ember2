/**
 * C1 网格：LOD 线数、只画视口内、设备像素对齐、硬上限与绘制调用。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAJOR_EVERY,
  MAX_LINES_PER_AXIS,
  drawGrid,
  gridLines,
  type GridContext,
} from '../../../src/app/canvas/grid.ts';
import { createViewportTransform } from '../../../src/app/canvas/viewport.ts';

interface FakeContext extends GridContext {
  fills: number;
  strokes: number;
  moves: number;
  lines: number;
  clears: number;
}

function createFakeContext(): FakeContext {
  return {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    fills: 0,
    strokes: 0,
    moves: 0,
    lines: 0,
    clears: 0,
    clearRect(): void {
      this.clears += 1;
    },
    fillRect(): void {
      this.fills += 1;
    },
    beginPath(): void {},
    moveTo(): void {
      this.moves += 1;
    },
    lineTo(): void {
      this.lines += 1;
    },
    stroke(): void {
      this.strokes += 1;
    },
  };
}

void test('网格线只落在视口内，且首尾与 ceil/floor 一致', () => {
  const lines = gridLines(createViewportTransform(), { width: 1920, height: 1080 }, 1);

  assert.equal(lines.stepWorld, 12);
  assert.equal(lines.vertical.length, 161);
  assert.equal(lines.horizontal.length, 91);
  assert.equal(lines.vertical[0]?.screen, 0.5);
  assert.equal(lines.vertical.at(-1)?.screen, 1920.5);

  for (const line of lines.vertical) {
    assert.ok(line.screen >= -0.5 && line.screen <= 1920.5, `竖线越界：${String(line.screen)}`);
  }
  for (const line of lines.horizontal) {
    assert.ok(line.screen >= -0.5 && line.screen <= 1080.5, `横线越界：${String(line.screen)}`);
  }
});

void test('视口裁剪：平移后第一条线从 ceil(x0/step) 开始，不画视口外', () => {
  const lines = gridLines(createViewportTransform(-100, -50, 1), { width: 1920, height: 1080 }, 1);

  assert.equal(lines.vertical[0]?.screen, 8.5);
  assert.equal(lines.vertical.at(-1)?.screen, 1916.5);
  assert.equal(lines.vertical.length, 160);
  assert.equal(lines.horizontal[0]?.screen, 10.5);
});

void test('网格线间距与 LOD：每条线的间距等于 stepWorld * scale（设备像素对齐后）', () => {
  const dpr = 16;
  const lines = gridLines(createViewportTransform(0, 0, 0.05), { width: 1920, height: 1080 }, dpr);
  const first = lines.vertical[0];
  const second = lines.vertical[1];

  assert.ok(first !== undefined && second !== undefined);
  // dpr=16 时半像素对齐量化误差 ≤ 1/16，留 0.1 容差验证 192 * 0.05 = 9.6。
  assert.ok(Math.abs(second.screen - first.screen - 9.6) < 0.1);
});

void test('主线每 5 条一条', () => {
  const lines = gridLines(createViewportTransform(), { width: 1920, height: 1080 }, 1);
  const majors = lines.vertical.filter((line) => line.major);

  assert.ok(majors.length > 0);
  for (let index = 0; index < lines.vertical.length; index += 1) {
    const line = lines.vertical[index];
    assert.equal(line?.major, index % MAJOR_EVERY === 0);
  }
});

void test('硬上限：超大视口提升 LOD，单轴线数 ≤ 600', () => {
  const lines = gridLines(createViewportTransform(), { width: 100000, height: 100000 }, 1);

  assert.ok(lines.vertical.length <= MAX_LINES_PER_AXIS);
  assert.ok(lines.horizontal.length <= MAX_LINES_PER_AXIS);
  assert.equal(lines.stepWorld, 192);
});

void test('drawGrid：一次背景填充 + 次线/主线两次 stroke', () => {
  const ctx = createFakeContext();
  const result = drawGrid(
    ctx,
    createViewportTransform(),
    { width: 800, height: 600 },
    2,
    { background: '#000', minor: '#111', major: '#222' },
  );

  assert.equal(ctx.fills, 1);
  assert.equal(ctx.strokes, 2);
  assert.equal(ctx.lineWidth, 0.5);
  assert.ok(result.vertical > 0 && result.horizontal > 0);
  assert.equal(result.vertical + result.horizontal, ctx.moves);
});

void test('性能软断言：1920×1080 单帧网格绘制 P95 ≤ 2ms（假 ctx 基准）', () => {
  const ctx = createFakeContext();
  const transform = createViewportTransform(0, 0, 1);
  const size = { width: 1920, height: 1080 };
  const palette = { background: '#000', minor: '#111', major: '#222' };
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


void test('CR-20261121-57 反馈修复：透明背景 clearRect 清屏且不再 fillRect（防花格叠画）', () => {
  const ctx = createFakeContext();
  const transform = createViewportTransform(0, 0, 1);
  const size = { width: 800, height: 600 };

  for (const transparent of ['transparent', 'rgba(0, 0, 0, 0)']) {
    ctx.clears = 0;
    ctx.fills = 0;
    drawGrid(ctx, transform, size, 2, { background: transparent, minor: '#111', major: '#222' });
    assert.equal(ctx.clears, 1, `${transparent} 也要真清屏`);
    assert.equal(ctx.fills, 0, `${transparent} 不得再填充底色`);
  }

  ctx.clears = 0;
  ctx.fills = 0;
  drawGrid(ctx, transform, size, 2, { background: '#000', minor: '#111', major: '#222' });
  assert.equal(ctx.clears, 1, '不透明背景同样先清屏');
  assert.equal(ctx.fills, 1, '不透明背景保留填充');
});
