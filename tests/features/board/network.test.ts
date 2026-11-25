/**
 * S5：知识网络、分布分析、时间线纯函数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NETWORK_GROUP_PREFIX,
  NETWORK_HEIGHT,
  NETWORK_WIDTH,
  buildDistribution,
  buildNetworkGraph,
  buildTimeline,
  layoutNetwork,
  networkNodeRadius,
  primaryDimension,
  selectNetworkLabels,
  type NetworkGraph,
  type NetworkNode,
} from '../../../src/features/board/network.ts';
import type {
  BoardDimensionId,
  BoardDocStat,
  BoardLink,
} from '../../../src/features/board/model.ts';

const DAY = 24 * 60 * 60 * 1000;
const BASE = new Date(2026, 9, 1).getTime();

function stat(
  path: string,
  options: {
    readonly title?: string;
    readonly words?: number;
    readonly modifiedMs?: number;
    readonly createdMs?: number | null;
    readonly tags?: readonly string[];
    readonly bytes?: number;
  } = {},
): BoardDocStat {
  return {
    path,
    sha256: `sha:${path}`,
    bytes: options.bytes ?? 100,
    modifiedMs: options.modifiedMs ?? BASE,
    title: options.title ?? path.replace(/\.md$/, ''),
    tags: options.tags ?? [],
    wordCount: options.words ?? 10,
    skipped: false,
    createdMs: options.createdMs ?? null,
  };
}

function classify(
  entries: Record<string, readonly BoardDimensionId[]>,
): ReadonlyMap<string, readonly BoardDimensionId[]> {
  return new Map(Object.entries(entries));
}

function link(from: string, to: string): BoardLink {
  return { from, to };
}

void test('primaryDimension：按八维固定顺序取首个', () => {
  assert.equal(primaryDimension(['tacit', 'factual']), 'factual');
  assert.equal(primaryDimension(['value']), 'value');
  assert.equal(primaryDimension([]), null);
  assert.equal(primaryDimension(undefined), null);
});

void test('buildNetworkGraph：无向去重累加权重，忽略自环与库外链接', () => {
  const docs = [stat('a.md'), stat('b.md'), stat('c.md'), stat('d.md')];
  const graph = buildNetworkGraph(
    docs,
    classify({ 'a.md': ['tacit', 'factual'], 'b.md': ['procedural'] }),
    [
      link('a.md', 'b.md'),
      link('b.md', 'a.md'),
      link('b.md', 'c.md'),
      link('a.md', 'a.md'),
      link('a.md', 'missing.md'),
    ],
  );

  assert.equal(graph.aggregated, false);
  assert.equal(graph.nodes.length, 4);
  assert.equal(graph.edges.length, 2);
  const ab = graph.edges.find((edge) => edge.source === 'a.md' && edge.target === 'b.md');
  assert.equal(ab?.weight, 2, '同一条无向链接出现两次');
  const nodeA = graph.nodes.find((node) => node.id === 'a.md');
  assert.equal(nodeA?.dimensionId, 'factual', '主维度按固定顺序取首个');
  assert.equal(nodeA?.degree, 1, 'a 只连到 b');
  const nodeD = graph.nodes.find((node) => node.id === 'd.md');
  assert.equal(nodeD?.isolated, true);
  assert.equal(nodeD?.dimensionId, null);
});

void test('buildNetworkGraph：超过上限按主维度聚合且忽略组内边', () => {
  const docs = [
    stat('a.md'),
    stat('b.md'),
    stat('c.md'),
    stat('d.md'),
    stat('e.md'),
  ];
  const graph = buildNetworkGraph(
    docs,
    classify({
      'a.md': ['factual'],
      'b.md': ['factual'],
      'c.md': ['tacit'],
      'd.md': ['tacit'],
    }),
    [link('a.md', 'b.md'), link('a.md', 'c.md'), link('b.md', 'c.md'), link('c.md', 'e.md')],
    { limit: 2 },
  );

  assert.equal(graph.aggregated, true);
  assert.deepEqual(
    graph.nodes.map((node) => node.id),
    [`${NETWORK_GROUP_PREFIX}factual`, `${NETWORK_GROUP_PREFIX}tacit`, `${NETWORK_GROUP_PREFIX}unclassified`],
  );
  const factual = graph.nodes[0];
  assert.equal(factual?.documentCount, 2);
  const tacit = graph.nodes[1];
  assert.equal(tacit?.documentCount, 2, 'c/d 均为主维度 tacit');
  assert.equal(graph.edges.length, 2, '组内 a-b 被忽略');
  for (const edge of graph.edges) {
    assert.notEqual(edge.source, edge.target);
  }
  const factualTacit = graph.edges.find(
    (edge) => edge.source === `${NETWORK_GROUP_PREFIX}factual`,
  );
  assert.equal(factualTacit?.weight, 2);
});

void test('layoutNetwork：空图安全，坐标确定、有限且在画布内', () => {
  const empty: NetworkGraph = { nodes: [], edges: [], aggregated: false };
  assert.equal(layoutNetwork(empty), empty);

  const graph = buildNetworkGraph(
    [stat('a.md'), stat('b.md'), stat('c.md')],
    classify({ 'a.md': ['factual'], 'b.md': ['factual'], 'c.md': ['tacit'] }),
    [link('a.md', 'b.md')],
  );
  const first = layoutNetwork(graph);
  const second = layoutNetwork(graph);
  assert.deepEqual(
    first.nodes.map((node) => [node.x, node.y]),
    second.nodes.map((node) => [node.x, node.y]),
    '同一输入必须得到同一坐标',
  );
  for (const node of first.nodes) {
    assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y));
    assert.ok(node.x >= 0 && node.x <= NETWORK_WIDTH, `x 越界：${node.x}`);
    assert.ok(node.y >= 0 && node.y <= NETWORK_HEIGHT, `y 越界：${node.y}`);
  }
  assert.deepEqual(
    graph.nodes.map((node) => [node.x, node.y]),
    [[0, 0], [0, 0], [0, 0]],
    '布局不改入参',
  );
});

void test('networkNodeRadius：权重与连接数越大半径越大', () => {
  const small = networkNodeRadius(
    { id: 'a', label: 'a', degree: 0, weight: 1, dimensionId: null, isolated: true, documentCount: 1, x: 0, y: 0 },
    100,
  );
  const large = networkNodeRadius(
    { id: 'b', label: 'b', degree: 4, weight: 100, dimensionId: null, isolated: false, documentCount: 1, x: 0, y: 0 },
    100,
  );
  assert.ok(large > small);
});

void test('selectNetworkLabels：重叠标签只留优先级高的，选中节点必显示', () => {
  const a: NetworkNode = {
    id: 'a.md',
    label: '甲文档',
    degree: 3,
    weight: 1,
    dimensionId: null,
    isolated: false,
    documentCount: 1,
    x: 100,
    y: 100,
  };
  const b: NetworkNode = {
    ...a,
    id: 'b.md',
    label: '乙文档',
    degree: 1,
  };

  assert.deepEqual([...selectNetworkLabels([a, b], { limit: 5 })], ['a.md']);
  assert.deepEqual([...selectNetworkLabels([a, b], { limit: 1, selectedId: 'b.md' })], ['b.md']);
});

void test('selectNetworkLabels：limit 截断，可见节点优先获得标签', () => {
  const make = (id: string, x: number, degree: number): NetworkNode => ({
    id,
    label: id,
    degree,
    weight: 1,
    dimensionId: null,
    isolated: false,
    documentCount: 1,
    x,
    y: 40,
  });
  const nodes = [make('a.md', 0, 5), make('b.md', 400, 4), make('c.md', 800, 3)];

  assert.equal(selectNetworkLabels(nodes, { limit: 2 }).size, 2);
  assert.deepEqual(
    [...selectNetworkLabels(nodes, { limit: 1, visibleIds: new Set(['c.md']) })],
    ['c.md'],
  );
});

void test('buildDistribution：维度计数、活跃、标签截断、孤立与断链', () => {
  const now = BASE + 5 * DAY;
  const docs = [
    stat('a.md', { tags: ['方法/测试', '主题'], modifiedMs: BASE + 1 * DAY }),
    stat('b.md', { tags: ['方法/测试'], modifiedMs: BASE - 60 * DAY }),
    stat('c.md', { tags: ['主题'], modifiedMs: BASE - 60 * DAY }),
    stat('d.md'),
  ];
  const distribution = buildDistribution(
    docs,
    classify({ 'a.md': ['factual'], 'b.md': ['factual', 'tacit'] }),
    [link('a.md', 'b.md'), link('a.md', 'ghost.md'), link('d.md', 'ghost.md')],
    { now, tagLimit: 1, allPaths: new Set(['a.md', 'b.md', 'c.md', 'd.md']) },
  );

  const factual = distribution.dimensions.find((row) => row.id === 'factual');
  assert.equal(factual?.count, 2);
  assert.equal(factual?.active, 1, '仅 a.md 近 30 天修改');
  assert.deepEqual(distribution.tags, [{ tag: '主题', count: 2 }], '同分按标签码点升序');
  assert.equal(distribution.totalTags, 2, '截断前统计不同标签数');
  assert.deepEqual(
    distribution.isolated.map((row) => row.path),
    ['c.md', 'd.md'],
  );
  assert.deepEqual(
    distribution.brokenLinks.map((row) => [row.from, row.to]),
    [
      ['a.md', 'ghost.md'],
      ['d.md', 'ghost.md'],
    ],
  );
  assert.equal(distribution.unclassified, 2);
  assert.equal(distribution.isolatedTotal, 2);
  assert.equal(distribution.brokenLinksTotal, 2);
});

void test('buildTimeline：创建 + 修改倒序，limit 生效，不伪造创建时间', () => {
  const docs = [
    stat('a.md', { modifiedMs: BASE + 2 * DAY, createdMs: BASE }),
    stat('b.md', { modifiedMs: BASE + 3 * DAY, createdMs: null }),
  ];
  const events = buildTimeline(docs, classify({}), { limit: 3 });
  assert.deepEqual(
    events.map((event) => [event.path, event.kind, event.date]),
    [
      ['b.md', 'modified', '2026-10-04'],
      ['a.md', 'modified', '2026-10-03'],
      ['a.md', 'created', '2026-10-01'],
    ],
  );
  assert.equal(events.length, 3);
  assert.equal(
    events.some((event) => event.path === 'b.md' && event.kind === 'created'),
    false,
  );
});
