/**
 * 2026-11-23 二次修订：右侧点阵大纲的视觉/交互不变量（源码断言）。
 *
 * 这些规则无法在 node:test 中布局，但都是用户明确的形态要求：
 * - 点阵长度固定为浮窗高度的 1/3，右侧 16px 热区，避开 8px 滚动条；
 * - 默认隐藏，指针进入热区才显示；
 * - 上淡下深；悬停点弹出「级别 + 标题」标签。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const css = readFileSync(
  new URL('../../src/editor/ArticleOutline.module.css', import.meta.url),
  'utf8',
);
const source = readFileSync(
  new URL('../../src/editor/ArticleOutline.tsx', import.meta.url),
  'utf8',
);

void test('点阵长度 1/3 浮窗高度，右侧 16px 热区，默认隐藏、悬停显示', () => {
  assert.match(css, /\.rail\s*\{[^}]*height:\s*33\.3333%;/s, '点阵必须占浮窗高度 1/3');
  assert.match(css, /\.rail\s*\{[^}]*top:\s*50%;/s, '点阵垂直居中');
  assert.match(css, /\.rail\s*\{[^}]*opacity:\s*0;/s, '默认隐藏');
  assert.match(css, /\.zone\s*\{[^}]*right:\s*8px;/s, '热区从滚动条右侧开始');
  assert.match(css, /\.zone\s*\{[^}]*width:\s*16px;/s, '热区宽度 16px');
  assert.match(css, /\.rail\[data-visible='true'\]/, '指针进入后显示');
  assert.match(css, /\.dot\[data-active='true'\] \.dotCore/, '当前章节显示圆环');
});

void test('点阵上淡下深，悬停/聚焦点显示级别 + 标题标签', () => {
  assert.match(source, /0\.3 \+ 0\.7 \* \(index \/ \(items\.length - 1\)\)/, '上淡下深渐变');
  assert.match(source, /LEVEL_LABELS/, '级别文案');
  assert.match(source, /className=\{styles\.tip\}/, '悬停标签');
  assert.match(source, /onPointerEnter=\{\(event\) => showTip\(item\.id, event\.currentTarget\)\}/, '悬停显示标签');
  assert.match(source, /onFocus=\{\(event\) => showTip\(item\.id, event\.currentTarget\)\}/, '键盘聚焦同样显示标签');
  assert.match(css, /\.dotList\s*\{[^}]*overflow-y:\s*auto;/s, '标题多时点阵容器可滚动');
  assert.match(css, /\.dotList\s*\{[^}]*height:\s*100%;/s, '滚动容器填满 1/3 轨道');
  assert.match(source, /dotListRef/, '自动把当前章节滚入可见范围');
  assert.doesNotMatch(source, /收起大纲/, '旧的卡片式大纲不再保留');
});
