import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createInteractionState,
  isMediaChromePress,
  reduceInteraction,
  setInteractionSelection,
  type InteractionEffect,
  type InteractionState,
} from '../../../src/app/canvas/interaction.ts';
import type { CanvasNodeView } from '../../../src/app/canvas/node-layout.ts';

const nodes: readonly CanvasNodeView[] = [
  { id: 'a', label: 'A', x: 0, y: 0 },
  { id: 'b', label: 'B', x: 200, y: 100 },
];

function down(
  state: InteractionState,
  target: { readonly kind: 'node' | 'edge' | 'blank'; readonly id?: string },
  options: { shift?: boolean; toggle?: boolean; alt?: boolean; pan?: boolean; button?: number } = {},
) {
  const id = target.id ?? '';
  return reduceInteraction(state, {
    type: 'pointerDown',
    point: { x: 10, y: 10 },
    button: options.button ?? 0,
    shiftKey: options.shift ?? false,
    toggleKey: options.toggle ?? false,
    altKey: options.alt ?? false,
    pan: options.pan ?? false,
    target: target.kind === 'blank' ? { kind: 'blank' } : { kind: target.kind, id },
    nodes,
  });
}

function effect<T extends InteractionEffect['type']>(
  effects: readonly InteractionEffect[],
  type: T,
): Extract<InteractionEffect, { type: T }> {
  const found = effects.find((item) => item.type === type);
  assert.ok(found !== undefined && found.type === type);
  return found as Extract<InteractionEffect, { type: T }>;
}

void test('一次拖拽只提交一条 move；scale=2 时屏幕增量折半，选中不产生命令', () => {
  let state = setInteractionSelection(createInteractionState(), {
    nodes: new Set(['a', 'b']),
    edges: new Set(['e1']),
  });
  const started = down(state, { kind: 'node', id: 'a' });
  state = started.state;
  assert.deepEqual([...state.selection.nodes], ['a', 'b']);
  assert.deepEqual([...state.selection.edges], [], '普通节点拖拽清除边选中，但保留多选节点');

  const moved = reduceInteraction(state, { type: 'pointerMove', point: { x: 30, y: 40 }, scale: 2 });
  state = moved.state;
  assert.deepEqual(
    effect(moved.effects, 'preview').positions.map(({ id, x, y }) => ({ id, x, y })),
    [
      { id: 'a', x: 10, y: 15 },
      { id: 'b', x: 210, y: 115 },
    ],
  );
  assert.equal(moved.effects.some((item) => item.type === 'commit'), false);

  const ended = reduceInteraction(state, { type: 'pointerUp', point: { x: 30, y: 40 }, scale: 2 });
  const commands = ended.effects.filter((item) => item.type === 'commit');
  assert.equal(commands.length, 1);
  assert.deepEqual(effect(ended.effects, 'commit').command, {
    kind: 'move',
    entries: [
      { id: 'a', dx: 10, dy: 15 },
      { id: 'b', dx: 10, dy: 15 },
    ],
  });
});

void test('Esc 还原拖拽预览且不提交命令，选中集合恢复到手势前', () => {
  const initial = createInteractionState();
  const started = down(initial, { kind: 'node', id: 'a' });
  const moved = reduceInteraction(started.state, {
    type: 'pointerMove',
    point: { x: 50, y: 70 },
    scale: 1,
  });
  const cancelled = reduceInteraction(moved.state, { type: 'cancel' });

  assert.deepEqual(effect(cancelled.effects, 'preview').positions, nodes.slice(0, 1));
  assert.equal(cancelled.effects.some((item) => item.type === 'commit'), false);
  assert.equal(cancelled.state.gesture, null);
  assert.equal(cancelled.state.selection.nodes.size, 0);
});

void test('Shift 加选、Cmd/Ctrl 切换节点与边，切换手势不启动拖拽', () => {
  let state = createInteractionState();
  state = down(state, { kind: 'node', id: 'a' }).state;
  state = reduceInteraction(state, { type: 'pointerUp', point: { x: 10, y: 10 }, scale: 1 }).state;
  state = down(state, { kind: 'node', id: 'b' }, { shift: true }).state;
  assert.deepEqual([...state.selection.nodes], ['a', 'b']);

  const toggled = down(state, { kind: 'edge', id: 'e1' }, { toggle: true });
  state = toggled.state;
  assert.deepEqual([...state.selection.edges], ['e1']);
  assert.equal(state.gesture, null);
  state = down(state, { kind: 'edge', id: 'e1' }, { toggle: true }).state;
  assert.equal(state.selection.edges.size, 0);
});

void test('框选达到 4px 才显示；提交只选节点，Shift 框选追加并保留已选边', () => {
  let state = setInteractionSelection(createInteractionState(), {
    nodes: new Set(['a']),
    edges: new Set(['e1']),
  });
  state = down(state, { kind: 'blank' }, { shift: true }).state;
  const below = reduceInteraction(state, { type: 'pointerMove', point: { x: 13, y: 10 }, scale: 1 });
  assert.equal(below.effects.some((item) => item.type === 'marquee'), false);
  const reached = reduceInteraction(below.state, {
    type: 'pointerMove',
    point: { x: 14, y: 10 },
    scale: 1,
  });
  assert.deepEqual(effect(reached.effects, 'marquee').rect, { left: 10, top: 10, right: 14, bottom: 10 });

  const ended = reduceInteraction(reached.state, {
    type: 'pointerUp',
    point: { x: 14, y: 10 },
    scale: 1,
    marqueeNodeIds: ['b'],
  });
  assert.deepEqual([...ended.state.selection.nodes], ['a', 'b']);
  assert.deepEqual([...ended.state.selection.edges], ['e1']);
  assert.equal(effect(ended.effects, 'marquee').rect, null);
});

void test('中键或 Space+左键平移；空白普通点击清空选中', () => {
  for (const options of [{ button: 1 }, { pan: true }]) {
    const started = down(createInteractionState(), { kind: 'blank' }, options);
    assert.equal(started.state.gesture?.kind, 'pan');
    const moved = reduceInteraction(started.state, {
      type: 'pointerMove',
      point: { x: 25, y: 30 },
      scale: 8,
    });
    assert.deepEqual(effect(moved.effects, 'pan').delta, { x: 15, y: 20 });
  }

  const selected = setInteractionSelection(createInteractionState(), {
    nodes: new Set(['a']),
    edges: new Set(['e1']),
  });
  const cleared = down(selected, { kind: 'blank' });
  assert.equal(cleared.state.selection.nodes.size, 0);
  assert.equal(cleared.state.selection.edges.size, 0);
});

// CR-20261121-46：媒体控件区命中判定（engine 提取 DOM 值后调用，本层只管纯逻辑）。
// CR-20261121-56：音频=自定义控件条纵向范围（rect.top~bottom），条外卡体放行。
void test('isMediaChromePress：音频=控件条纵向范围，条外放行', () => {
  const rect = { top: 100, bottom: 132 };
  assert.equal(isMediaChromePress('audio', rect, 100), true, '控件条上沿');
  assert.equal(isMediaChromePress('audio', rect, 132), true, '控件条下沿');
  assert.equal(isMediaChromePress('audio', rect, 99.5), false, '控件条上方放行给卡体拖拽');
  assert.equal(isMediaChromePress('audio', rect, 132.5), false, '控件条下方放行');
  assert.equal(isMediaChromePress('audio', null, 0), false, '拿不到 rect 不拦截');
});

void test('isMediaChromePress：视频只让出底部控件条，画面本体可拖', () => {
  const bottom = 300;
  const rect = { top: 204, bottom };
  assert.equal(isMediaChromePress('video', rect, 300), true, '控件条底边');
  assert.equal(isMediaChromePress('video', rect, 300 - 44), true, '控件条上沿（44px 带）');
  assert.equal(isMediaChromePress('video', rect, 300 - 44.5), false, '传输条上方 1px 即画面本体');
  assert.equal(isMediaChromePress('video', rect, 205), true, '顶部控件带上沿（全屏/画中画让位）');
  assert.equal(isMediaChromePress('video', rect, 248), true, '顶部控件带下沿（44px）');
  assert.equal(isMediaChromePress('video', rect, 250), false, '顶部控件带下方放行');
  assert.equal(isMediaChromePress('video', rect, 252), false, '两条控件带之间的画面中部放行');
  assert.equal(isMediaChromePress('video', null, 300), false, '拿不到 rect 时不拦（假 DOM 安全）');
});

void test('isMediaChromePress：非媒体元素一律放行', () => {
  assert.equal(isMediaChromePress(null, { top: 400, bottom: 500 }, 499), false, '非媒体元素');
  assert.equal(isMediaChromePress('image', { top: 400, bottom: 500 }, 499), false, '未知标记值视为非控件区');
});
