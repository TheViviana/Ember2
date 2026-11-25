/**
 * H1 / S2：`EmberIpcError` 增加 `currentSha` / `cause` 后，P2 既有错误路径的
 * 形状必须不变——缺省键一律归一为 `null`，不得出现 `undefined` 自有键
 * （`JSON.stringify` 会丢 `undefined`，会造成 wire 形状随调用点漂移）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toIpcError } from '../../src/core/errors.ts';

void test('P2 既有错误路径：缺省扩展字段归一为 null，不产生 undefined 键', () => {
  const payload = { code: 'E_IO', message: 'boom' };
  const error = toIpcError('vault_read', payload);

  assert.equal(error.code, 'E_IO');
  assert.equal(error.command, 'vault_read');
  assert.equal(error.message, 'boom');
  assert.equal(error.currentSha, null);
  assert.equal(error.cause, null);

  for (const [key, value] of Object.entries(error)) {
    assert.notEqual(value, undefined, `${key} 不得为 undefined`);
  }
  assert.equal(
    JSON.stringify({
      code: error.code,
      message: error.message,
      currentSha: error.currentSha,
      cause: error.cause,
    }),
    '{"code":"E_IO","message":"boom","currentSha":null,"cause":null}',
    'wire 形状稳定：null 显式出现，undefined 不会丢键',
  );
  assert.deepEqual(payload, { code: 'E_IO', message: 'boom' }, '归一化不得改写调用方载荷');
});

void test('非对象 rejection：仍归一为 E_UNKNOWN，扩展字段为 null', () => {
  const error = toIpcError('vault_write', new Error('kaboom'));

  assert.equal(error.code, 'E_UNKNOWN');
  assert.equal(error.message, 'kaboom');
  assert.equal(error.currentSha, null);
  assert.equal(error.cause, null);
});

void test('画布错误载荷：currentSha / cause 按存在才透传，缺省为 null', () => {
  const conflict = toIpcError('canvas_write', {
    code: 'E_CONFLICT',
    message: 'canvas changed before write',
    currentSha: '9f2c',
  });
  assert.equal(conflict.code, 'E_CONFLICT');
  assert.equal(conflict.currentSha, '9f2c');
  assert.equal(conflict.cause, null);

  const backup = toIpcError('canvas_write', {
    code: 'E_BACKUP_FAILED',
    message: 'backup failed',
    cause: 'ENOSPC',
  });
  assert.equal(backup.cause, 'ENOSPC');
  assert.equal(backup.currentSha, null);

  const bogus = toIpcError('canvas_write', {
    code: 'E_BACKUP_FAILED',
    message: 'backup failed',
    cause: 'E_OTHER',
  });
  assert.equal(bogus.cause, null, 'cause 只接受 EACCES / ENOSPC / E_IO 三值');
});

void test('未知码保留 rawCode，扩展字段不丢失', () => {
  const error = toIpcError('canvas_read', {
    code: 'E_FUTURE_CODE',
    message: 'future',
    currentSha: 'abc',
  });

  assert.equal(error.code, 'E_UNKNOWN');
  assert.equal(error.rawCode, 'E_FUTURE_CODE');
  assert.equal(error.currentSha, 'abc');
  assert.equal(error.cause, null);
});
