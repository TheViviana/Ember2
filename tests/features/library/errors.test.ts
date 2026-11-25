/**
 * CR-20261119-14：library-errors 纯函数测试。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapLibraryIpcError } from '../../../src/features/library/library-errors.ts';

void describe('mapLibraryIpcError', () => {
  void it('E_INVALID_ARG：已在库列表中', () => {
    assert.equal(
      mapLibraryIpcError({ code: 'E_INVALID_ARG', message: '该目录已在库列表中' }),
      '该目录已注册',
    );
  });

  void it('E_INVALID_ARG：互相嵌套', () => {
    assert.equal(
      mapLibraryIpcError({ code: 'E_INVALID_ARG', message: '库目录不能互相嵌套' }),
      '库目录不能嵌套在已有库中',
    );
  });

  void it('E_INVALID_ARG：必须绝对路径', () => {
    assert.equal(
      mapLibraryIpcError({ code: 'E_INVALID_ARG', message: '库路径必须是绝对路径' }),
      '请输入绝对路径（以 / 开头）',
    );
  });

  void it('E_INVALID_ARG：当前库禁删', () => {
    assert.equal(
      mapLibraryIpcError({ code: 'E_INVALID_ARG', message: '不能移除当前库' }),
      '不能移除当前使用的库',
    );
  });

  void it('E_INVALID_ARG：vaultId 重复', () => {
    assert.equal(
      mapLibraryIpcError({ code: 'E_INVALID_ARG', message: '该库已注册（vaultId 重复）' }),
      '该目录已是已注册的库（vaultId 重复）',
    );
  });

  void it('E_NOT_FOUND', () => {
    assert.equal(
      mapLibraryIpcError({ code: 'E_NOT_FOUND', message: 'not found' }),
      '目录不存在，请确认路径正确',
    );
  });

  void it('E_IO', () => {
    assert.equal(
      mapLibraryIpcError({ code: 'E_IO', message: 'permission denied' }),
      '无法访问目录（可能无权限）',
    );
  });

  void it('E_DISK_FULL', () => {
    assert.equal(
      mapLibraryIpcError({ code: 'E_DISK_FULL', message: '' }),
      '磁盘空间不足',
    );
  });

  void it('未知错误码 → 通用 fallback', () => {
    assert.equal(
      mapLibraryIpcError({ code: 'E_UNKNOWN', message: 'bad things' }),
      '操作失败：bad things',
    );
  });

  void it('E_INVALID_ARG：未覆盖的 message → raw 原文', () => {
    assert.equal(
      mapLibraryIpcError({ code: 'E_INVALID_ARG', message: 'some new reason' }),
      'some new reason',
    );
  });
});
