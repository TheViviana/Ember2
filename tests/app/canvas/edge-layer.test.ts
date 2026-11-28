/**
 * C3 连线绘制单测：批量 Path2D（一次 stroke）、LOD 直线、箭头批量、空计划零调用、
 * 高亮层独立画笔。用假 path/ctx 记录调用，不需要浏览器。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EdgeDrawPlan, EdgeStyleView, ScreenEdge } from '../../../src/app/canvas/edge-layout.ts';
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

const DEFAULT_STYLE: EdgeStyleView = {
  line: 'solid',
  arrow: 'end',
  color: 'default',
  route: 'curve',
};

function styledEdge(id: string, y: number, style: Partial<EdgeStyleView>): ScreenEdge {
  return { ...curveEdge(id, y), style: { ...DEFAULT_STYLE, ...style } };
}

void test('普通边：两条曲线合并为单条 Path2D，一次描边 + 一次实心箭头填充', () => {
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
  assert.equal(ctx.fillStyle, TEST_PALETTE.arrow);

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

void test('连线标签：具备文本能力时在中点绘制文字 pill', () => {
  const texts: string[] = [];
  const rects: number[] = [];
  const ctx: EdgeContext = {
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    stroke(): void {},
    fill(): void {},
    fillText(text: string): void {
      texts.push(text);
    },
    measureText(text: string): { readonly width: number } {
      return { width: text.length * 6 };
    },
    fillRect(): void {
      rects.push(1);
    },
  };
  const labeled = { ...curveEdge('labeled', 20), label: '进行中' };
  drawEdgePlan(ctx, planOf([labeled]), TEST_PALETTE, () => new RecordingPath());
  assert.deepEqual(texts, ['进行中']);
  assert.equal(rects.length, 1);
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

void test('直角折线绘制：lineTo + 8px 圆角，route 无 points 时回退贝塞尔', () => {
  const ortho: ScreenEdge = {
    ...curveEdge('ortho', 10),
    p0: { x: 0, y: 0 },
    c1: { x: 50, y: 0 },
    c2: { x: 50, y: 100 },
    p3: { x: 100, y: 100 },
    aabb: { left: 0, top: 0, right: 100, bottom: 100 },
    style: { ...DEFAULT_STYLE, route: 'orthogonal' },
    route: 'orthogonal',
    points: [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 100 },
      { x: 100, y: 100 },
    ],
  };
  const orthoPaths: RecordingPath[] = [];
  drawEdgePlan(fakeContext(), planOf([ortho]), TEST_PALETTE, () => {
    const path = new RecordingPath();
    orthoPaths.push(path);
    return path;
  });
  const orthoOps = orthoPaths[0]?.ops ?? [];
  assert.equal(orthoOps.filter((op) => op.kind === 'bezierCurveTo').length, 2);
  assert.equal(orthoOps.filter((op) => op.kind === 'lineTo').length, 3);

  /* 缺 points（旧文件/渲染逻辑缺失）时按贝塞尔绘制，绝不留空白。 */
  const fallback: ScreenEdge = { ...ortho, points: undefined };
  const fallbackPaths: RecordingPath[] = [];
  drawEdgePlan(fakeContext(), planOf([fallback]), TEST_PALETTE, () => {
    const path = new RecordingPath();
    fallbackPaths.push(path);
    return path;
  });
  const fallbackOps = fallbackPaths[0]?.ops ?? [];
  assert.equal(fallbackOps.filter((op) => op.kind === 'bezierCurveTo').length, 1);
  assert.equal(fallbackOps.some((op) => op.kind === 'lineTo'), false);
});

void test('高亮层：无选中边时零绘制调用', () => {
  const ctx = fakeContext();

  assert.equal(drawEdgeHighlight(ctx, [], TEST_PALETTE, () => new RecordingPath()), 0);
  assert.equal(ctx.strokes.length, 0);
  assert.equal(ctx.fills.length, 0);
});

void test('虚线：setLineDash([7,5]) 绘制后复位，柔光不叠虚线', () => {
  const dashCalls: (readonly number[])[] = [];
  const base = fakeContext();
  const ctx: FakeContext = {
    ...base,
    setLineDash(segments: readonly number[]): void {
      dashCalls.push(segments);
    },
  };

  const stats = drawEdgePlan(
    ctx,
    planOf([styledEdge('dashed', 10, { line: 'dashed' })]),
    { ...TEST_PALETTE, glow: '#999999' },
    () => new RecordingPath(),
  );

  assert.deepEqual(stats, { edges: 1, arrows: 1 });
  assert.deepEqual(dashCalls, [[7, 5], []]);
  // 柔光只给实线：虚线仍然只有一次普通描边，箭头是独立实心填充。
  assert.equal(ctx.strokes.length, 1);
  assert.equal(ctx.fills.length, 1);
});

void test('箭头三态：both 两端各一点，none 不画箭头', () => {
  const bothCtx = fakeContext();
  const bothPaths: RecordingPath[] = [];
  drawEdgePlan(bothCtx, planOf([styledEdge('both', 10, { arrow: 'both' })]), TEST_PALETTE, () => {
    const path = new RecordingPath();
    bothPaths.push(path);
    return path;
  });
  const bothArrowOps = bothPaths[1]?.ops ?? [];
  const bothTips = bothArrowOps.filter((op) => op.kind === 'moveTo');
  assert.equal(bothTips.length, 2);
  assert.equal(bothTips.every((op) => Math.abs((op.args[1] ?? 0) - 10) < 1e-6), true);
  assert.equal(bothTips.every((op) => (op.args[0] ?? 0) > 0 && (op.args[0] ?? 0) < 200), true);
  assert.equal(bothArrowOps.filter((op) => op.kind === 'closePath').length, 2);

  const noneCtx = fakeContext();
  const noneStats = drawEdgePlan(
    noneCtx,
    planOf([styledEdge('none', 10, { arrow: 'none' })]),
    TEST_PALETTE,
    () => new RecordingPath(),
  );
  assert.deepEqual(noneStats, { edges: 1, arrows: 0 });
  assert.equal(noneCtx.fills.length, 0);
});

void test('陡峭曲线：箭头沿曲线切线倾斜，不悬浮在端点水平线上', () => {
  const edge: ScreenEdge = {
    id: 'steep',
    straight: false,
    p0: { x: 0, y: 0 },
    c1: { x: 30, y: 0 },
    c2: { x: 30, y: 100 },
    p3: { x: 60, y: 100 },
    aabb: { left: 0, top: 0, right: 60, bottom: 100 },
    style: { ...DEFAULT_STYLE, arrow: 'end' },
  };
  const paths: RecordingPath[] = [];
  drawEdgePlan(fakeContext(), planOf([edge]), TEST_PALETTE, () => {
    const path = new RecordingPath();
    paths.push(path);
    return path;
  });

  const ops = paths[1]?.ops ?? [];
  const tip = ops.find((op) => op.kind === 'moveTo');
  const wings = ops.filter((op) => op.kind === 'lineTo');
  assert.ok(tip !== undefined && wings.length === 2);
  const base = {
    x: ((wings[0]?.args[0] ?? 0) + (wings[1]?.args[0] ?? 0)) / 2,
    y: ((wings[0]?.args[1] ?? 0) + (wings[1]?.args[1] ?? 0)) / 2,
  };
  const dx = (tip?.args[0] ?? 0) - base.x;
  const dy = (tip?.args[1] ?? 0) - base.y;
  const length = Math.hypot(dx, dy);
  /* 终点切线应明显向下（向右下进线），而不是旧实现的纯水平方向。 */
  assert.equal(Math.abs(dy / length) > 0.2, true);
  assert.equal((tip?.args[1] ?? 0) > 80, true);
});

void test('颜色分组：默认与语义色各一次 stroke / fill，端点跟随连线颜色', () => {
  const ctx = fakeContext();
  const stats = drawEdgePlan(
    ctx,
    planOf([
      styledEdge('default', 10, { color: 'default' }),
      styledEdge('primary', 40, { color: 'primary' }),
    ]),
    { ...TEST_PALETTE, colorPrimary: '#404040' },
    () => new RecordingPath(),
  );

  assert.deepEqual(stats, { edges: 2, arrows: 2 });
  assert.equal(ctx.strokes.length, 2);
  assert.equal(ctx.fills.length, 2);
  assert.equal(ctx.strokeStyle, '#404040');
  assert.equal(ctx.fillStyle, '#404040');
});

void test('高亮层：related 先以 0.4 透明度弱描边，再复位画选中边', () => {
  const alphaAtStroke: number[] = [];
  const strokes: EdgePath[] = [];
  const ctx: EdgeContext = {
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    globalAlpha: 1,
    stroke(path: EdgePath): void {
      strokes.push(path);
      alphaAtStroke.push(this.globalAlpha ?? 1);
    },
    fill(): void {},
  };

  const drawn = drawEdgeHighlight(
    ctx,
    [styledEdge('selected', 10, {})],
    TEST_PALETTE,
    () => new RecordingPath(),
    [styledEdge('related', 50, {})],
  );

  assert.equal(drawn, 1);
  assert.deepEqual(alphaAtStroke, [0.4, 1]);
  assert.equal(ctx.globalAlpha, 1);
});
