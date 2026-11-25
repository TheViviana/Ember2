/**
 * CR-20261120-34：Markdown 安全预览渲染模型测试。
 *
 * 重点断言：raw HTML 不进入标签通道、危险协议不产出链接、相对链接与媒体引用
 * 只按库内相对路径规则解析。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToMdast } from '#doc-model';
import {
  classifyPreviewUrl,
  resolveInternalDocPath,
  toPreviewBlocks,
} from '../../src/editor/markdown-preview-model.ts';

function blocksOf(text: string) {
  return toPreviewBlocks(parseToMdast(text));
}

void test('标题、段落与列表映射为块级模型', () => {
  const blocks = blocksOf('# 标题\n\n正文 **加粗**\n\n- 一\n- 二');
  assert.equal(blocks[0]?.kind, 'heading');
  if (blocks[0]?.kind === 'heading') assert.equal(blocks[0].depth, 1);
  assert.equal(blocks[1]?.kind, 'paragraph');
  assert.equal(blocks[2]?.kind, 'list');
  if (blocks[2]?.kind === 'list') {
    assert.equal(blocks[2].items.length, 2);
    assert.equal(blocks[2].ordered, false);
  }
});

void test('raw HTML 保留为 html 节点，绝不下钻成可执行标签', () => {
  const blocks = blocksOf('<script>alert(1)</script>\n\n段落 <img src=x onerror=alert(1)>');
  assert.equal(blocks[0]?.kind, 'html');
  if (blocks[0]?.kind === 'html') assert.equal(blocks[0].value, '<script>alert(1)</script>');

  const paragraph = blocks[1];
  assert.equal(paragraph?.kind, 'paragraph');
  if (paragraph?.kind === 'paragraph') {
    const html = paragraph.children.find((child) => child.kind === 'html');
    assert.ok(html !== undefined, '行内 HTML 应保留为文本节点');
    if (html?.kind === 'html') assert.equal(html.value, '<img src=x onerror=alert(1)>');
  }
});

void test('库内媒体引用解析为 media，库外图片降级为字面文本', () => {
  const blocks = blocksOf('![图](media/image/a.png)\n\n![远程](https://example.com/a.png)');
  const first = blocks[0];
  assert.equal(first?.kind, 'paragraph');
  if (first?.kind === 'paragraph') {
    assert.equal(first.children[0]?.kind, 'media');
    if (first.children[0]?.kind === 'media') {
      assert.equal(first.children[0].media, 'image');
      assert.equal(first.children[0].path, 'media/image/a.png');
    }
  }
  const second = blocks[1];
  assert.equal(second?.kind, 'paragraph');
  if (second?.kind === 'paragraph') {
    assert.equal(second.children[0]?.kind, 'literal');
  }
});

void test('链接到库内音频渲染为 media 控件，普通外链仍是 link', () => {
  const blocks = blocksOf('[听](media/audio/a.mp3) [站点](https://example.com)');
  const paragraph = blocks[0];
  assert.equal(paragraph?.kind, 'paragraph');
  if (paragraph?.kind === 'paragraph') {
    assert.equal(paragraph.children[0]?.kind, 'media');
    if (paragraph.children[0]?.kind === 'media') assert.equal(paragraph.children[0].media, 'audio');
    assert.ok(paragraph.children.some((child) => child.kind === 'link'));
  }
});

void test('GFM 表格映射表头与行', () => {
  const blocks = blocksOf('| A | B |\n| --- | --- |\n| 1 | 2 |');
  assert.equal(blocks[0]?.kind, 'table');
  if (blocks[0]?.kind === 'table') {
    assert.equal(blocks[0].header.length, 2);
    assert.equal(blocks[0].rows.length, 1);
  }
});

void test('链接协议分类：危险 scheme 一律 unsafe', () => {
  assert.equal(classifyPreviewUrl('javascript:alert(1)'), 'unsafe');
  assert.equal(classifyPreviewUrl(' JaVaScRiPt:alert(1)'), 'unsafe');
  assert.equal(classifyPreviewUrl('data:text/html,<b>x</b>'), 'unsafe');
  assert.equal(classifyPreviewUrl('vbscript:msgbox'), 'unsafe');
  assert.equal(classifyPreviewUrl('https://example.com'), 'external');
  assert.equal(classifyPreviewUrl('mailto:a@b.c'), 'external');
  assert.equal(classifyPreviewUrl('#anchor'), 'anchor');
  assert.equal(classifyPreviewUrl('note.md'), 'internal');
  assert.equal(classifyPreviewUrl('sub/note.md#h'), 'internal');
});

void test('相对链接按当前文档目录解析，越出库根返回 null', () => {
  assert.equal(resolveInternalDocPath('a/b.md', 'c.md'), 'a/c.md');
  assert.equal(resolveInternalDocPath('a/b.md', '../c.md'), 'c.md');
  assert.equal(resolveInternalDocPath('a/b.md', 'sub/d.md#x'), 'a/sub/d.md');
  assert.equal(resolveInternalDocPath('a/b.md', '/root.md'), 'root.md');
  assert.equal(resolveInternalDocPath('a/b.md', '../../escape.md'), null);
  assert.equal(resolveInternalDocPath('a/b.md', '#only-anchor'), null);
});

void test('数学公式：行内与块级映射，且不产生 HTML', () => {
  const blocks = blocksOf('质能方程 $E=mc^2$。\n\n$$\n\\int_0^1 x dx\n$$');
  const paragraph = blocks[0];
  assert.equal(paragraph?.kind, 'paragraph');
  if (paragraph?.kind === 'paragraph') {
    const math = paragraph.children.find((child) => child.kind === 'math');
    assert.ok(math !== undefined);
    if (math?.kind === 'math') {
      assert.equal(math.value, 'E=mc^2');
      assert.equal(math.display, false);
    }
  }
  assert.equal(blocks[1]?.kind, 'math');
  if (blocks[1]?.kind === 'math') assert.match(blocks[1].value, /\\int_0\^1/);
});

void test('GFM 任务列表：itemChecked 与普通列表项区分', () => {
  const blocks = blocksOf('- [x] 完成\n- [ ] 未完成\n- 普通');
  assert.equal(blocks[0]?.kind, 'list');
  if (blocks[0]?.kind === 'list') {
    assert.deepEqual([...blocks[0].itemChecked], [true, false, null]);
  }
});

void test('双链在文本节点内拆分为 wikilink，代码内不解析', () => {
  const blocks = blocksOf('见 [[项目/计划|计划]] 与 `[[不解析]]`');
  const paragraph = blocks[0];
  assert.equal(paragraph?.kind, 'paragraph');
  if (paragraph?.kind === 'paragraph') {
    const link = paragraph.children.filter((child) => child.kind === 'wikilink');
    assert.equal(link.length, 1);
    if (link[0]?.kind === 'wikilink') {
      assert.equal(link[0].target, '项目/计划');
      assert.equal(link[0].label, '计划');
      assert.equal(link[0].embedded, false);
    }
    assert.ok(paragraph.children.some(
      (child) => child.kind === 'code' && child.value === '[[不解析]]',
    ));
  }
});

void test('块级节点带正文偏移，供阅读模式选段定位', () => {
  const blocks = blocksOf('# 标题\n\n正文');
  assert.equal(blocks[0]?.position?.start, 0);
  assert.ok((blocks[1]?.position?.start ?? -1) > 0);
  assert.ok((blocks[1]?.position?.end ?? -1) > (blocks[1]?.position?.start ?? 0));
});
