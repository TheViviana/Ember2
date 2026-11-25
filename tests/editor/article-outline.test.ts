/**
 * 2026-11-23：文章大纲数据源（点列式大纲 + 点击跳转 + 滚动高亮）的纯函数测试。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArticleOutline } from '../../src/editor/article-outline.ts';

void test('空文本 / 只有 frontmatter 的文本返回空大纲', () => {
  assert.deepEqual(parseArticleOutline(''), []);
  assert.deepEqual(parseArticleOutline('---\ntitle: 空\n---\n'), []);
});

void test('识别 1~6 级标题并保留 1 基行号', () => {
  const items = parseArticleOutline('# 一\n\n正文\n\n### 三\n###### 六');
  assert.deepEqual(
    items.map((item) => [item.depth, item.text, item.line]),
    [
      [1, '一', 1],
      [3, '三', 5],
      [6, '六', 6],
    ],
  );
  assert.deepEqual(items.map((item) => item.id), ['line-1', 'line-5', 'line-6']);
});

void test('跳过 frontmatter（标题行号仍按原文计）', () => {
  const items = parseArticleOutline('---\ntitle: x\n# 不是标题\n---\n# 正文标题');
  assert.deepEqual(items.map((item) => [item.text, item.line]), [['正文标题', 5]]);
});

void test('跳过代码围栏内部的井号', () => {
  const text = ['# 真标题', '```bash', '# 注释不是标题', '```', '## 第二个', '~~~', '# 也不是', '~~~'].join(
    '\n',
  );
  assert.deepEqual(
    parseArticleOutline(text).map((item) => item.text),
    ['真标题', '第二个'],
  );
});

void test('清理行内 Markdown 与收尾井号', () => {
  const items = parseArticleOutline('## 收尾 ##\n### [链接](https://a.b) 与 `代码` 与 **粗体**\n## [[目标|别名]]');
  assert.deepEqual(
    items.map((item) => item.text),
    ['收尾', '链接 与 代码 与 粗体', '别名'],
  );
});

void test('空标题被过滤', () => {
  assert.deepEqual(parseArticleOutline('##\n###   \n# 有效'), [
    { id: 'line-3', line: 3, depth: 1, text: '有效' },
  ]);
});

void test('识别 setext 标题（=== / ---），并与下一段正文区分', () => {
  const text = ['一级标题', '=====', '', '二级标题', '-----', '', '正文', '', '---', '', '结尾'].join('\n');
  assert.deepEqual(
    parseArticleOutline(text).map((item) => [item.depth, item.text, item.line]),
    [
      [1, '一级标题', 1],
      [2, '二级标题', 4],
    ],
  );
});
