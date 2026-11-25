/**
 * A3：mapBackupErrorCode 错误码文案映射（node:test，CR-20261119-22 §6.1）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapBackupErrorCode } from '../../../src/features/backup/backup-errors.ts';

void test('E_INVALID_ARG：导出语境 = 目标已存在', () => {
  const m = mapBackupErrorCode('E_INVALID_ARG', 'exists', 'export');
  assert.equal(m.text, '目标目录已存在，请选择不存在的目录或先检查现有备份');
  assert.equal(m.tone, 'error');
});

void test('E_INVALID_ARG：校验语境 = 目录不合法', () => {
  const m = mapBackupErrorCode('E_INVALID_ARG', 'bad', 'validate');
  assert.equal(m.text, '目录不合法');
});

void test('E_NOT_FOUND：未在该目录找到备份', () => {
  const m = mapBackupErrorCode('E_NOT_FOUND', 'missing', 'inspect');
  assert.equal(m.text, '未在该目录找到备份');
  assert.equal(m.tone, 'warning');
});

void test('E_DISK_FULL：磁盘空间不足', () => {
  const m = mapBackupErrorCode('E_DISK_FULL', 'full', 'export');
  assert.equal(m.text, '磁盘空间不足，导出失败');
});

void test('E_IO / E_PATH_ESCAPE：I/O 失败并携带原始 message', () => {
  assert.equal(
    mapBackupErrorCode('E_IO', 'read error', 'export').text,
    'I/O 失败：read error',
  );
  assert.equal(
    mapBackupErrorCode('E_PATH_ESCAPE', 'escape', 'validate').text,
    'I/O 失败：escape',
  );
});

void test('未知码：回退原始 message', () => {
  const m = mapBackupErrorCode('E_SOMETHING_NEW', 'raw text', 'export');
  assert.equal(m.text, 'raw text');
  assert.equal(m.tone, 'error');
});

void test('未知码 + 空 message：给带码兜底文案，绝不抛错', () => {
  const m = mapBackupErrorCode('E_SOMETHING_NEW', '', 'inspect');
  assert.equal(m.text, '备份操作失败（E_SOMETHING_NEW）');
});

void test('code 缺失：通用文案不抛错', () => {
  const m = mapBackupErrorCode(undefined, 'boom', 'export');
  assert.equal(m.text, '备份操作失败：boom');
  assert.equal(mapBackupErrorCode(undefined, '', 'validate').text, '备份操作失败：未知错误');
});

void test('rawMessage 缺省（undefined）：空串兜底，绝不抛错（C2b）', () => {
  assert.equal(mapBackupErrorCode('E_IO', undefined, 'export').text, 'I/O 失败：');
  assert.equal(mapBackupErrorCode('E_INVALID_ARG', undefined, 'export').text, '目标目录已存在，请选择不存在的目录或先检查现有备份');
  assert.equal(mapBackupErrorCode('E_SOMETHING_NEW', undefined, 'inspect').text, '备份操作失败（E_SOMETHING_NEW）');
  assert.equal(mapBackupErrorCode(undefined, undefined, 'export').text, '备份操作失败：未知错误');
});
