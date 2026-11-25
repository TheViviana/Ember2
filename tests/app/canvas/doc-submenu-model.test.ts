import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  closeDocSubmenuFrom,
  createSubmenuRegistry,
  openDocSubmenuPath,
  positionDocSubmenu,
  toggleDocSubmenuPath,
} from '../../../src/app/canvas/doc-submenu-model.ts';

const anchor = { left: 100, top: 100, right: 180, bottom: 132 };
const viewport = { width: 1000, height: 800 };

void test('子菜单默认在父项右侧并对齐顶边', () => {
  assert.deepEqual(
    positionDocSubmenu(anchor, { width: 220, height: 180 }, viewport),
    { left: 184, top: 100 },
  );
});

void test('右缘溢出时向左翻转，左缘也不足时夹在视口内', () => {
  assert.deepEqual(
    positionDocSubmenu(
      { left: 760, top: 100, right: 900, bottom: 132 },
      { width: 220, height: 180 },
      viewport,
    ),
    { left: 536, top: 100 },
  );
  assert.deepEqual(
    positionDocSubmenu(
      { left: 4, top: 100, right: 980, bottom: 132 },
      { width: 220, height: 180 },
      { width: 600, height: 800 },
    ),
    { left: 8, top: 100 },
  );
});

void test('底缘溢出时向上翻转，双向溢出可同时翻转', () => {
  assert.deepEqual(
    positionDocSubmenu(
      { left: 100, top: 700, right: 180, bottom: 760 },
      { width: 220, height: 180 },
      viewport,
    ),
    { left: 184, top: 580 },
  );
  assert.deepEqual(
    positionDocSubmenu(
      { left: 760, top: 700, right: 900, bottom: 760 },
      { width: 220, height: 180 },
      viewport,
    ),
    { left: 536, top: 580 },
  );
});

void test('窄小视口与超高面板仍保持可见边距', () => {
  assert.deepEqual(
    positionDocSubmenu(
      { left: 20, top: 30, right: 160, bottom: 60 },
      { width: 220, height: 500 },
      { width: 200, height: 300 },
    ),
    { left: 8, top: 8 },
  );
});

void test('同层目录替换并裁掉更深层，文件悬停可关闭当前层子面板', () => {
  const opened = openDocSubmenuPath(['A', 'A-1'], 0, 'B');
  assert.deepEqual(opened, ['B']);
  assert.deepEqual(openDocSubmenuPath(opened, 1, 'B-1'), ['B', 'B-1']);
  assert.deepEqual(closeDocSubmenuFrom(['B', 'B-1', 'B-1-a'], 1), ['B']);
});

void test('目录点击在切换关闭与同层替换之间变化', () => {
  assert.deepEqual(toggleDocSubmenuPath([], 0, 'A'), ['A']);
  assert.deepEqual(toggleDocSubmenuPath(['A', 'A-1'], 0, 'A'), []);
  assert.deepEqual(toggleDocSubmenuPath(['A', 'A-1'], 1, 'A-2'), ['A', 'A-2']);
});

void test('登记簿：claim 新实例前先收起当前打开者（互斥）', () => {
  const registry = createSubmenuRegistry();
  const calls: string[] = [];
  registry.claim('A', () => calls.push('close-A'));
  registry.claim('B', () => calls.push('close-B'));
  assert.deepEqual(calls, ['close-A'], '打开 B 必须先收起 A');
  assert.equal(registry.activeId, 'B');
});

void test('登记簿：release 仅匹配当前 id 生效，旧实例晚到不误伤', () => {
  const registry = createSubmenuRegistry();
  registry.claim('A', () => undefined);
  registry.claim('B', () => undefined);
  registry.release('A');
  assert.equal(registry.activeId, 'B', '旧实例 A 的晚到释放不得清掉 B');
  registry.release('B');
  assert.equal(registry.activeId, null);
});

void test('登记簿：closeActive 收起当前打开者并清位，空登记时无操作', () => {
  const registry = createSubmenuRegistry();
  let closed = 0;
  registry.closeActive();
  assert.equal(closed, 0, '无打开者时 closeActive 必须无操作');
  registry.claim('A', () => {
    closed += 1;
    registry.release('A');
  });
  registry.closeActive();
  assert.equal(closed, 1);
  assert.equal(registry.activeId, null, '收起回调自身 release 后登记位清空');
});

void test('登记簿：同 id 重复 claim 不触发收起且更新回调', () => {
  const registry = createSubmenuRegistry();
  const calls: string[] = [];
  registry.claim('A', () => calls.push('old'));
  registry.claim('A', () => calls.push('new'));
  assert.deepEqual(calls, [], '同实例重复 claim 不得自收起');
  registry.closeActive();
  assert.deepEqual(calls, ['new'], 'closeActive 调用最新回调');
});

void test('每一级子菜单只跟随当前触发项，不与父菜单顶边对齐', () => {
  // 父菜单顶边可能在 200，但触发项在 100：子面板仍贴当前项。
  assert.deepEqual(
    positionDocSubmenu(anchor, { width: 220, height: 180 }, viewport),
    { left: 184, top: 100 },
  );
  // 底部不足时按当前触发项底边上翻，不用父菜单顶边收缩。
  assert.deepEqual(
    positionDocSubmenu(
      { left: 100, top: 700, right: 180, bottom: 760 },
      { width: 220, height: 180 },
      viewport,
    ),
    { left: 184, top: 580 },
  );
});
