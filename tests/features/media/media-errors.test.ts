/**
 * media-errors：媒体命令错误码文案映射（CR-20261119-23 C2c）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapMediaErrorCode } from '../../../src/features/media/media-errors.ts';

void test('E_INVALID_ARG → 媒体路径不合法', () => {
  const m = mapMediaErrorCode('E_INVALID_ARG', 'bad prefix');
  assert.equal(m.text, '媒体路径不合法（必须位于 media/ 下）');
  assert.equal(m.detail, 'bad prefix', '原始 message 作为次要信息保留');
});

void test('E_NOT_FOUND / E_READONLY / E_DISK_FULL / E_IO / E_TRASH_FAILED → 显式文案', () => {
  assert.equal(mapMediaErrorCode('E_NOT_FOUND', 'x').text, '媒体文件不存在');
  assert.equal(mapMediaErrorCode('E_READONLY', 'x').text, '当前库为只读，无法删除');
  assert.equal(mapMediaErrorCode('E_DISK_FULL', 'x').text, '磁盘空间不足，删除失败');
  assert.equal(mapMediaErrorCode('E_IO', 'disk hiccup').text, 'I/O 失败');
  assert.equal(mapMediaErrorCode('E_TRASH_FAILED', 'x').text, '移入回收站失败');
  assert.equal(mapMediaErrorCode('E_IO', 'disk hiccup').detail, 'disk hiccup');
});

void test('未知码回退原始 message', () => {
  const m = mapMediaErrorCode('E_SOMETHING_NEW', 'raw text');
  assert.equal(m.text, 'raw text');
  assert.equal(m.detail, null, '回退时 text 已含原文，detail 不重复');
});

void test('空 message 兜底：带码 / 缺码，绝不抛错', () => {
  assert.equal(mapMediaErrorCode('E_SOMETHING_NEW', '').text, '媒体操作失败（E_SOMETHING_NEW）');
  assert.equal(mapMediaErrorCode(undefined, '').text, '媒体操作失败');
  assert.equal(mapMediaErrorCode(undefined, '').detail, null);
  assert.equal(mapMediaErrorCode('E_IO', '').detail, null, '空 message 不产生 detail');
});

void test('E_INVALID_ARG 空 message：映射文案在、detail 为 null', () => {
  const m = mapMediaErrorCode('E_INVALID_ARG', '');
  assert.equal(m.text, '媒体路径不合法（必须位于 media/ 下）');
  assert.equal(m.detail, null);
});
