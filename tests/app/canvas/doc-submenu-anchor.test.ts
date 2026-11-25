import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  positionDocSubmenu,
  submenuStyleOffset,
} from '../../../src/app/canvas/doc-submenu-model.ts';

void test('包含块不在视口原点时，换算后的样式仍落在目标视口坐标', () => {
  const target = { left: 232, top: 45 };
  // 视口即包含块：原样写入。
  assert.deepEqual(submenuStyleOffset(target, { left: 0, top: 0 }), target);
  // 父菜单带 backdrop-filter 时，包含块原点偏离视口（含 1px 边框）。
  assert.deepEqual(submenuStyleOffset(target, { left: 41, top: 46 }), {
    left: 191,
    top: -1,
  });
});

void test('换算后的偏移叠加包含块原点，正好落到目标位置', () => {
  const target = { left: 300, top: 100 };
  const origin = { left: 40, top: 45 };
  const style = submenuStyleOffset(target, origin);
  assert.deepEqual(
    { left: origin.left + style.left, top: origin.top + style.top },
    target,
  );
});

void test('祖先缩放时按比例补偿，视觉位置不变', () => {
  assert.deepEqual(
    submenuStyleOffset({ left: 260, top: 90 }, { left: 40, top: 50 }, 2),
    { left: 110, top: 20 },
  );
});

void test('子面板 portal 到 body，直接写视口坐标（不再量包含块原点）', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/app/canvas/DocSubmenu.tsx'),
    'utf8',
  );
  // portal 到 document.body：脱离父菜单 DOM，fixed 包含块即视口。
  assert.match(source, /createPortal\(/);
  assert.match(source, /document\.body/);
  // 直接用 positionDocSubmenu 的视口结果写 left/top。
  assert.match(source, /panel\.style\.left = `\$\{target\.left\}px`;/);
  assert.match(source, /panel\.style\.top = `\$\{target\.top\}px`;/);
  assert.match(source, /panel\.style\.visibility = 'visible';/);
  // 旧的包含块原点补偿 hack（CR-20261122-64）应已移除。
  assert.doesNotMatch(source, /panel\.style\.left = '0px';/);
  assert.doesNotMatch(source, /const origin = panel\.getBoundingClientRect\(\);/);
  // 每一级只按当前触发项定位：不得再回退到父菜单顶边对齐。
  assert.doesNotMatch(source, /closest\('ul'\)/);
  assert.doesNotMatch(source, /parentTop/);
  assert.doesNotMatch(source, /alignTop/);
});

void test('视口空间不足时仍翻转并夹紧，避免子菜单跑出屏幕', () => {
  const anchor = { left: 700, top: 500, right: 780, bottom: 530 };
  const size = { width: 220, height: 120 };
  const viewport = { width: 800, height: 600 };
  const positioned = positionDocSubmenu(anchor, size, viewport);
  assert.equal(positioned.left, 476);
  // 底缘不足：贴当前触发项底边上翻（530 - 120），而非父菜单顶边。
  assert.equal(positioned.top, 410);
});
