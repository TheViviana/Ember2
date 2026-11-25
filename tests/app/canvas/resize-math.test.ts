/**
 * CR-20261119-11：8 方向缩放纯函数（node --test 链可直接跑，零 engine 假件）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cursorForResizeDir,
  computeResizeResult,
  resolveResizeZone,
  type ResizeDir,
  type ResizeRect,
} from '../../../src/app/canvas/resize-math.ts';

const ORIGIN = { x: 100, y: 100, w: 200, h: 120 };

// === A1：8 方向对边锚定 ===

void test('A1-se：右下拖 → x/y 不变，w/h 增加', () => {
  const r = computeResizeResult(ORIGIN, { dx: 50, dy: 30 }, 'se');
  assert.deepEqual(r, { x: 100, y: 100, w: 250, h: 150 });
});

void test('A1-nw：左上拖 → x/y 左/上移，w/h 增加（锚定右/下）', () => {
  const r = computeResizeResult(ORIGIN, { dx: -50, dy: -30 }, 'nw');
  // 原始 origin.w=200，nw 左拖 -50 → w=250，x 回退 origin.x + origin.w - w = 100 + 200 - 250 = 50
  // origin.h=120，nw 上拖 -30 → h=150，y 回退 origin.y + origin.h - h = 100 + 120 - 150 = 70
  assert.deepEqual(r, { x: 50, y: 70, w: 250, h: 150 });
});

void test('A1-n：上拖 → 仅 y/h 变，x/w 不变（锚定底部）', () => {
  const r = computeResizeResult(ORIGIN, { dx: 0, dy: -40 }, 'n');
  assert.deepEqual(r, { x: 100, y: 60, w: 200, h: 160 });
});

void test('A1-s：下拖 → 仅 h 变，x/y/w 不变（锚定顶部）', () => {
  const r = computeResizeResult(ORIGIN, { dx: 0, dy: 40 }, 's');
  assert.deepEqual(r, { x: 100, y: 100, w: 200, h: 160 });
});

void test('A1-e：右拖 → 仅 w 变，x/y/h 不变（锚定左侧）', () => {
  const r = computeResizeResult(ORIGIN, { dx: 50, dy: 0 }, 'e');
  assert.deepEqual(r, { x: 100, y: 100, w: 250, h: 120 });
});

void test('A1-w：左拖 → x/w 变，y/h 不变（锚定右侧）', () => {
  const r = computeResizeResult(ORIGIN, { dx: -50, dy: 0 }, 'w');
  assert.deepEqual(r, { x: 50, y: 100, w: 250, h: 120 });
});

void test('A1-ne：右上拖 → x/y/h 变，w 增（锚定左/下）', () => {
  const r = computeResizeResult(ORIGIN, { dx: 50, dy: -30 }, 'ne');
  // w = 200+50=250（锚定左 x 不变）；h = 120+30=150（锚定下 y=100+120-150=70）
  assert.deepEqual(r, { x: 100, y: 70, w: 250, h: 150 });
});

void test('A1-sw：左下拖 → x/w/h 变（锚定右/上）', () => {
  const r = computeResizeResult(ORIGIN, { dx: -50, dy: 30 }, 'sw');
  // w = 200+50=250（锚定右 x=100+200-250=50）；h = 120+30=150（锚定上 y 不变）
  assert.deepEqual(r, { x: 50, y: 100, w: 250, h: 150 });
});

// === A2：nw min 钳制 x 回退（锚定右边缘不动） ===

void test('A2-nw-min：右拖左上锚点 w 被钳到 80，x 回退 origin.x + origin.w - minW（锚定右边缘）', () => {
  // nw 方向向右拖（delta.dx 为正），w 减小：w = 200 - 150 = 50 < min 钳到 80
  const r = computeResizeResult(ORIGIN, { dx: 150, dy: 0 }, 'nw', 80, 48);
  // origin.x + origin.w = 300 = r.x + r.w（锚定右边缘）
  // r.x = 300 - 80 = 220
  assert.deepEqual(r, { x: 220, y: 100, w: 80, h: 120 });
});

// === A3：se min 钳制 x 不变（锚定左边缘） ===

void test('A3-se-min：w 被钳到 80，x 不变（锚定左边缘）', () => {
  const r = computeResizeResult(ORIGIN, { dx: -150, dy: 0 }, 'se', 80, 48);
  // w = 200-150=50 < 80 → 钳到 80；se 锚定左边缘 → x 仍 100
  assert.deepEqual(r, { x: 100, y: 100, w: 80, h: 120 });
});

// === A4：portZone 双轴（单轴 slice 不命中） ===

void test('A4-port-zone-双轴：端口在 (left, centerY) 或 (right, centerY)，点需同时命中 x/y 才是 port', () => {
  // 80×48 节点
  const rect: ResizeRect = { left: 0, top: 0, right: 80, bottom: 48 };
  // 单轴 slice 只命中 x=0（左边缘），但 y 不在 [centerY-16, centerY+16]=[8,40] → 不是 port zone
  assert.equal(resolveResizeZone(rect, { x: 0, y: 2 }).dir, 'nw');  // 角优先
  assert.equal(resolveResizeZone(rect, { x: 0, y: 46 }).dir, 'sw'); // 角优先
  // 真正的双轴 port zone
  assert.equal(resolveResizeZone(rect, { x: 2, y: 24 }).port, 'left');
  assert.equal(resolveResizeZone(rect, { x: 78, y: 24 }).port, 'right');
});

// === A5：优先级角 > 边 > 端口 > 节点 ===

void test('A5-优先级：角 zone > port zone > 边 > 节点', () => {
  const rect: ResizeRect = { left: 0, top: 0, right: 80, bottom: 48 };
  // 角 zone 和 port zone 在 y∈[0,12]∩[8,40]=[8,12] 有重叠，角优先
  const overlap = resolveResizeZone(rect, { x: 10, y: 10 });
  assert.equal(overlap.dir, 'nw');  // 不是 port
  // 边 zone 在 port zone 外才生效
  // 纯边（非角非 port）——但 80×48 上竖边被吃掉，e/w 永不返回
  const topEdge = resolveResizeZone(rect, { x: 40, y: 6 });  // 上边缘中间、非角非 port
  assert.equal(topEdge.dir, 'n');
});

// === A6：80×48 任何 e/w 点都不返回 'e'/'w' ===

void test('A6-80x48：竖边被完全吃掉（2*PORT_LEAVE+2*corner=56≥48），resolveResizeZone 永不返回 e/w', () => {
  const rect: ResizeRect = { left: 0, top: 0, right: 80, bottom: 48 };
  // 竖边上每一个点：要么命中角（y<12 或 y>36），要么命中 port zone（y∈[8,40]）
  // 没有一个点落在 port zone 外 + 角外 + 边内
  for (let y = 0; y <= 48; y += 2) {
    const leftZone = resolveResizeZone(rect, { x: 4, y });
    const rightZone = resolveResizeZone(rect, { x: 76, y });
    assert.notEqual(leftZone.dir, 'w', `left edge y=${y} should never return 'w'`);
    assert.notEqual(rightZone.dir, 'e', `right edge y=${y} should never return 'e'`);
  }
});

// === A7：cursorForResizeDir 8 方向 ===

void test('A7-cursorForResizeDir', () => {
  const cases: Array<[ResizeDir, string]> = [
    ['se', 'nwse-resize'], ['nw', 'nwse-resize'],
    ['ne', 'nesw-resize'], ['sw', 'nesw-resize'],
    ['n', 'ns-resize'], ['s', 'ns-resize'],
    ['e', 'ew-resize'], ['w', 'ew-resize'],
  ];
  for (const [dir, expected] of cases) {
    assert.equal(cursorForResizeDir(dir), expected, dir);
  }
});
