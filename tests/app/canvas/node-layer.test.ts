/**
 * C2 节点 DOM 层单测：挂载点唯一（只挂 `world-layer.getWorldElement()`）、
 * left/top = absolute - origin、增量更新与 dispose。
 *
 * 用可注入的假元素避免引入 DOM 依赖；真实 DOM 的「viewport 内唯一挂载点」归 C2 浏览器测试。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanvasNodeView } from '../../../src/app/canvas/node-layout.ts';
import { createNodeLayer, type NodeLayerParent } from '../../../src/app/canvas/node-layer.ts';
import { readFileSync } from 'node:fs';
import { createViewportTransform } from '../../../src/app/canvas/viewport.ts';

interface FakeElement {
  className: string;
  textContent: string;
  style: { left: string; top: string };
  dataset: Record<string, string>;
  attributes: Record<string, string>;
  parent: FakeElement | null;
  children: FakeElement[];
  removed: number;
  append(...children: FakeElement[]): void;
  remove(): void;
  setAttribute(name: string, value: string): void;
}

function fakeElement(): FakeElement {
  const element: FakeElement = {
    className: '',
    textContent: '',
    style: { left: '', top: '' },
    dataset: {},
    attributes: {},
    parent: null,
    children: [],
    removed: 0,
    append(...children: FakeElement[]): void {
      for (const child of children) {
        child.parent = element;
        element.children.push(child);
      }
    },
    remove(): void {
      element.removed += 1;
      if (element.parent === null) return;
      const index = element.parent.children.indexOf(element);
      if (index >= 0) element.parent.children.splice(index, 1);
      element.parent = null;
    },
    setAttribute(name: string, value: string): void {
      element.attributes[name] = value;
    },
  };
  return element;
}

/** 假世界层挂载点：只实现 append，与 NodeLayerParent 结构一致。 */
function fakeWorld(): { element: FakeElement; getWorldElement(): HTMLElement } {
  const element = fakeElement();
  return {
    element,
    getWorldElement(): HTMLElement {
      return element as unknown as HTMLElement;
    },
  };
}

function createLayer(
  world: { element: FakeElement; getWorldElement(): HTMLElement },
  extraOptions: {
    measureAutoHeight?: (id: string, h: number) => void;
    getOffsetHeightForTest?: (el: HTMLElement) => number;
  } = {},
) {
  const parent = world.getWorldElement() as unknown as NodeLayerParent;
  return createNodeLayer(parent, {
    className: 'node-layer',
    nodeClassName: 'node',
    createElement: () => fakeElement() as unknown as HTMLElement,
    // CR-20261121-59：文本/提示词/AI 卡片走 createChild 部件——注入假元素避免依赖 DOM。
    createChildElement: () => fakeElement() as unknown as HTMLElement,
    ...extraOptions,
  });
}

const nodes: readonly CanvasNodeView[] = [
  { type: 'text', id: 'a', label: '草稿', x: 2412, y: -470.5 },
  { type: 'text', id: 'b', label: 'b', x: 2400, y: -480 },
];

void test('只向 world-layer.getWorldElement() 返回的容器挂一次', () => {
  const world = fakeWorld();
  const layer = createLayer(world);

  assert.equal(world.element.children.length, 1);
  assert.equal(world.element.children[0], layer.element as unknown as FakeElement);
  assert.equal(layer.element.className, 'node-layer');
});

void test('节点 left/top = absolute - origin', () => {
  const world = fakeWorld();
  const layer = createLayer(world);
  layer.setNodes(nodes, createViewportTransform(0, 0, 1, 2400, -480));

  const children = world.element.children[0]?.children ?? [];
  assert.equal(children.length, 2);
  // 2026-11-25：文本节点新增底部固定信息，dataset.simple 标记卡片形态（外层 CSS 依赖）。
  assert.deepEqual(children[0]?.dataset, { nodeId: 'a', simple: 'text' });
  // CR-20261121-59：文本节点=卡片结构（标题「文本」+ 内容），label 在内容子元素上。
  assert.equal(children[0]?.children[0]?.textContent, '文本');
  assert.equal(children[0]?.children[1]?.textContent, '草稿');
  assert.deepEqual(
    { left: children[0]?.style.left, top: children[0]?.style.top },
    { left: '12px', top: '9.5px' },
  );
  assert.deepEqual(
    { left: children[1]?.style.left, top: children[1]?.style.top },
    { left: '0px', top: '0px' },
  );
});

void test('重复 setNodes 复用元素；移除的节点从 DOM 消失', () => {
  const world = fakeWorld();
  const layer = createLayer(world);
  const transform = createViewportTransform(0, 0, 1, 2400, -480);

  layer.setNodes(nodes, transform);
  const container = world.element.children[0];
  const first = container?.children[0];
  layer.setNodes(nodes.slice(0, 1), createViewportTransform(0, 0, 1, 2412, -470));

  assert.equal(container?.children.length, 1);
  assert.equal(container?.children[0], first, '复用同一元素，不重建');
  assert.equal(first?.style.left, '0px');
  assert.equal(first?.style.top, '-0.5px');
});

void test('L1 同 ID 节点标签更新时复用元素并刷新文本', () => {
  const world = fakeWorld();
  const layer = createLayer(world);
  const transform = createViewportTransform();

  layer.setNodes([{ type: 'text', id: 'a', label: '旧标签', x: 0, y: 0 }], transform);
  const first = world.element.children[0]?.children[0];
  layer.setNodes([{ type: 'text', id: 'a', label: '新标签', x: 0, y: 0 }], transform);

  assert.equal(world.element.children[0]?.children[0], first, '复用同一元素，不重建');
  assert.equal(first?.children[1]?.textContent, '新标签');
});

void test('L2 标签未变的复用轮次保持元素引用与文本', () => {
  const world = fakeWorld();
  const layer = createLayer(world);
  const transform = createViewportTransform();

  layer.setNodes([{ type: 'text', id: 'a', label: '稳定标签', x: 0, y: 0 }], transform);
  const first = world.element.children[0]?.children[0];
  layer.setNodes([{ type: 'text', id: 'a', label: '稳定标签', x: 0, y: 0 }], transform);

  assert.equal(world.element.children[0]?.children[0], first);
  assert.equal(first?.children[1]?.textContent, '稳定标签');
});

void test('L3 标签变更同轮仍更新坐标并保留选中态', () => {
  const world = fakeWorld();
  const layer = createLayer(world);
  layer.setNodes([{ type: 'text', id: 'a', label: '旧标签', x: 0, y: 0 }], createViewportTransform());
  layer.setSelectedNodes(new Set(['a']));
  const first = world.element.children[0]?.children[0];

  layer.setNodes(
    [{ type: 'text', id: 'a', label: '新标签', x: 10, y: 20 }],
    createViewportTransform(0, 0, 1, 0, 0),
  );

  assert.equal(first?.children[1]?.textContent, '新标签');
  assert.deepEqual(first?.style, { left: '10px', top: '20px' });
  assert.equal(first?.className, 'node selected');
  assert.equal(first?.dataset.selected, 'true');
});

void test('C4 多选只切换 selected 类与标记，复用节点元素且不写盒尺寸', () => {
  const world = fakeWorld();
  const layer = createLayer(world);
  layer.setNodes(nodes, createViewportTransform());
  const first = world.element.children[0]?.children[0];

  layer.setSelectedNodes(new Set(['a', 'b']));
  assert.equal(first?.className, 'node selected');
  assert.equal(first?.dataset.selected, 'true');
  assert.deepEqual(first?.style, { left: '2412px', top: '-470.5px' });
  layer.setSelectedNodes(new Set());
  assert.equal(first?.className, 'node');
  assert.equal(first?.dataset.selected, undefined);
});

void test('AI 运行与完成状态写根节点 dataset，可随时清除', () => {
  const world = fakeWorld();
  const layer = createLayer(world);
  layer.setNodes(
    [{ type: 'ai', id: 'ai', kind: 'ai', label: 'qwen3:8b', x: 0, y: 0 }],
    createViewportTransform(),
  );
  const item = world.element.children[0]?.children[0];

  layer.setAiRunning('ai');
  assert.equal(item?.dataset.aiRunning, 'true');
  layer.setAiFlash({ id: 'ai', kind: 'ok' });
  assert.equal(item?.dataset.aiFlash, 'ok');
  layer.setAiRunning(null);
  layer.setAiFlash(null);
  assert.equal(item?.dataset.aiRunning, undefined);
  assert.equal(item?.dataset.aiFlash, undefined);

  layer.setAiFlash({ id: 'ai', kind: 'error' });
  assert.equal(item?.dataset.aiFlash, 'error');
});

void test('编辑态只切换 data-editing，切换与清除后保留 selected/AI 状态', () => {
  const world = fakeWorld();
  const layer = createLayer(world);
  layer.setNodes(
    [
      { type: 'ai', id: 'a', kind: 'ai', label: '模型 A', x: 0, y: 0 },
      { type: 'prompt', id: 'b', kind: 'prompt', label: '提示词', x: 200, y: 0 },
    ],
    createViewportTransform(),
  );
  const first = world.element.children[0]?.children[0];
  const second = world.element.children[0]?.children[1];
  layer.setSelectedNodes(new Set(['a']));
  layer.setAiRunning('a');
  layer.setAiFlash({ id: 'a', kind: 'ok' });

  layer.setEditingNode('a');
  assert.equal(first?.dataset.editing, 'true');
  assert.equal(first?.dataset.selected, 'true');
  assert.equal(first?.dataset.aiRunning, 'true');
  assert.equal(first?.dataset.aiFlash, 'ok');
  assert.equal(second?.dataset.editing, undefined);

  layer.setEditingNode('b');
  assert.equal(first?.dataset.editing, undefined);
  assert.equal(first?.dataset.selected, 'true');
  assert.equal(first?.dataset.aiRunning, 'true');
  assert.equal(second?.dataset.editing, 'true');

  layer.setEditingNode(null);
  assert.equal(second?.dataset.editing, undefined);
  assert.equal(first?.dataset.selected, 'true');
  assert.equal(first?.dataset.aiFlash, 'ok');
});

void test('dispose 只摘除自身容器，不触碰挂载点本身', () => {
  const world = fakeWorld();
  const layer = createLayer(world);

  layer.dispose();
  layer.dispose();

  assert.equal((layer.element as unknown as FakeElement).removed, 2);
  assert.equal(world.element.children.length, 0, '挂载点仍在，只摘掉节点层');
  assert.equal(world.element.removed, 0);
});

// ---------------------------------------------------------------- CR-20261119-09：ghost 修复的 node-layer 层验收

void test('setNodes([]) 清空全部节点元素（CR-09 A1）', () => {
  const world = fakeWorld();
  const layer = createLayer(world);
  const transform = createViewportTransform();

  // 先塞 3 个节点
  layer.setNodes(
    [
      { type: 'text', id: 'a', label: 'A', x: 0, y: 0 },
      { type: 'text', id: 'b', label: 'B', x: 100, y: 0 },
      { type: 'text', id: 'c', label: 'C', x: 200, y: 0 },
    ],
    transform,
  );
  const container = world.element.children[0] as unknown as FakeElement;
  assert.equal(container.children.length, 3, '初始 3 个子元素');

  // 清空 → 移除循环必须把 3 个都清掉
  layer.setNodes([], transform);
  assert.equal(container.children.length, 0, 'setNodes([]) 后父容器 children=0');
});

void test('setNodes([]) 后级联清理（CR-09 A2）', () => {
  const world = fakeWorld();
  const layer = createLayer(world);
  const transform = createViewportTransform();

  // 创建节点并标记选中（选中态会在 setSelectedNodes 内产生可观测的 side effect：className + dataset）
  layer.setNodes(
    [
      { type: 'text', id: 'a', label: 'A', x: 0, y: 0 },
      { type: 'text', id: 'b', label: 'B', x: 100, y: 0 },
    ],
    transform,
  );
  layer.setSelectedNodes(new Set(['a']));
  const container = world.element.children[0] as unknown as FakeElement;
  assert.equal(container.children.length, 2);
  const firstChild = container.children[0]!;
  assert.equal(firstChild.className, 'node selected');
  assert.equal(firstChild.dataset.selected, 'true');

  // 全清
  layer.setNodes([], transform);
  assert.equal(container.children.length, 0, 'setNodes([]) 后所有节点元素连同选中态都被清掉');
  assert.equal(firstChild.parent, null, '被移除的节点元素 parent 已断链');
});

// ---- CR-20261119-12：measure(ids) 精确测量 ----
// 注意：不能用 docPath 节点——createDocParts 依赖真实 document.createElement，
// FakeElement 环境没有；这里测 measure(ids) 的行为本身，不涉及文档渲染

void test('A4 measure(ids) 只测指定 ids；未指定 / 无 item / h<=0 不回调', () => {
  const called: Array<{ id: string; h: number }> = [];
  const getH = (el: HTMLElement): number => {
    const fake = el as unknown as FakeElement;
    const id = fake.dataset.nodeId ?? '';
    if (id === 'a') return 120;
    if (id === 'b') return 80;
    if (id === 'c') return 40;
    return 50;
  };
  const world = fakeWorld();
  const layer = createLayer(world, {
    measureAutoHeight: (id, h) => called.push({ id, h }),
    getOffsetHeightForTest: getH,
  });

  const transform = createViewportTransform(0, 0, 1, 1000, 1000);
  const views: readonly CanvasNodeView[] = [
    { type: 'text', id: 'a', label: 'A', x: 0, y: 0 },
    { type: 'text', id: 'b', label: 'B', x: 100, y: 0 },
    { type: 'text', id: 'c', label: 'C', x: 200, y: 0 },
  ];
  layer.setNodes(views, transform);

  // 1. 空 ids → 零回调
  layer.measure(new Set());
  assert.equal(called.length, 0);

  // 2. 只指定 a → 只回调 a
  layer.measure(new Set(['a']));
  assert.deepEqual(called, [{ id: 'a', h: 120 }]);
  called.length = 0;

  // 3. 指定 a + b + c → 都回调
  layer.measure(new Set(['a', 'b', 'c']));
  assert.deepEqual(called.sort((x, y) => x.id.localeCompare(y.id)), [
    { id: 'a', h: 120 },
    { id: 'b', h: 80 },
    { id: 'c', h: 40 },
  ]);
  called.length = 0;

  // 4. 指定不存在的 id → 零回调
  layer.measure(new Set(['nonexistent']));
  assert.equal(called.length, 0);
});

void test('A4b measure 里 callback 未注入时零行为、h<=0 零回调', () => {
  const world = fakeWorld();
  // 不传 measureAutoHeight —— measure 内部 guard，直接 return 零报错
  const layer = createLayer(world, { getOffsetHeightForTest: () => 0 });
  const transform = createViewportTransform(0, 0, 1, 1000, 1000);
  layer.setNodes([{ type: 'text', id: 'a', label: 'A', x: 0, y: 0 }], transform);
  layer.measure(new Set(['a']));  // 无 callback → 零报错、零行为
});


void test('CR-20261121-59：提示词卡片结构 = 标题/内容/开始钮，开始钮带控件标记', () => {
  const world = fakeWorld();
  const layer = createLayer(world);
  layer.setNodes(
    [
      {
        type: 'prompt',
        id: 'p',
        label: '提示词',
        x: 0,
        y: 0,
        kind: 'prompt',
        promptText: '比对两篇文章的差异',
      },
    ],
    createViewportTransform(),
  );
  const item = world.element.children[0]?.children[0];
  const title = item?.children[0];
  const content = item?.children[1];
  const run = item?.children[2];
  assert.equal(title?.textContent, '提示词');
  assert.equal(content?.textContent, '比对两篇文章的差异');
  assert.equal(content?.dataset.simpleKind, 'prompt');
  assert.equal(run?.attributes['data-node-control'], 'true', 'engine.onPointerDown 靠此标记放行按压');
  assert.equal(run?.className, 'node-run-btn');
  assert.equal(run?.textContent, '\u25B6\uFE0E');
});

void test('2026-11-24：AI 卡片 = 模型头 + 内联提示词 + 预留动作与 Generate', () => {
  const world = fakeWorld();
  const layer = createLayer(world);
  layer.setNodes(
    [
      {
        type: 'ai',
        id: 's',
        label: 'AI',
        x: 0,
        y: 0,
        kind: 'ai',
        aiModel: 'gpt-5',
        promptText: '总结输入文章',
      },
    ],
    createViewportTransform(),
  );
  const item = world.element.children[0]?.children[0];
  const card = item?.children[0];
  const header = card?.children[0];
  assert.equal(header?.children[0]?.textContent, 'AI 步骤');
  assert.deepEqual(header?.children[1]?.dataset, { aiModel: 'true' });
  assert.equal(header?.children[1]?.textContent, 'gpt-5');

  const prompt = card?.children[1];
  assert.equal(prompt?.attributes['aria-label'], 'AI 提示词');
  assert.equal(prompt?.attributes['data-node-control'], 'true');

  const footer = card?.children[2];
  const actions = footer?.children[0];
  assert.deepEqual(actions?.children.map((action) => action.textContent), ['简化', '分割', '要点', '总结']);
  assert.ok(actions?.children.every((action) => action.attributes.disabled === ''));
  const run = footer?.children[1];
  assert.equal(run?.textContent, 'Generate');
  assert.equal(run?.attributes['data-node-control'], 'true');
});

void test('CR-20261121-59：.nodeRunBtn 必须显式放开 pointer-events + engine 注入哈希类（回归钉）', () => {
  const css = readFileSync(
    new URL('../../../src/app/canvas/canvas.module.css', import.meta.url),
    'utf8',
  );
  const rule = /\.nodeRunBtn\s*\{[\s\S]*?\}/.exec(css)?.[0] ?? '';
  assert.match(rule, /pointer-events:\s*auto/, 'nodeLayer 为 none，交互子元素必须显式放开');

  const engine = readFileSync(
    new URL('../../../src/app/canvas/engine.ts', import.meta.url),
    'utf8',
  );
  assert.match(engine, /run:\s*classOf\('nodeRunBtn'\)/, 'engine 必须注入哈希后的开始钮类');
});
