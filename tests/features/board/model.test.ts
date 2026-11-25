/**
 * CR-20261123-69 / S1：看板数据层纯函数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_STAT_BYTES,
  buildBoardMetrics,
  countWords,
  localDateKey,
  normalizeDimensions,
  parseDocStat,
  type BoardDocStat,
  type BoardDimensionId,
} from '../../../src/features/board/model.ts';

function doc(
  path: string,
  text: string,
  modifiedMs: number,
  bytes: number = text.length,
): BoardDocStat {
  return parseDocStat({ path, sha256: `sha:${path}`, bytes, modifiedMs, text });
}

function classify(
  entries: Record<string, readonly BoardDimensionId[]>,
): ReadonlyMap<string, readonly BoardDimensionId[]> {
  return new Map(Object.entries(entries));
}

void test('parseDocStat：标题/标签/创建时间取 frontmatter，字数只算正文非空白字符', () => {
  const text = [
    '---',
    'title: 甲文',
    "tags: ['方法/测试', '方法/测试', ' ']",
    'created: 2026-10-01',
    '---',
    '# 标题',
    'ab c',
  ].join('\n');
  const stat = parseDocStat({
    path: 'notes/原文件名.md',
    sha256: 'sha1',
    bytes: text.length,
    modifiedMs: 1000,
    text,
  });

  assert.equal(stat.title, '甲文');
  assert.deepEqual(stat.tags, ['方法/测试'], '去空、去重');
  assert.equal(stat.wordCount, 6, '# 标题 ab c 的非空白字符数');
  assert.equal(stat.createdMs, new Date(2026, 9, 1).getTime(), '纯日期按本地零点');
  assert.equal(stat.skipped, false);
});

void test('parseDocStat：无 frontmatter 时标题回退文件名', () => {
  const stat = doc('notes/未命名.md', '正文', 1000);
  assert.equal(stat.title, '未命名');
  assert.deepEqual(stat.tags, []);
  assert.equal(stat.createdMs, null);
});

void test('parseDocStat：超过 1 MiB 跳过正文统计，但保留文件名字段', () => {
  let read = false;
  const stat = parseDocStat({
    path: 'big/巨文件.md',
    sha256: 'sha',
    bytes: MAX_STAT_BYTES + 1,
    modifiedMs: 2000,
    get text(): string {
      read = true;
      return '---\ntitle: 不该被解析\n---\n正文';
    },
  });
  assert.equal(read, false, '跳过大文件时不应触碰正文');
  assert.equal(stat.skipped, true);
  assert.equal(stat.wordCount, 0);
  assert.deepEqual(stat.tags, []);
  assert.equal(stat.title, '巨文件');
  assert.equal(stat.createdMs, null);
});

void test('countWords 与 normalizeDimensions', () => {
  assert.equal(countWords(' a b\n\t中 文 '), 4);
  assert.deepEqual(normalizeDimensions(['value', 'factual', 'bogus', 'value']), [
    'factual',
    'value',
  ]);
});

void test('localDateKey：按本地时区分桶，不按 UTC 截断', () => {
  assert.equal(localDateKey(new Date(2026, 0, 5, 23, 59).getTime()), '2026-01-05');
  assert.equal(localDateKey(new Date(2026, 0, 6, 0, 1).getTime()), '2026-01-06');
});

void test('趋势与热力图：30 天连续分桶、26 周（182 天）且末位是今天', () => {
  const now = new Date(2026, 10, 23, 12, 0).getTime();
  const docs = [
    doc('a.md', 'a', new Date(2026, 10, 23, 0, 30).getTime()),
    doc('b.md', 'b', new Date(2026, 10, 22, 23, 30).getTime()),
    doc('c.md', 'c', new Date(2026, 7, 1, 12, 0).getTime()),
  ];
  const metrics = buildBoardMetrics(docs, new Map(), { now });

  assert.equal(metrics.trend.modified.length, 30);
  assert.deepEqual(metrics.trend.modified[29], { date: '2026-11-23', count: 1 });
  assert.deepEqual(metrics.trend.modified[28], { date: '2026-11-22', count: 1 });
  assert.equal(metrics.trend.created, null, '没有任何 createdMs 时不提供新增序列');
  assert.equal(metrics.heatmap.length, 26 * 7);
  assert.deepEqual(metrics.heatmap[metrics.heatmap.length - 1], {
    date: '2026-11-23',
    count: 1,
  });
});

void test('createdMs 可解析时提供新增趋势', () => {
  const now = new Date(2026, 10, 23, 12, 0).getTime();
  const docs = [doc('a.md', '---\ncreated: 2026-11-20\n---\n正文', now)];
  const metrics = buildBoardMetrics(docs, new Map(), { now });
  assert.ok(metrics.trend.created);
  const point = metrics.trend.created.find((item) => item.date === '2026-11-20');
  assert.deepEqual(point, { date: '2026-11-20', count: 1 });
});

void test('相对覆盖度/连接密度/得分：以最大值归一，空维度为 0', () => {
  const now = new Date(2026, 10, 23, 12, 0).getTime();
  const docs = [doc('a.md', 'a', now), doc('b.md', 'b', now), doc('c.md', 'c', now)];
  const classification = classify({
    'a.md': ['factual', 'conceptual'],
    'b.md': ['factual'],
    'c.md': ['procedural'],
  });
  const links = [
    { from: 'a.md', to: 'b.md' },
    { from: 'a.md', to: 'c.md' },
  ];
  const metrics = buildBoardMetrics(docs, classification, { now, links });
  const byId = new Map(metrics.dimensions.map((dimension) => [dimension.id, dimension]));

  const factual = byId.get('factual');
  const conceptual = byId.get('conceptual');
  const procedural = byId.get('procedural');
  assert.ok(factual && conceptual && procedural);
  assert.equal(factual.docs, 2);
  assert.equal(factual.coverage, 100);
  assert.equal(conceptual.coverage, 50);
  assert.equal(procedural.coverage, 50);
  assert.equal(factual.density, 75, '平均 degree 1.5 / 最大 2');
  assert.equal(conceptual.density, 100);
  assert.equal(procedural.density, 50);
  assert.equal(factual.score, 93);
  assert.equal(conceptual.score, 78);
  assert.equal(procedural.score, 63);

  const tacit = byId.get('tacit');
  assert.ok(tacit);
  assert.deepEqual(
    { docs: tacit.docs, coverage: tacit.coverage, density: tacit.density, score: tacit.score },
    { docs: 0, coverage: 0, density: 0, score: 0 },
  );
});

void test('总数：连接去重、自环忽略、孤立节点与未分类计数', () => {
  const now = 5_000_000;
  const docs = [doc('a.md', 'a', now), doc('b.md', 'b', now), doc('c.md', 'c', now)];
  const links = [
    { from: 'a.md', to: 'b.md' },
    { from: 'b.md', to: 'a.md' },
    { from: 'a.md', to: 'a.md' },
  ];
  const metrics = buildBoardMetrics(docs, new Map(), { now, links, totalDocs: 9 });
  assert.equal(metrics.totals.docs, 9, 'totalDocs 优先（T0 分母）');
  assert.equal(metrics.totals.links, 1);
  assert.equal(metrics.totals.isolated, 1);
  assert.equal(metrics.totals.unclassified, 3);

  const classified = buildBoardMetrics(docs, classify({ 'a.md': ['factual'] }), { now, links });
  assert.equal(classified.totals.unclassified, 2);
  assert.equal(classified.totals.skipped, 0);
});

void test('均衡度：不足 4 个非零维度为 null，≥4 时落在 0–100', () => {
  const now = 5_000_000;
  const three = [doc('a.md', 'a', now), doc('b.md', 'b', now), doc('c.md', 'c', now)];
  assert.equal(
    buildBoardMetrics(
      three,
      classify({ 'a.md': ['factual'], 'b.md': ['conceptual'], 'c.md': ['procedural'] }),
      { now },
    ).balance,
    null,
  );

  const four = [...three, doc('d.md', 'd', now)];
  const balanced = buildBoardMetrics(
    four,
    classify({
      'a.md': ['factual'],
      'b.md': ['conceptual'],
      'c.md': ['procedural'],
      'd.md': ['metacognitive'],
    }),
    { now },
  );
  assert.equal(balanced.balance, 100, '四维同分 → 无变异');

  const uneven = [...four, doc('e.md', 'e', now)];
  const unevenMetrics = buildBoardMetrics(
    uneven,
    classify({
      'a.md': ['factual'],
      'b.md': ['factual'],
      'c.md': ['conceptual'],
      'd.md': ['procedural'],
      'e.md': ['metacognitive'],
    }),
    { now },
  );
  assert.ok(unevenMetrics.balance !== null);
  assert.ok(unevenMetrics.balance < 100 && unevenMetrics.balance >= 0);
});

void test('覆盖维度数与近 30 天活跃度', () => {
  const now = new Date(2026, 10, 23, 12, 0).getTime();
  const old = now - 40 * 24 * 60 * 60 * 1000;
  const docs = [doc('a.md', 'a', now), doc('b.md', 'b', old)];
  const metrics = buildBoardMetrics(docs, classify({ 'a.md': ['factual'], 'b.md': ['explicit'] }), {
    now,
  });
  assert.equal(metrics.coveredDimensions, 2, '两个维度得分都 ≥20');
  assert.equal(metrics.active30, 50);
  const byId = new Map(metrics.dimensions.map((dimension) => [dimension.id, dimension]));
  assert.equal(byId.get('factual')?.activity, 100);
  assert.equal(byId.get('explicit')?.activity, 0);
});
