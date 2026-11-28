/**
 * C2 节点布局纯模块单测：S2 等价性、lastOrigin 缺省、local 坐标、容器平移折入 origin。
 *
 * 这些断言把「DOM 用 local、容器折 origin」与三式 `screen = absolute * s + tx` 钉在一起，
 * 防止漏乘/漏加 `origin * s`。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createEmptyCanvasDocument,
  parseCanvasDocument,
  serializeCanvasDocument,
} from '../../../src/app/canvas/format.ts';
import {
  applyOrigin,
  composeScreenPosition,
  extractNodeViews,
  extractNodes,
  hasOutsideNodeLabel,
  hitTestNodes,
  isNodeContentMode,
  marqueeNodeIds,
  mergeAutoHeights,
  mergeOutputsToDocument,
  NODE_HEIGHT,
  nodeLocalPosition,
  nodeOutsideLabelLayout,
  nodeScreenPosition,
  nodeScreenRect,
  nodeSizeOf,
  nodeWorldRects,
  readOrigin,
  worldContainerOffset,
  type CanvasNodeView,
} from '../../../src/app/canvas/node-layout.ts';
import { createViewportTransform, worldToScreen } from '../../../src/app/canvas/viewport.ts';
import { worldTransformCss } from '../../../src/app/canvas/world-layer.ts';

const EPSILON = 1e-9;

const cases = [
  { origin: { x: 0, y: 0 }, local: { x: 120, y: 240 }, scale: 1, tx: 0, ty: 0 },
  { origin: { x: 2400, y: -4800 }, local: { x: 13.5, y: -7.25 }, scale: 2.5, tx: -320, ty: 640 },
  { origin: { x: -1e6, y: 1e6 }, local: { x: 1234.5, y: -9876.25 }, scale: 0.05, tx: 100, ty: 200 },
  { origin: { x: 24, y: 48 }, local: { x: 0.1, y: 0.2 }, scale: 7.3, tx: 1.5, ty: -2.5 },
] as const;

void test('S2：local * s + tx + origin * s 与 (origin + local) * s + tx 在 1e-9 内相等', () => {
  for (const item of cases) {
    const transform = createViewportTransform(
      item.tx,
      item.ty,
      item.scale,
      item.origin.x,
      item.origin.y,
    );
    const localScreen = nodeScreenPosition(item.local, transform);
    const absoluteScreen = worldToScreen(transform, {
      x: item.origin.x + item.local.x,
      y: item.origin.y + item.local.y,
    });

    assert.ok(
      Math.abs(localScreen.x - absoluteScreen.x) < EPSILON,
      `x 偏差超限：${localScreen.x} vs ${absoluteScreen.x}`,
    );
    assert.ok(
      Math.abs(localScreen.y - absoluteScreen.y) < EPSILON,
      `y 偏差超限：${localScreen.y} vs ${absoluteScreen.y}`,
    );
  }
});

void test('S1：nodeScreenPosition 与 worldContainerOffset 共用 composeScreenPosition', () => {
  for (const item of cases) {
    const transform = createViewportTransform(
      item.tx,
      item.ty,
      item.scale,
      item.origin.x,
      item.origin.y,
    );

    assert.deepEqual(nodeScreenPosition(item.local, transform), composeScreenPosition(item.local, transform));
    assert.deepEqual(worldContainerOffset(transform), composeScreenPosition({ x: 0, y: 0 }, transform));
  }
});

void test('lastOrigin 缺失：按 (0,0) 处理', () => {
  const document = createEmptyCanvasDocument();

  assert.deepEqual(readOrigin(document), { x: 0, y: 0 });
  assert.deepEqual(applyOrigin(createViewportTransform(), readOrigin(document)), {
    tx: 0,
    ty: 0,
    scale: 1,
    originX: 0,
    originY: 0,
  });
});

void test('lastOrigin 非法（非对象 / 非有限数）：按 (0,0) 处理', () => {
  assert.deepEqual(readOrigin(parseCanvasDocument('{"schemaVersion":2,"nodes":[],"edges":[],"lastOrigin":42}')), { x: 0, y: 0 });
  assert.deepEqual(readOrigin(parseCanvasDocument('{"schemaVersion":2,"nodes":[],"edges":[],"lastOrigin":{"x":"24","y":48}}')), { x: 0, y: 0 });
  assert.deepEqual(readOrigin(parseCanvasDocument('{"schemaVersion":2,"nodes":[],"edges":[],"lastOrigin":{"x":24}}')), { x: 0, y: 0 });
});

void test('lastOrigin 合法：写入 transform.originX/originY，不新建坐标系', () => {
  const document = parseCanvasDocument(
    '{"schemaVersion":2,"nodes":[],"edges":[],"lastOrigin":{"x":2400,"y":-480}}',
  );
  const transform = applyOrigin(createViewportTransform(10, 20, 2), readOrigin(document));

  assert.deepEqual(readOrigin(document), { x: 2400, y: -480 });
  assert.equal(transform.tx, 10);
  assert.equal(transform.ty, 20);
  assert.equal(transform.scale, 2);
  assert.equal(transform.originX, 2400);
  assert.equal(transform.originY, -480);
});

void test('节点 left/top = absolute - origin', () => {
  const transform = createViewportTransform(320, -160, 3, 2400, -480);

  assert.deepEqual(nodeLocalPosition({ x: 2412, y: -470.5 }, transform), { x: 12, y: 9.5 });
  assert.deepEqual(nodeLocalPosition({ x: 2400, y: -480 }, transform), { x: 0, y: 0 });
});

void test('外标题布局：标题行定位与低缩放字号补偿同源', () => {
  const node: CanvasNodeView = { type: 'document', id: 'd', label: '草稿', x: 22, y: 50, w: 240, docPath: 'a.md' };
  assert.equal(hasOutsideNodeLabel(node), true);
  assert.deepEqual(
    nodeOutsideLabelLayout(node, createViewportTransform(0, 0, 1, 10, 20)),
    { x: 12, y: 10, width: 240, fontSize: null },
  );
  const low = nodeOutsideLabelLayout(node, createViewportTransform(0, 0, 0.5, 10, 20));
  assert.ok(Math.abs(low.y - (-4.4)) < EPSILON);
  assert.equal(low.fontSize, 22, '0.5 倍缩放下 22px 本地字号映射为 11px 屏幕字号');
  assert.equal(hasOutsideNodeLabel({ ...node, docPath: undefined }), false);
  assert.equal(hasOutsideNodeLabel({ type: 'media', id: 'm', label: 'a.png', x: 0, y: 0, media: { kind: 'image', path: 'media/a.png' } }), false);
  assert.equal(hasOutsideNodeLabel({ type: 'media', id: 'm', label: '封面', x: 0, y: 0, media: { kind: 'image', path: 'media/a.png' } }), true);
});

void test('extractNodes：只取 id 非空且 x/y 有限的节点，label 缺省用 id', () => {
  const document = parseCanvasDocument(
    '{"schemaVersion":2,"edges":[],"nodes":[{"id":"a","x":24,"y":48,"label":"草稿"},{"id":"b","x":-1,"y":2},{"id":"","x":1,"y":2},{"id":"c","x":"1","y":2},{"x":1,"y":2},"bad"]}',
  );

  assert.deepEqual(extractNodes(document), [
    { type: 'text', id: 'a', label: '草稿', x: 24, y: 48 },
    { type: 'text', id: 'b', label: 'b', x: -1, y: 2 },
  ]);
  assert.deepEqual(extractNodes(createEmptyCanvasDocument()), []);
});

void test('容器平移 = tx + origin * s；origin 为 0 时与 C1 输出一致', () => {
  const c1 = createViewportTransform(40, -80, 1.5);
  const rebased = createViewportTransform(40, -80, 1.5, 2400, -480);

  assert.deepEqual(worldContainerOffset(c1), { x: 40, y: -80 });
  assert.equal(worldTransformCss(c1), 'translate3d(40px, -80px, 0) scale(1.5)');
  assert.deepEqual(worldContainerOffset(rebased), { x: 3640, y: -800 });
  assert.equal(worldTransformCss(rebased), 'translate3d(3640px, -800px, 0) scale(1.5)');
});

void test('fit-all 世界矩形复用节点实际尺寸与文档 autoH', () => {
  assert.deepEqual(nodeWorldRects([
    { type: 'text', id: 'a', label: 'a', x: 10, y: 20, w: 200, h: 120 },
    { type: 'document', id: 'd', label: 'd', x: -30, y: 40, autoH: 180, docPath: 'd.md' },
  ]), [
    { left: 10, top: 20, right: 210, bottom: 140 },
    { left: -30, top: 40, right: 130, bottom: 220 },
  ]);
});

void test('C4 节点命中：zoom 0.05/8 边界含端点，重叠取数组靠后者', () => {
  const nodes: readonly CanvasNodeView[] = [
    { type: 'text', id: 'under', label: 'under', x: 17, y: 31 },
    { type: 'text', id: 'over', label: 'over', x: 17, y: 31 },
  ];
  for (const scale of [0.05, 8]) {
    const transform = createViewportTransform(100, 200, scale, 7, 11);
    const rect = nodeScreenRect(nodes[0] ?? nodes[1]!, transform);
    assert.equal(hitTestNodes(nodes, transform, { x: rect.left, y: rect.top })?.id, 'over');
    assert.equal(hitTestNodes(nodes, transform, { x: rect.right, y: rect.bottom })?.id, 'over');
    assert.equal(hitTestNodes(nodes, transform, { x: rect.right + 0.001, y: rect.bottom }), null);
  }
});

void test('C4 框选：zoom 0.05/8 相交即选、不选边、支持反向矩形', () => {
  const nodes: readonly CanvasNodeView[] = [
    { type: 'text', id: 'a', label: 'a', x: 17, y: 31 },
    { type: 'text', id: 'b', label: 'b', x: 500, y: 500 },
  ];
  for (const scale of [0.05, 8]) {
    const transform = createViewportTransform(100, 200, scale, 7, 11);
    const rect = nodeScreenRect(nodes[0]!, transform);
    const intersecting = {
      left: rect.right - 0.01,
      top: rect.bottom - 0.01,
      right: rect.left - 10,
      bottom: rect.top - 10,
    };
    assert.deepEqual(marqueeNodeIds(nodes, transform, intersecting), ['a']);
    assert.deepEqual(
      marqueeNodeIds(nodes, transform, {
        left: rect.right + 0.01,
        top: rect.bottom + 0.01,
        right: rect.right + 2,
        bottom: rect.bottom + 2,
      }),
      [],
    );
  }
});

void test('裁决 2A：非 24 倍数 lastOrigin 原样接受，打开未编辑时存盘字节不变', () => {
  const text = `${JSON.stringify(
    {
      schemaVersion: 3,
      lastOrigin: { x: 17, y: -29 },
      nodes: [{ type: 'text', id: 'a', label: 'A', x: 101, y: 203 }],
      edges: [],
      unknown: { kept: true },
    },
    null,
    2,
  )}\n`;
  const document = parseCanvasDocument(text);

  assert.deepEqual(readOrigin(document), { x: 17, y: -29 });
  assert.deepEqual(applyOrigin(createViewportTransform(), readOrigin(document)), {
    tx: 0,
    ty: 0,
    scale: 1,
    originX: 17,
    originY: -29,
  });
  assert.equal(serializeCanvasDocument(document), text);
});

// ---- CR-20261119-12：autoH 数据模型 ----

void test('A1 nodeSizeOf 回退链：显式 h → autoH → NODE_HEIGHT', () => {
  // 显式 h 优先
  assert.equal(nodeSizeOf({ w: 160, h: 200 }).h, 200);
  // 显式 h 缺失 → autoH
  assert.equal(nodeSizeOf({ w: 160, autoH: 150 }).h, 150);
  // 都缺省 → 96
  assert.equal(nodeSizeOf({ w: 160 }).h, NODE_HEIGHT);
  assert.equal(nodeSizeOf({}).h, NODE_HEIGHT);
  // 显式 h 即使非法（<=0）也不走 autoH —— 走 NODE_HEIGHT
  assert.equal(nodeSizeOf({ w: 160, h: -1, autoH: 150 }).h, NODE_HEIGHT);
});

void test('C0-A 默认节点盒：nodeSizeOf({}) 默认 160×96', () => {
  assert.equal(nodeSizeOf({}).w, 160);
  assert.equal(nodeSizeOf({}).h, 96);
});

void test('A2 isNodeContentMode 只看显式 h——autoH 不触发', () => {
  // 显式 h=100 > 96 → true
  assert.equal(isNodeContentMode({ h: 100 }), true);
  // 显式 h=96 边界 → false
  assert.equal(isNodeContentMode({ h: 96 }), false);
  // 显式 h=97 → true
  assert.equal(isNodeContentMode({ h: 97 }), true);
  // h 缺省 + autoH=200 → false（autoH 不触发）
  assert.equal(isNodeContentMode({ autoH: 200 }), false);
  // h 缺省 + autoH=50 → false
  assert.equal(isNodeContentMode({ autoH: 50 }), false);
  // 都缺省 → false
  assert.equal(isNodeContentMode({}), false);
});

void test('A3 mergeAutoHeights：不可变合并 / 显式 h 不写 autoH / 非 document 原样 / Map 无值不写字段', () => {
  const views: readonly CanvasNodeView[] = [
    { type: 'document', id: 'd1', label: 'd1', x: 0, y: 0, docPath: '/a.md' },                         // doc h 缺省，Map 有值
    { type: 'document', id: 'd2', label: 'd2', x: 0, y: 0, docPath: '/b.md' },                         // doc h 缺省，Map 无值
    { type: 'document', id: 'd3', label: 'd3', x: 0, y: 0, docPath: '/c.md', h: 200 },                 // doc 显式 h
    { type: 'text', id: 't1', label: 't1', x: 0, y: 0 },                                           // text
    { type: 'media', id: 'm1', label: 'm1', x: 0, y: 0, media: { kind: 'image', path: '/p.png' } }, // media
  ];
  const map = new Map<string, number>([['d1', 150]]);

  const merged = mergeAutoHeights(views, map);
  assert.equal(merged.length, views.length);

  // 不可变：新数组、view 对象不同
  assert.notStrictEqual(merged, views);
  assert.notStrictEqual(merged[0]!, views[0]);

  // d1：Map 有 150 → 合进 autoH
  assert.equal(merged[0]!.autoH, 150);
  // d2：Map 无值 → autoH 字段保持 undefined
  assert.equal(merged[1]!.autoH, undefined);
  // d3：显式 h → 不写 autoH，原样返回（对象引用不变）
  assert.strictEqual(merged[2]!, views[2]);
  assert.equal('autoH' in merged[2]!, false);
  // t1：非 document → 原样
  assert.strictEqual(merged[3]!, views[3]);
  // m1：非 document → 原样
  assert.strictEqual(merged[4]!, views[4]);
  assert.strictEqual('autoH' in merged[4]!, false);
});

void test('A3b mergeAutoHeights prune 时 engine 端已删显式 h 节点的 Map 值', () => {
  // engine autoHeightPruneAndSchedule 里显式 h 节点已 autoHeights.delete(id)
  // mergeAutoHeights 只负责合，不负责 prune——两者职责分离
  const views: readonly CanvasNodeView[] = [
    { type: 'document', id: 'd1', label: 'd1', x: 0, y: 0, docPath: '/a.md' },
    { type: 'document', id: 'd2', label: 'd2', x: 0, y: 0, docPath: '/b.md', h: 200 },
  ];
  // Map 错误保留了 d2（显式 h）的 autoH——merge 不会合进去（因为 h !== undefined）
  const map = new Map<string, number>([['d1', 150], ['d2', 180]]);
  const merged = mergeAutoHeights(views, map);
  assert.equal(merged.length, views.length);
  // d1 合了 autoH
  assert.equal(merged[0]!.autoH, 150);
  // d2 h 显式 → autoH 不合进
  assert.equal(merged[1]!.autoH, undefined);
  // engine 负责 prune：显式 h 节点的 Map 值应在合并前已 delete
});

void test('CR-20261121-53：ai/prompt 节点透出 type/kind/aiModel/promptText，text 节点不带 kind', () => {
  const views = extractNodeViews([
    { id: 'ai1', x: 0, y: 0, type: 'ai', label: 'AI 节点', model: 'qwen3:8b' },
    { id: 'ai2', x: 1, y: 1, type: 'ai' },
    { id: 'p1', x: 2, y: 2, type: 'prompt', label: '提示词', text: '第一行\n第二行' },
    { id: 'p2', x: 3, y: 3, type: 'prompt', label: '空提示词', text: '' },
    { type: 'text', id: 't1', x: 4, y: 4, label: '正文' },
  ]);
  assert.deepEqual(views[0], {
    type: 'ai', id: 'ai1', label: 'AI 节点', x: 0, y: 0, kind: 'ai', aiModel: 'qwen3:8b',
  });
  assert.deepEqual(views[1], { type: 'ai', id: 'ai2', label: 'ai2', x: 1, y: 1, kind: 'ai' });
  assert.deepEqual(views[2], {
    type: 'prompt', id: 'p1', label: '提示词', x: 2, y: 2, kind: 'prompt', promptText: '第一行\n第二行',
  });
  assert.deepEqual(views[3], {
    type: 'prompt', id: 'p2', label: '空提示词', x: 3, y: 3, kind: 'prompt', promptText: '',
  });
  assert.deepEqual(views[4], { type: 'text', id: 't1', label: '正文', x: 4, y: 4 });
});

void test('CanvasNodeView.type：保留八种白名单类型，缺失类型沿用文本卡片兜底', () => {
  const types = ['document', 'media', 'text', 'group', 'ai', 'prompt', 'split', 'merge'] as const;
  const views = extractNodeViews(types.map((type, index) => ({ id: type, type, x: index, y: 0 })));
  assert.deepEqual(views.map((view) => view.type), types);
  assert.equal(extractNodeViews([{ id: 'legacy', x: 0, y: 0 }])[0]?.type, 'text');
});

void test('A4：merge 投影仅“唯一 document 输出”才显示撤销例外', () => {
  const nodes = [
    { id: 'm1', type: 'merge' },
    { id: 'd1', type: 'document', docPath: 'a.md', label: 'A' },
    { id: 't1', type: 'text', label: '输出' },
  ];
  const docEdge = { from: { nodeId: 'm1' }, to: { nodeId: 'd1' } };
  const textEdge = { from: { nodeId: 'm1' }, to: { nodeId: 't1' } };

  assert.equal(mergeOutputsToDocument(nodes, [docEdge], 'm1'), true, '唯一 document 输出');
  assert.equal(
    mergeOutputsToDocument(nodes, [docEdge, textEdge], 'm1'),
    false,
    '文本 + document 双输出时 runner 拒绝，投影不得误报',
  );
  assert.equal(mergeOutputsToDocument(nodes, [textEdge], 'm1'), false, '唯一文本输出');
  assert.equal(mergeOutputsToDocument(nodes, [], 'm1'), false, '无输出');
});
