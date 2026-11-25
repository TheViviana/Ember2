/**
 * 2026-11-23 看板精修：全局范围、KPI 点击筛选、建议处理、快照对比、
 * 修改/新增双线、网络低连接过滤与主题色板（源码不变量）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = process.cwd();
const view = readFileSync(join(ROOT, 'src/features/board/BoardView.tsx'), 'utf8');
const css = readFileSync(join(ROOT, 'src/features/board/BoardView.module.css'), 'utf8');
const tokens = readFileSync(join(ROOT, 'src/styles/tokens.css'), 'utf8');

void test('BoardView 不再引用已删除的 TREND_DAYS 常量', () => {
  assert.doesNotMatch(view, /\bTREND_DAYS\b/);
});

void test('跨午夜/重新可见时刷新时间窗口锚点', () => {
  assert.match(view, /setHours\(24, 0, 0, 0\)/);
  assert.match(view, /visibilitychange/);
  assert.match(view, /setNow\(Date\.now\(\)\)/);
});

void test('看板头部有全部/30/90/182 范围与数据截至', () => {
  assert.match(view, /const RANGE_OPTIONS = \[/);
  assert.match(view, /label: '全部'/);
  assert.match(view, /label: '30 天'/);
  assert.match(view, /label: '90 天'/);
  assert.match(view, /label: '182 天'/);
  assert.match(view, /数据截至 \{dateLabel\(localDateKey\(now\)\)\}/);
  assert.match(css, /\.header \{[^}]*position: sticky/s);
});

void test('KPI 行是按钮，可切今日/近 7 天/清空范围', () => {
  assert.match(view, /className=\{styles\.kpiRow\}/);
  assert.match(view, /selectQuick\('week'\)/);
  assert.match(view, /setActiveDate\(localDateKey\(now\)\)/);
  assert.match(view, /onClick=\{clearAllFilters\}/);
});

void test('建议处理条覆盖未分类/孤立/断链/久未更新/未覆盖维度', () => {
  assert.match(view, /aria-label="建议处理"/);
  assert.match(view, /未分类 <strong>/);
  assert.match(view, /孤立 <strong>/);
  assert.match(view, /断链 <strong>/);
  assert.match(view, /90 天未更新 <strong>/);
  assert.match(view, /未覆盖维度 <strong>/);
});

void test('趋势图有修改与新增两条线，热力图窗口随范围变化', () => {
  assert.match(view, /className=\{styles\.chartLineCreated\}/);
  assert.match(view, /trendCreated === null \? '' :/);
  assert.match(view, /最近 \{heatmapDays\} 天/);
  assert.match(view, /heatmapDays: rangeDays === null|heatmapDays = rangeDays \?\?/);
});

void test('快照对比可展开，且范围/下钻时不写快照', () => {
  assert.match(view, /className=\{styles\.snapshotDetails\}/);
  assert.match(view, /展开快照对比/);
  assert.match(view, /if \(!fullView\) return;/);
  assert.match(view, /previous\.scores\[dimension\.id\]/);
});

void test('知识网络支持低连接过滤', () => {
  assert.match(view, /networkLowDegree/);
  assert.match(view, /低连接/);
  assert.match(view, /node\.degree <= 1/);
});

void test('看板卡片有材质阴影/内高光，维度色走 token', () => {
  assert.match(css, /--shadow-sm\), var\(--ember-glass-highlight\)/);
  assert.match(css, /\.card:hover/);
  for (const name of [
    'factual',
    'conceptual',
    'procedural',
    'metacognitive',
    'explicit',
    'tacit',
    'interpersonal',
    'value',
  ]) {
    assert.match(tokens, new RegExp(`--board-dim-${name}:`));
  }
  assert.match(
    readFileSync(join(ROOT, 'src/features/board/model.ts'), 'utf8'),
    /color: 'var\(--board-dim-factual\)'/,
  );
});
