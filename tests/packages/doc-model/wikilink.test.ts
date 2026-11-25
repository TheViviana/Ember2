/**
 * A3：extractWikiLinks 各形态 / 转义 / 空壳 / 幂等（CR-20261119-20 §5.1）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { extractWikiLinks } from '#doc-model';

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

void test('[[a]]：target/label/embedded', () => {
  assert.deepEqual([...extractWikiLinks('见 [[a]]。')], [
    { target: 'a', label: 'a', embedded: false },
  ]);
});

void test('[[a|b]]：alias 覆盖 label', () => {
  assert.deepEqual([...extractWikiLinks('[[a|b]]')], [
    { target: 'a', alias: 'b', label: 'b', embedded: false },
  ]);
});

void test('![[e]]：嵌入', () => {
  assert.deepEqual([...extractWikiLinks('![[e]]')], [
    { target: 'e', label: 'e', embedded: true },
  ]);
});

void test('![[e|f]]：嵌入 + 别名', () => {
  assert.deepEqual([...extractWikiLinks('![[e|f]]')], [
    { target: 'e', alias: 'f', label: 'f', embedded: true },
  ]);
});

void test('\\[[ 转义：不提取', () => {
  assert.deepEqual([...extractWikiLinks('\\[[x]]')], []);
});

void test('\\![[ 转义：不提取', () => {
  assert.deepEqual([...extractWikiLinks('\\![[y]]')], []);
});

void test('空壳不算链接：[[]] 与 [[|别名]]', () => {
  assert.deepEqual([...extractWikiLinks('[[]] [[|b]]')], []);
});

void test('target 与 alias 去首尾空白', () => {
  assert.deepEqual([...extractWikiLinks('[[ 空格目标 | 空格别名 ]]')], [
    { target: '空格目标', alias: '空格别名', label: '空格别名', embedded: false },
  ]);
});

void test('多个链接按出现顺序提取', () => {
  const links = [...extractWikiLinks('[[甲]] 中间 ![[乙|丙]] 尾 [[丁]]')];
  assert.equal(links.length, 3);
  assert.deepEqual(links.map((l) => l.target), ['甲', '乙', '丁']);
  assert.equal(links[1]?.embedded, true);
});

void test('空串与无链接文本：[]', () => {
  assert.deepEqual([...extractWikiLinks('')], []);
  assert.deepEqual([...extractWikiLinks('普通 [单括号] 与 [文本]。')], []);
});

void test('fixture（wikilinks.md）：六形态含转义与空壳', () => {
  const links = [...extractWikiLinks(fixture('wikilinks.md'))];
  assert.deepEqual(links.map((l) => [l.target, l.label, l.embedded]), [
    ['目标', '目标', false],
    ['目标', '别名', false],
    ['嵌入', '嵌入', true],
    ['嵌入', '别名', true],
  ]);
});

void test('幂等：两次调用一致，不改原文', () => {
  const text = fixture('wikilinks.md');
  const first = [...extractWikiLinks(text)];
  const second = [...extractWikiLinks(text)];
  assert.deepEqual(first, second);
  assert.equal(text.includes('[[目标]]'), true);
});
