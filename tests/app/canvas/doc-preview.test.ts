/**
 * CR-20261119-05：受限 frontmatter 解析、正文截断与两条 LRU（正文 ≤8 / 元数据 ≤32）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveSummaryFallback, CARD_TAG_LIMIT, EMPTY_SUMMARY_TEXT, PREVIEW_META_CACHE_SIZE, PREVIEW_TEXT_CACHE_SIZE, PREVIEW_TEXT_MAX_CHARS, createDocPreviewService, createLruCache, parseCardMetadata } from '../../../src/app/canvas/doc-preview.ts';

const EMPTY = { summary: null, tags: [] } as const;

void test('parseCardMetadata：无 frontmatter → 空元数据', () => {
  assert.deepEqual(parseCardMetadata('# 标题\n\n正文'), EMPTY);
});

void test('parseCardMetadata：空文本 → 空元数据', () => {
  assert.deepEqual(parseCardMetadata(''), EMPTY);
});

void test('parseCardMetadata：仅 summary', () => {
  const meta = parseCardMetadata(['---', 'summary: 一句话简介', '---'].join('\n'));
  assert.equal(meta.summary, '一句话简介');
  assert.deepEqual(meta.tags, []);
});

void test('parseCardMetadata：tags 内联数组', () => {
  const meta = parseCardMetadata(
    ['---', 'tags: [alpha, "beta gamma", delta]', '---'].join('\n'),
  );
  assert.equal(meta.summary, null);
  assert.deepEqual(meta.tags, ['alpha', 'beta gamma', 'delta']);
});

void test('parseCardMetadata：tags 块状 - item 列表（含缩进与引号）', () => {
  const meta = parseCardMetadata(['---', 'tags:', '  - alpha', "  - 'b c'", '---'].join('\n'));
  assert.equal(meta.summary, null);
  assert.deepEqual(meta.tags, ['alpha', 'b c']);
});

void test('parseCardMetadata：summary 引号剥离', () => {
  const meta = parseCardMetadata(['---', 'summary: "带引号简介"', '---'].join('\n'));
  assert.equal(meta.summary, '带引号简介');
  assert.deepEqual(meta.tags, []);
});

void test('parseCardMetadata：嵌套映射类型不符 → 空元数据', () => {
  assert.deepEqual(parseCardMetadata(['---', 'tags:', '  nested: value', '---'].join('\n')), EMPTY);
});

void test('parseCardMetadata：非法 YAML → 空元数据，不抛错', () => {
  assert.deepEqual(parseCardMetadata(['---', 'summary: [unclosed', '---'].join('\n')), EMPTY);
});

void test('常量钉死：正文 LRU 8 篇、元数据 LRU 32 篇、截断 20000 字符、标签 6 个', () => {
  assert.equal(PREVIEW_TEXT_CACHE_SIZE, 8);
  assert.equal(PREVIEW_META_CACHE_SIZE, 32);
  assert.equal(PREVIEW_TEXT_MAX_CHARS, 20000);
  assert.equal(CARD_TAG_LIMIT, 3);
  assert.equal(EMPTY_SUMMARY_TEXT, '暂无简介');  // 常量保留，node-layer 侧不再 fallback
});

void test('createLruCache：命中即刷新，超容量逐出最旧条目', () => {
  const cache = createLruCache<string, number>(2);
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);
  assert.equal(cache.get('b'), undefined, '最旧 b 被逐出');
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.size, 2);
});

void test('正文截断：超过 20000 字符只保留前 20000 并标记 truncated', async () => {
  const long = 'x'.repeat(PREVIEW_TEXT_MAX_CHARS + 1);
  const service = createDocPreviewService({
    readLiveText: () => null,
    readSnapshot: () => Promise.resolve(long),
  });
  await service.requestText('a.md');
  const preview = service.getText('a.md');
  assert.notEqual(preview, null);
  assert.equal(preview?.text.length, PREVIEW_TEXT_MAX_CHARS);
  assert.equal(preview?.truncated, true);
  assert.equal(preview?.failed, false);
});

void test('正文 LRU：第 9 篇加载后第 1 篇被逐出', async () => {
  const service = createDocPreviewService({
    readLiveText: () => null,
    readSnapshot: (path) => Promise.resolve(`text:${path}`),
  });
  for (let index = 0; index < PREVIEW_TEXT_CACHE_SIZE + 1; index += 1) {
    await service.requestText(`doc-${index}.md`);
  }
  assert.equal(service.textCacheSize, PREVIEW_TEXT_CACHE_SIZE);
  assert.equal(service.getText('doc-0.md'), null);
  assert.equal(service.getText('doc-8.md')?.text, 'text:doc-8.md');
});

void test('元数据 LRU：第 33 篇加载后第 1 篇被逐出', async () => {
  const service = createDocPreviewService({
    readLiveText: () => null,
    readSnapshot: (path) =>
      Promise.resolve(['---', `summary: ${path}`, 'tags: [a]', '---'].join('\n')),
  });
  for (let index = 0; index < PREVIEW_META_CACHE_SIZE + 1; index += 1) {
    await service.requestMeta(`doc-${index}.md`);
  }
  assert.equal(service.metaCacheSize, PREVIEW_META_CACHE_SIZE);
  assert.equal(service.getMeta('doc-0.md'), null);
  assert.equal(service.getMeta('doc-32.md')?.summary, 'doc-32.md');
});

void test('来源优先级：已打开文档用 live text，不触发 vault_read 快照', async () => {
  let snapshotCalls = 0;
  const service = createDocPreviewService({
    readLiveText: (path) => (path === 'open.md' ? 'live 内容' : null),
    readSnapshot: () => {
      snapshotCalls += 1;
      return Promise.resolve('snapshot');
    },
  });
  await service.requestText('open.md');
  assert.equal(snapshotCalls, 0);
  const preview = service.getText('open.md');
  assert.equal(preview?.text, 'live 内容');
  assert.equal(preview?.fromLive, true);
});

void test('读取失败记为显式 failed 条目，不反复重试也不抛错', async () => {
  let calls = 0;
  const service = createDocPreviewService({
    readLiveText: () => null,
    readSnapshot: () => {
      calls += 1;
      return Promise.reject(new Error('E_IO'));
    },
  });
  await service.requestText('bad.md');
  await service.requestText('bad.md');
  assert.equal(calls, 1, 'in-flight 与失败条目都去重');
  assert.equal(service.getText('bad.md')?.failed, true);
});

void test('pendingRequests：在途读取可观测，完成后归零且同路径去重', async () => {
  let resolveRead: (text: string) => void = () => assert.fail('缺少读取 resolve');
  const service = createDocPreviewService({
    readLiveText: () => null,
    readSnapshot: () => new Promise<string>((resolve) => {
      resolveRead = resolve;
    }),
  });
  const first = service.requestMeta('a.md');
  const duplicate = service.requestMeta('a.md');
  assert.equal(service.pendingRequests, 1);
  resolveRead('正文');
  await Promise.all([first, duplicate]);
  assert.equal(service.pendingRequests, 0);
});

void test('invalidate：只失效指定路径，后续读取获得新正文与元数据', async () => {
  let snapshot = ['---', 'summary: old', '---', 'old'].join('\n');
  const service = createDocPreviewService({
    readLiveText: () => null,
    readSnapshot: () => Promise.resolve(snapshot),
  });
  await Promise.all([service.requestText('a.md'), service.requestMeta('a.md')]);
  await Promise.all([service.requestText('b.md'), service.requestMeta('b.md')]);
  snapshot = ['---', 'summary: new', '---', 'new'].join('\n');

  service.invalidate('a.md');
  assert.equal(service.getText('a.md'), null);
  assert.equal(service.getMeta('a.md'), null);
  assert.notEqual(service.getText('b.md'), null, '其它路径缓存保留');

  await Promise.all([service.requestText('a.md'), service.requestMeta('a.md')]);
  assert.equal(service.getText('a.md')?.text, snapshot);
  assert.equal(service.getMeta('a.md')?.summary, 'new');
});

void test('invalidate：在途旧读取完成后不得覆盖新快照', async () => {
  let resolveOld: (text: string) => void = () => {
    assert.fail('在途读取必须提供 resolve');
  };
  let calls = 0;
  const service = createDocPreviewService({
    readLiveText: () => null,
    readSnapshot: () => {
      calls += 1;
      if (calls === 1) {
        return new Promise<string>((resolve) => {
          resolveOld = resolve;
        });
      }
      return Promise.resolve('new');
    },
  });
  const oldRequest = service.requestText('a.md');
  service.invalidate('a.md');
  await service.requestText('a.md');
  resolveOld('old');
  await oldRequest;

  assert.equal(calls, 2, '失效后允许重新读取');
  assert.equal(service.getText('a.md')?.text, 'new');
});

void test('deriveSummaryFallback：剥 frontmatter 并取第一条散文行', () => {
  const text = '---\ntitle: 论文\ntags: [a]\n---\n\n## 摘要标题\n\n这是第一条**散文**行，包含 [链接](x.md)。\n\n后续段落。';
  assert.equal(deriveSummaryFallback(text), '这是第一条散文行，包含 链接。');
});

void test('deriveSummaryFallback：跳过代码围栏与列表/引用行', () => {
  const text = '---\n---\n```ts\nconst inFence = true;\n```\n\n- 列表项不算\n> 引用不算\n\n| 表格 | 不算 |\n\n围栏后第一条散文行。';
  assert.equal(deriveSummaryFallback(text), '围栏后第一条散文行。');
});

void test('deriveSummaryFallback：超长截断加省略号', () => {
  const long = '很'.repeat(200);
  const out = deriveSummaryFallback(long);
  assert.equal(out.length, 121);
  assert.ok(out.endsWith('…'));
});

void test('deriveSummaryFallback：无可取行返回空串', () => {
  assert.equal(deriveSummaryFallback('---\n---\n\n```\n只有围栏\n```'), '');
});
