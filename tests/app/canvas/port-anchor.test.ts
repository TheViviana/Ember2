/**
 * R1：端口圆点中心必须与 edge-layout 的 border-box 外边缘锚点重合。
 *
 * CSS 无法在 node:test 中布局，因此读取源码锁定两条不变量：
 * 1. 节点为 border-box + 1px 边框；
 * 2. 外置圆点相对 padding box 再外移 1px。
 * 几何侧再断言 100% / 200% 缩放下锚点等于节点外边缘。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { buildScreenEdges } from '../../../src/app/canvas/edge-layout.ts';
import { nodeSizeOf, type CanvasNodeView } from '../../../src/app/canvas/node-layout.ts';
import { createViewportTransform } from '../../../src/app/canvas/viewport.ts';

const viewCss = readFileSync(
  new URL('../../../src/app/canvas/CanvasView.module.css', import.meta.url),
  'utf8',
);
const canvasCss = readFileSync(
  new URL('../../../src/app/canvas/canvas.module.css', import.meta.url),
  'utf8',
);

void test('节点盒为 border-box + 1px 边框（锚点按其外边缘计算）', () => {
  assert.match(canvasCss, /\.node\s*\{[^}]*box-sizing:\s*border-box;/s);
  assert.match(canvasCss, /\.node\s*\{[^}]*border:\s*1px solid/s);
});

void test('端口圆点相对 padding box 外移 1px，中心落在 border-box 边缘', () => {
  assert.match(viewCss, /::before\s*\{\s*left:\s*calc\(-4px - 1px\);/);
  assert.match(viewCss, /::after\s*\{\s*right:\s*calc\(-4px - 1px\);/);
});

void test('100% / 200% 缩放：连线端点等于节点外边缘中点', () => {
  const from: CanvasNodeView = { id: 'a', label: 'A', x: 10, y: 20, w: 240, h: 120 };
  const to: CanvasNodeView = { id: 'b', label: 'B', x: 400, y: 300, w: 100, h: 60 };

  for (const scale of [1, 2]) {
    const transform = { ...createViewportTransform(), scale };
    const [edge] = buildScreenEdges([{ id: 'e', from: 'a', to: 'b' }], [from, to], transform);
    assert.ok(edge !== undefined);

    // 世界坐标 → 屏幕：composeScreenPosition 展开为 absolute * scale + 平移（origin 抵消）。
    const screenX = (x: number): number => x * scale + transform.tx;
    const screenY = (y: number): number => y * scale + transform.ty;

    const fromSize = nodeSizeOf(from);
    const toSize = nodeSizeOf(to);
    assert.equal(edge.p0.x, screenX(from.x + fromSize.w));
    assert.equal(edge.p0.y, screenY(from.y + fromSize.h / 2));
    assert.equal(edge.p3.x, screenX(to.x));
    assert.equal(edge.p3.y, screenY(to.y + toSize.h / 2));
  }
});
