/**
 * 坐标三式、缩放锚点、clamp、LOD、视口范围与 C4 rebase 原子坐标变换。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BASE_SPACING,
  MAX_SCALE,
  MIN_GRID_PX,
  MIN_SCALE,
  createViewportTransform,
  fitRectsToViewport,
  gridLevel,
  gridStepWorld,
  panBy,
  rebase,
  rebaseOffset,
  resetView,
  screenToWorld,
  visibleWorldRect,
  worldToScreen,
  zoomAt,
} from '../../../src/app/canvas/viewport.ts';

const EPSILON = 1e-9;

function assertClose(actual: number, expected: number, message: string): void {
  assert.ok(
    Math.abs(actual - expected) < EPSILON,
    `${message}：actual=${String(actual)} expected=${String(expected)}`,
  );
}

void test('坐标三式：世界→屏幕→世界往返误差 < 1e-9', () => {
  const transform = createViewportTransform(37.5, -12.25, 2.5);
  const world = { x: 123.456, y: -789.012 };
  const screen = worldToScreen(transform, world);
  const roundTrip = screenToWorld(transform, screen);

  assertClose(roundTrip.x, world.x, 'x 往返');
  assertClose(roundTrip.y, world.y, 'y 往返');
});

void test('缩放锚点：以鼠标位置缩放后，鼠标下的世界坐标不变', () => {
  const before = createViewportTransform(10, 20, 1.7);
  const anchor = { x: 640, y: 360 };
  const worldBefore = screenToWorld(before, anchor);

  const after = zoomAt(before, anchor, 1.37);
  const worldAfter = screenToWorld(after, anchor);

  assertClose(worldAfter.x, worldBefore.x, '锚点 x');
  assertClose(worldAfter.y, worldBefore.y, '锚点 y');
  assertClose(after.scale, 1.7 * 1.37, '缩放倍率');
});

void test('缩放 clamp：钳到 [0.05, 8] 后仍满足锚点公式', () => {
  const anchor = { x: 320, y: 240 };

  const worldAtAnchor = screenToWorld(createViewportTransform(), anchor);
  const zoomedIn = zoomAt(createViewportTransform(), anchor, 1e6);
  assert.equal(zoomedIn.scale, MAX_SCALE);
  const inWorld = screenToWorld(zoomedIn, anchor);
  assertClose(inWorld.x, worldAtAnchor.x, '放大钳制后锚点 x');
  assertClose(inWorld.y, worldAtAnchor.y, '放大钳制后锚点 y');

  const pan = createViewportTransform(100, -50, 1);
  const worldBefore = screenToWorld(pan, anchor);
  const zoomedOut = zoomAt(pan, anchor, 1e-9);
  assert.equal(zoomedOut.scale, MIN_SCALE);
  assertClose(screenToWorld(zoomedOut, anchor).x, worldBefore.x, '缩小钳制后锚点 x');
  assertClose(screenToWorld(zoomedOut, anchor).y, worldBefore.y, '缩小钳制后锚点 y');
});

void test('平移：屏幕像素增量直接累加，不乘 scale', () => {
  const transform = createViewportTransform(-30, 40, 3);
  const moved = panBy(transform, { x: 7, y: -9 });

  assert.equal(moved.tx, -23);
  assert.equal(moved.ty, 31);
  assert.equal(moved.scale, 3);
});

void test('LOD：s=0.05/1/8 与设计表格一致（192/9.6、12/12、1.5/12）', () => {
  const cases = [
    { scale: 0.05, level: 3, stepWorld: 192, stepScreen: 9.6 },
    { scale: 1, level: -1, stepWorld: 12, stepScreen: 12 },
    { scale: 8, level: -4, stepWorld: 1.5, stepScreen: 12 },
  ] as const;

  for (const item of cases) {
    assert.equal(gridLevel(item.scale), item.level, `s=${String(item.scale)} 的 k`);
    assert.equal(gridStepWorld(item.scale), BASE_SPACING * 2 ** item.level);
    assertClose(gridStepWorld(item.scale) * item.scale, item.stepScreen, `s=${String(item.scale)} 的屏幕间距`);
    assert.ok(gridStepWorld(item.scale) * item.scale >= MIN_GRID_PX);
    assert.ok(gridStepWorld(item.scale) * item.scale < MIN_GRID_PX * 2);
  }
});

void test('视口裁剪：visibleWorldRect 覆盖屏幕四角对应的世界矩形', () => {
  const rect = visibleWorldRect(createViewportTransform(0, 0, 2), { width: 800, height: 600 });

  assert.equal(rect.left, 0);
  assert.equal(rect.top, 0);
  assert.equal(rect.right, 400);
  assert.equal(rect.bottom, 300);
});

void test('resetView：回到 100% 与原点，保留 rebase 偏移', () => {
  const reset = resetView(createViewportTransform(123, -45, 3, 24, -48));

  assert.equal(reset.tx, 0);
  assert.equal(reset.ty, 0);
  assert.equal(reset.scale, 1);
  assert.equal(reset.originX, 24);
  assert.equal(reset.originY, -48);
});

void test('fit：空矩形、零尺寸与非法视口安全 no-op', () => {
  const before = createViewportTransform(11, -7, 2, 24, -48);
  const size = { width: 800, height: 600 };
  assert.equal(fitRectsToViewport([], size, before), before);
  assert.equal(
    fitRectsToViewport([{ left: 0, top: 0, right: 0, bottom: 20 }], size, before),
    before,
  );
  assert.equal(
    fitRectsToViewport([{ left: 0, top: 0, right: Number.NaN, bottom: 20 }], size, before),
    before,
  );
  assert.equal(
    fitRectsToViewport([{ left: 0, top: 0, right: 20, bottom: 20 }], { width: 0, height: 600 }, before),
    before,
  );
});

void test('fit：单节点只居中不放大，并保留非零 origin', () => {
  const before = createViewportTransform(999, 888, 3, 240, -120);
  const fitted = fitRectsToViewport(
    [{ left: 1000, top: -500, right: 1160, bottom: -260 }],
    { width: 800, height: 600 },
    before,
  );
  assert.equal(fitted.scale, 1);
  assert.equal(fitted.originX, 240);
  assert.equal(fitted.originY, -120);
  assertClose((1000 + 1160) / 2 * fitted.scale + fitted.tx, 400, '世界中心 x');
  assertClose((-500 - 260) / 2 * fitted.scale + fitted.ty, 300, '世界中心 y');
});

void test('fit：跨象限多节点按合并 AABB 缩小，autoH 参与边界且全部留边可见', () => {
  const fitted = fitRectsToViewport(
    [
      { left: -1200, top: -800, right: -1040, bottom: -704 },
      { left: 800, top: 400, right: 960, bottom: 900 },
      { left: -100, top: -100, right: 60, bottom: 380 },
    ],
    { width: 800, height: 600 },
    createViewportTransform(),
    40,
  );
  assert.ok(fitted.scale < 1);
  assertClose((-1200 + 960) / 2 * fitted.scale + fitted.tx, 400, '合并中心 x');
  assertClose((-800 + 900) / 2 * fitted.scale + fitted.ty, 300, '合并中心 y');
  assert.ok(-1200 * fitted.scale + fitted.tx >= 40 - EPSILON);
  assert.ok(960 * fitted.scale + fitted.tx <= 760 + EPSILON);
  assert.ok(-800 * fitted.scale + fitted.ty >= 40 - EPSILON);
  assert.ok(900 * fitted.scale + fitted.ty <= 560 + EPSILON);
});

void test('fit：极端内容遵守 MIN_SCALE，非法矩形不影响有效矩形', () => {
  const fitted = fitRectsToViewport(
    [
      { left: 0, top: 0, right: 1e9, bottom: 10 },
      { left: 0, top: 0, right: Number.POSITIVE_INFINITY, bottom: 10 },
    ],
    { width: 800, height: 600 },
    createViewportTransform(),
  );
  assert.equal(fitted.scale, MIN_SCALE);
  assertClose((1e9 / 2) * fitted.scale + fitted.tx, 400, '钳制后仍对齐内容中心');
});

void test('rebase：O 为 24 整数倍，origin/t/实体同步后 local 与屏幕位置不变', () => {
  const transform = createViewportTransform(1250, -250, 2, 17, -29);
  const offset = rebaseOffset(transform);
  assert.deepEqual(offset, { x: 624, y: -120 });

  const rebased = rebase(transform, offset);
  assert.deepEqual(rebased, {
    tx: 2,
    ty: -10,
    scale: 2,
    originX: 641,
    originY: -149,
  });
  const absolute = { x: 117, y: 231 };
  const localBefore = {
    x: absolute.x - transform.originX,
    y: absolute.y - transform.originY,
  };
  const absoluteAfter = { x: absolute.x + offset.x, y: absolute.y + offset.y };
  const localAfter = {
    x: absoluteAfter.x - rebased.originX,
    y: absoluteAfter.y - rebased.originY,
  };
  assert.deepEqual(localAfter, localBefore);
  assertClose(worldToScreen(rebased, absoluteAfter).x, worldToScreen(transform, absolute).x, 'rebase 后屏幕 x 不变');
  assertClose(worldToScreen(rebased, absoluteAfter).y, worldToScreen(transform, absolute).y, 'rebase 后屏幕 y 不变');
});
