/**
 * A4：backup-flow 白名单 / 路径拼接 / IPC 结果分流（node:test，CR-20261119-22 §6.1）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildDestination,
  classifyExportResult,
  classifyInspectResult,
  generateDefaultBackupName,
  normalizeFailure,
  validateBackupName,
} from '../../../src/features/backup/backup-flow.ts';

// ─── validateBackupName（严格白名单，复核修订）───────────────────────────────

void test('validateBackupName：合法名 true', () => {
  assert.equal(validateBackupName('ember-20261119-100000'), true);
  assert.equal(validateBackupName('a_1-B.2'), true);
  assert.equal(validateBackupName('backup9'), true);
  assert.equal(validateBackupName('b'), true);
});

void test('validateBackupName：空 / 空格 / 含分隔符 / 控制字符 → false', () => {
  assert.equal(validateBackupName(''), false);
  assert.equal(validateBackupName(' '), false);
  assert.equal(validateBackupName('   '), false);
  assert.equal(validateBackupName('a b'), false);
  assert.equal(validateBackupName('a/b'), false);
  assert.equal(validateBackupName('a\\b'), false);
  assert.equal(validateBackupName('a:b'), false);
  assert.equal(validateBackupName('a\tb'), false);
  assert.equal(validateBackupName('a\nb'), false);
});

void test('validateBackupName：点（首尾点与双点）→ false', () => {
  assert.equal(validateBackupName('.'), false);
  assert.equal(validateBackupName('..'), false);
  assert.equal(validateBackupName('.hidden'), false);
  assert.equal(validateBackupName('name.'), false);
  assert.equal(validateBackupName('a..b'), false);
  assert.equal(validateBackupName('a.b.c'), true); // 中间单点合法
});

void test('validateBackupName：Windows 保留名按 stem 判（含带扩展名，大小写不敏感）→ false', () => {
  for (const reserved of ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9']) {
    assert.equal(validateBackupName(reserved), false, reserved);
    assert.equal(validateBackupName(reserved.toLowerCase()), false, reserved.toLowerCase());
  }
  // C2b 复核修订：stem 判——首个点之前的段命中保留名即拒。
  assert.equal(validateBackupName('CON.txt'), false);
  assert.equal(validateBackupName('COM1.log'), false);
  assert.equal(validateBackupName('NUL.foo'), false);
  assert.equal(validateBackupName('con.txt'), false);
  assert.equal(validateBackupName('com0'), true); // COM1-9 才保留
  assert.equal(validateBackupName('console.txt'), true); // stem 非全等不算保留名
  assert.equal(validateBackupName('my.backup'), true); // stem 'MY' 非保留名
});

// ─── buildDestination ───────────────────────────────────────────────────────

void test('buildDestination：正确拼接、尾随分隔符归一', () => {
  assert.equal(buildDestination('/tmp/vault', 'ember-x'), '/tmp/vault/ember-x');
  assert.equal(buildDestination('/tmp/vault/', 'ember-x'), '/tmp/vault/ember-x');
  assert.equal(buildDestination('C:\\vault', 'ember-x'), 'C:\\vault/ember-x');
});

void test('buildDestination：目录为空或名非法 → null', () => {
  assert.equal(buildDestination('', 'ember-x'), null);
  assert.equal(buildDestination('/tmp/vault', ''), null);
  assert.equal(buildDestination('/tmp/vault', 'a/b'), null);
  assert.equal(buildDestination('/tmp/vault', '..'), null);
});

// ─── generateDefaultBackupName ──────────────────────────────────────────────

void test('generateDefaultBackupName：ember-<YYYYMMDD-HHmmss>（本地时间）', () => {
  assert.equal(generateDefaultBackupName(new Date(2026, 10, 19, 8, 5, 3)), 'ember-20261119-080503');
  assert.equal(generateDefaultBackupName(new Date(2026, 0, 2, 23, 59, 59)), 'ember-20260102-235959');
});

// ─── classifyInspectResult：探测分流 ────────────────────────────────────────

void test('classifyInspectResult：ok → inspect-found（done 展示）', () => {
  const dto = { path: '/tmp/vault/bk', version: 3, createdAt: '2026-11-19T00:00:00Z', sourceRoot: '/tmp/vault', files: 5, bytes: 100 };
  const out = classifyInspectResult({ ok: true, inspect: dto });
  assert.deepEqual(out, { kind: 'inspect-found', inspect: dto });
});

void test('classifyInspectResult：E_NOT_FOUND → should-export（自动导出）', () => {
  const out = classifyInspectResult({ ok: false, failure: { code: 'E_NOT_FOUND', message: 'no manifest' } });
  assert.deepEqual(out, { kind: 'should-export' });
});

void test('classifyInspectResult：其它错误码 → error（保留 code/message）', () => {
  const out = classifyInspectResult({ ok: false, failure: { code: 'E_IO', message: 'io' } });
  assert.deepEqual(out, { kind: 'error', code: 'E_IO', message: 'io' });
});

// ─── classifyExportResult：导出分流 ─────────────────────────────────────────

void test('classifyExportResult：ok → export-done', () => {
  const report = { path: '/tmp/vault/bk', files: 5, bytes: 100, createdAt: '2026-11-19T00:00:00Z' };
  const out = classifyExportResult({ ok: true, report });
  assert.deepEqual(out, { kind: 'export-done', report });
});

void test('classifyExportResult：E_INVALID_ARG 竞态兜底 → error，绝不标记成功', () => {
  const out = classifyExportResult({ ok: false, failure: { code: 'E_INVALID_ARG', message: 'exists' } });
  assert.deepEqual(out, { kind: 'error', code: 'E_INVALID_ARG', message: 'exists' });
  assert.notEqual(out.kind, 'export-done');
});

// ─── normalizeFailure（C2b 复核修订）────────────────────────────────────────

void test('normalizeFailure：Error → 取 message 与自定义 code', () => {
  const err = new Error('ipc boom');
  (err as { code?: string }).code = 'E_IO';
  assert.deepEqual(normalizeFailure(err), { code: 'E_IO', message: 'ipc boom' });
  assert.deepEqual(normalizeFailure(new Error('no code')), { code: undefined, message: 'no code' });
});

void test('normalizeFailure：string reject → message 直取', () => {
  assert.deepEqual(normalizeFailure('raw string failure'), { code: undefined, message: 'raw string failure' });
});

void test('normalizeFailure：null / 其它 / 空 → 兜底文案，绝不抛错', () => {
  assert.deepEqual(normalizeFailure(null), { code: undefined, message: '备份操作失败' });
  assert.deepEqual(normalizeFailure(undefined), { code: undefined, message: '备份操作失败' });
  assert.deepEqual(normalizeFailure(42), { code: undefined, message: '备份操作失败' });
  assert.deepEqual(normalizeFailure({ weird: true }), { code: undefined, message: '备份操作失败' });
  assert.deepEqual(normalizeFailure(new Error('')), { code: undefined, message: '' });
});
