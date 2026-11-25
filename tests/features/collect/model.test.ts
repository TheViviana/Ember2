import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addFileItems,
  createLinkItem,
  createTextItem,
  inboxItemDragPayload,
} from '../../../src/features/collect/model.ts';

let sequence = 0;
const factory = { id: () => `id-${++sequence}`, now: () => 1234 };

void test('文本、链接与文件条目序列化为既有拖放载荷', () => {
  const text = createTextItem('  一段文本  ', factory);
  const link = createLinkItem('https://example.com/a(b)', '示例', factory);
  assert.equal(text?.kind, 'text');
  assert.equal(link?.kind, 'link');
  if (text === null || link === null) return;
  assert.deepEqual(inboxItemDragPayload(text), { kind: 'text', text: '一段文本' });
  assert.deepEqual(inboxItemDragPayload(link), {
    kind: 'text',
    text: '[示例](https://example.com/a\\(b\\))',
  });
  const files = addFileItems([], ['/tmp/a.bin'], factory);
  const item = files.items[0];
  assert.equal(item?.kind, 'file');
  if (item === undefined) return;
  assert.deepEqual(inboxItemDragPayload(item), { kind: 'files', paths: ['/tmp/a.bin'] });
});

void test('文件引用按路径去重且保留源路径', () => {
  const first = addFileItems([], ['/tmp/a.bin', '/tmp/a.bin', '/tmp/b.bin'], factory);
  assert.equal(first.added, 2);
  const second = addFileItems(first.items, ['/tmp/a.bin'], factory);
  assert.equal(second.added, 0);
  assert.equal(second.items, first.items);
});

void test('空文本与非 http(s) 链接不会入箱', () => {
  assert.equal(createTextItem('  ', factory), null);
  assert.equal(createLinkItem('file:///tmp/a', 'a', factory), null);
  assert.equal(createLinkItem('not a url', 'a', factory), null);
});
