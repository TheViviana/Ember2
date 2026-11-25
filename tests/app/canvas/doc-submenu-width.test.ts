import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DOC_SUBMENU_MAX_WIDTH,
  DOC_SUBMENU_MIN_WIDTH,
  positionDocSubmenu,
} from '../../../src/app/canvas/doc-submenu-model.ts';

const viewport = { width: 1280, height: 800 };

void test('S5：最小宽度 220 与最长宽度 400 的自适应面板都按右侧展开', () => {
  const anchor = { left: 100, top: 100, right: 200, bottom: 124 };
  assert.deepEqual(
    positionDocSubmenu(anchor, { width: DOC_SUBMENU_MIN_WIDTH, height: 180 }, viewport),
    { left: 204, top: 100 },
  );
  assert.deepEqual(
    positionDocSubmenu(anchor, { width: DOC_SUBMENU_MAX_WIDTH, height: 180 }, viewport),
    { left: 204, top: 100 },
  );
});

void test('S5：自适应加宽后右缘不足就左翻，而不是压出视口', () => {
  const anchor = { left: 1000, top: 100, right: 1100, bottom: 124 };
  assert.deepEqual(
    positionDocSubmenu(anchor, { width: DOC_SUBMENU_MIN_WIDTH, height: 180 }, viewport),
    { left: 776, top: 100 },
  );
  assert.deepEqual(
    positionDocSubmenu(anchor, { width: DOC_SUBMENU_MAX_WIDTH, height: 180 }, viewport),
    { left: 596, top: 100 },
  );
});

void test('S5：最大宽度面板在窄视口内被夹到边距，不会横向溢出', () => {
  const narrow = { width: 480, height: 600 };
  const anchor = { left: 20, top: 60, right: 120, bottom: 84 };
  assert.deepEqual(
    positionDocSubmenu(anchor, { width: DOC_SUBMENU_MAX_WIDTH, height: 200 }, narrow),
    { left: 8, top: 60 },
  );
});
