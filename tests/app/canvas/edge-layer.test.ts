/**
 * C3 连线绘制单测：批量 Path2D（一次 stroke）、LOD 直线、箭头批量、空计划零调用、
 * 高亮层独立画笔。用假 path/ctx 记录调用，不需要浏览器。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EdgeDrawPlan, ScreenEdge } from '../../../src/app/canvas/edge-layout.ts';
import {
  drawEdgeHighlight,
  drawEdgePlan,
  type EdgeContext,
  type EdgePalette,
  type EdgePath,
} from '../../../src/app/canvas/edge-layer.ts';

/* 测试本地调色板 fixture：断言只关心「写入 ctx 的值 === 传入 palette 的值」，
 * 不绑定生产默认值（生产默认已改为运行时令牌解析，CR-20261121-44）。 */
const TEST_PALETTE: EdgePalette = Object.freeze({
  edge: '#101010',
  selected: '#202020',
  arrow: '#303030',
});

interface PathOp {
  readonly kind: 'moveTo' | 'lineTo' | 'arc' | 'bezierCurveTo' | 'closePath';
  readonly args: readonly number[];
}

class RecordingPath implements EdgePath {
  readonly ops: PathOp[] = [];

  moveTo(x: number, y: number): void {
    this.ops.push({ kind: 'moveTo', args: [x, y] });
  }

  lineTo(x: number, y: number): void {
    this.ops.push({ kind: 'lineTo', args: [x, y] });
  }

  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void {
    this.ops.push({ kind: 'arc', args: [x, y, radius, startAngle, endAngle] });
  }

  bezierCurveTo(
    c1x: number,
    c1y: number,
    c2x: number,
    c2y: number,
    x: number,
    y: number,
  ): void {
    this.ops.push({ kind: 'bezierCurveTo', args: [c1x, c1y, c2x, c2y, x, y] });
  }

  closePath(): void {
    this.ops.push({ kind: 'closePath', args: [] });
  }
}

interface FakeContext extends EdgeContext {
  readonly strokes: EdgePath[];
  readonly fills: EdgePath[];
}

function fakeContext(): FakeContext {
  const strokes: EdgePath[] = [];
  const fills: EdgePath[] = [];
  return {
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    stroke(path: EdgePath): void {
      strokes.push(path);
    },
    fill(path: EdgePath): void {
      fills.push(path);
    },
    strokes,
    fills,
  };
}

function curveEdge(id: string, y: number): ScreenEdge {
  const p0 = { x: 0, y };
  const p3 = { x: 200, y };
  return {
    id,
    straight: false,
    p0,
    c1: { x: 100, y },
    c2: { x: 100, y },
    p3,
    aabb: { left: 0, top: y, right: 200, bottom: y },
  };
}

function planOf(edges: readonly ScreenEdge[], straight = false): EdgeDrawPlan {
  return { straight, visibleCount: edges.length, edges, warning: null };
}

void test('普通边：两条曲线合并为单条 Path2D，一次 stroke + 一次箭头 fill', () => {
  const ctx = fakeContext();
  const paths: RecordingPath[] = [];
  const stats = drawEdgePlan(ctx, planOf([curveEdge('a', 10), curveEdge('b', 50)]), TEST_PALETTE, () => {
    const path = new RecordingPath();
    paths.push(path);
    return path;
  });

  assert.deepEqual(stats, { edges: 2, arrows: 2 });
  assert.equal(ctx.strokes.length, 1);
  assert.equal(ctx.fills.length, 1);
  assert.equal(ctx.lineWidth, 2.5);
  assert.equal(ctx.strokeStyle, TEST_PALETTE.edge);

  const strokeOps = paths[0]?.ops ?? [];
  assert.equal(strokeOps.filter((op) => op.kind === 'moveTo').length, 2);
  assert.equal(strokeOps.filter((op) => op.kind === 'bezierCurveTo').length, 2);

  const arrowOps = paths[1]?.ops ?? [];
  assert.equal(arrowOps.filter((op) => op.kind === 'closePath').length, 2);
});

void test('LOD 直线：只画 lineTo，不画箭头', () => {
  const ctx = fakeContext();
  const paths: RecordingPath[] = [];
  const stats = drawEdgePlan(ctx, planOf([curveEdge('a', 10)], true), TEST_PALETTE, () => {
    const path = new RecordingPath();
    paths.push(path);
    return path;
  });

  assert.deepEqual(stats, { edges: 1, arrows: 0 });
  assert.equal(ctx.fills.length, 0);
  assert.equal(ctx.lineWidth, 2);

  const ops = paths[0]?.ops ?? [];
  assert.equal(ops.filter((op) => op.kind === 'lineTo').length, 1);
  assert.equal(ops.filter((op) => op.kind === 'bezierCurveTo').length, 0);
});

void test('空计划（视口裁剪后无可见边 / E_EDGE_BUDGET）：零绘制调用', () => {
  const ctx = fakeContext();
  let created = 0;
  const stats = drawEdgePlan(ctx, planOf([]), TEST_PALETTE, () => {
    created += 1;
    return new RecordingPath();
  });

  assert.deepEqual(stats, { edges: 0, arrows: 0 });
  assert.equal(created, 0);
  assert.equal(ctx.strokes.length, 0);
  assert.equal(ctx.fills.length, 0);
});

void test('高亮层：选中边用独立画笔（2.5 px + selected 色），不被节点层共用', () => {
  const ctx = fakeContext();
  const paths: RecordingPath[] = [];
  const drawn = drawEdgeHighlight(
    ctx,
    [curveEdge('selected', 30)],
    TEST_PALETTE,
    () => {
      const path = new RecordingPath();
      paths.push(path);
      return path;
    },
  );

  assert.equal(drawn, 1);
  assert.equal(ctx.strokes.length, 1);
  assert.equal(ctx.fills.length, 1);
  assert.equal(ctx.lineWidth, 2.5);
  assert.equal(ctx.strokeStyle, TEST_PALETTE.selected);
  assert.equal(ctx.fillStyle, TEST_PALETTE.selected);
});

void test('高亮层：无选中边时零绘制调用', () => {
  const ctx = fakeContext();

  assert.equal(drawEdgeHighlight(ctx, [], TEST_PALETTE, () => new RecordingPath()), 0);
  assert.equal(ctx.strokes.length, 0);
  assert.equal(ctx.fills.length, 0);
});
