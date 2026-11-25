/**
 * A1：backup-reducer 六态状态机（node:test 纯逻辑，CR-20261119-22 §6.1）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  backupPanelReducer,
  createBackupPanelState,
  type BackupPanelAction,
  type BackupPanelState,
} from '../../../src/features/backup/backup-reducer.ts';

const DIR = '/tmp/ember-vault';
const DEFAULT_NOW = new Date(2026, 10, 19, 10, 0, 0); // 2026-11-19 10:00:00 本地
const DEFAULT_NAME = 'ember-20261119-100000';

function run(state: BackupPanelState, action: BackupPanelAction): BackupPanelState {
  return backupPanelReducer(state, action);
}

function pick(name: string = DEFAULT_NAME): BackupPanelState {
  return run(createBackupPanelState(DEFAULT_NOW), { type: 'PICK', dir: DIR, name });
}

// ─── 初始态 ─────────────────────────────────────────────────────────────────

void test('createBackupPanelState：idle + 默认时间戳名 + destination null', () => {
  const s = createBackupPanelState(DEFAULT_NOW);
  assert.equal(s.status, 'idle');
  assert.equal(s.selectedDir, null);
  assert.equal(s.backupName, DEFAULT_NAME);
  assert.equal(s.destination, null);
  assert.equal(s.result, null);
  assert.equal(s.error, null);
});

// ─── PICK ───────────────────────────────────────────────────────────────────

void test('PICK(null)：维持 idle、不进 error、不清 backupName', () => {
  const s = createBackupPanelState(DEFAULT_NOW);
  const s1 = run(s, { type: 'PICK', dir: null, name: '' });
  assert.equal(s1.status, 'idle');
  assert.equal(s1.error, null);
  assert.equal(s1.backupName, DEFAULT_NAME);
  assert.equal(s1.selectedDir, null);
});

void test('PICK_ERR（选择器异常，非取消）：落 error phase=validate，保留 backupName', () => {
  const s = run(createBackupPanelState(DEFAULT_NOW), {
    type: 'PICK_ERR',
    code: undefined,
    message: 'dialog crashed',
  });
  assert.equal(s.status, 'error');
  assert.equal(s.error?.phase, 'validate');
  assert.equal(s.error?.message, 'dialog crashed');
  assert.equal(s.backupName, DEFAULT_NAME);
});

void test('PICK(有 dir)：selectedDir/backupName/destination 三件套正确 + 转 validating + 清旧 result/error', () => {
  const s = pick();
  assert.equal(s.status, 'validating');
  assert.equal(s.selectedDir, DIR);
  assert.equal(s.backupName, DEFAULT_NAME);
  assert.equal(s.destination, `${DIR}/${DEFAULT_NAME}`);
  assert.equal(s.result, null);
  assert.equal(s.error, null);
});

void test('PICK(dir 尾随分隔符)：destination 不出现双斜杠', () => {
  const s = run(createBackupPanelState(DEFAULT_NOW), {
    type: 'PICK',
    dir: '/tmp/ember-vault/',
    name: 'bk',
  });
  assert.equal(s.destination, '/tmp/ember-vault/bk');
});

void test('done 态可再次 PICK：清旧 result、转 validating', () => {
  const done = run(run(pick(), { type: 'VALIDATE_OK' }), {
    type: 'INSPECT_OK',
    inspect: { path: `${DIR}/old`, version: 1, createdAt: '2026-11-19T00:00:00Z', sourceRoot: DIR, files: 1, bytes: 10 },
  });
  assert.equal(done.status, 'done');
  const s = run(done, { type: 'PICK', dir: '/tmp/other', name: 'ember-b' });
  assert.equal(s.status, 'validating');
  assert.equal(s.selectedDir, '/tmp/other');
  assert.equal(s.result, null);
});

// ─── in-flight 拒绝 ─────────────────────────────────────────────────────────

void test('validating 期间 NAME_CHANGE / GO / PICK / CLOSE 全部被拒', () => {
  const s = pick();
  const a = run(s, { type: 'NAME_CHANGE', name: 'changed' });
  assert.equal(a.status, 'validating');
  assert.equal(a.backupName, DEFAULT_NAME);
  const b = run(s, { type: 'GO' });
  assert.equal(b.status, 'validating');
  const c = run(s, { type: 'PICK', dir: '/tmp/x', name: 'x' });
  assert.equal(c.status, 'validating');
  const d = run(s, { type: 'CLOSE' });
  assert.equal(d.status, 'validating');
});

void test('inspecting 期间 NAME_CHANGE / GO / PICK / CLOSE 全部被拒', () => {
  const s = run(pick(), { type: 'VALIDATE_OK' });
  assert.equal(s.status, 'inspecting');
  const a = run(s, { type: 'NAME_CHANGE', name: 'changed' });
  assert.equal(a.backupName, DEFAULT_NAME);
  assert.equal(run(s, { type: 'GO' }).status, 'inspecting');
  assert.equal(run(s, { type: 'PICK', dir: '/tmp/x', name: 'x' }).status, 'inspecting');
  assert.equal(run(s, { type: 'CLOSE' }).status, 'inspecting');
});

void test('exporting 期间 NAME_CHANGE / GO / PICK / CLOSE 全部被拒', () => {
  const s = run(run(pick(), { type: 'VALIDATE_OK' }), { type: 'INSPECT_NOT_FOUND' });
  assert.equal(s.status, 'exporting');
  const a = run(s, { type: 'NAME_CHANGE', name: 'changed' });
  assert.equal(a.backupName, DEFAULT_NAME);
  assert.equal(run(s, { type: 'GO' }).status, 'exporting');
  assert.equal(run(s, { type: 'PICK', dir: '/tmp/x', name: 'x' }).status, 'exporting');
  assert.equal(run(s, { type: 'CLOSE' }).status, 'exporting');
});

// ─── VALIDATE ───────────────────────────────────────────────────────────────

void test('VALIDATE_OK：validating → inspecting', () => {
  const s = run(pick(), { type: 'VALIDATE_OK' });
  assert.equal(s.status, 'inspecting');
  assert.equal(s.error, null);
});

void test('VALIDATE_ERR：转 error 并保存 code+message+phase', () => {
  const s = run(pick(), { type: 'VALIDATE_ERR', code: 'E_INVALID_ARG', message: 'no such dir' });
  assert.equal(s.status, 'error');
  assert.equal(s.error?.code, 'E_INVALID_ARG');
  assert.equal(s.error?.message, 'no such dir');
  assert.equal(s.error?.phase, 'validate');
});

// ─── INSPECT ────────────────────────────────────────────────────────────────

void test('INSPECT_OK：转 done 并记录 mode inspect 结果', () => {
  const dto = { path: `${DIR}/${DEFAULT_NAME}`, version: 2, createdAt: '2026-11-19T00:00:00Z', sourceRoot: DIR, files: 7, bytes: 1024 };
  const s = run(run(pick(), { type: 'VALIDATE_OK' }), { type: 'INSPECT_OK', inspect: dto });
  assert.equal(s.status, 'done');
  assert.deepEqual(s.result, { mode: 'inspect', inspect: dto });
  assert.equal(s.error, null);
});

void test('INSPECT_NOT_FOUND：inspecting → exporting', () => {
  const s = run(run(pick(), { type: 'VALIDATE_OK' }), { type: 'INSPECT_NOT_FOUND' });
  assert.equal(s.status, 'exporting');
});

void test('INSPECT_ERR（非 NOT_FOUND）：转 error 并保存 code+message+phase', () => {
  const s = run(run(pick(), { type: 'VALIDATE_OK' }), { type: 'INSPECT_ERR', code: 'E_IO', message: 'disk io' });
  assert.equal(s.status, 'error');
  assert.equal(s.error?.code, 'E_IO');
  assert.equal(s.error?.phase, 'inspect');
});

// ─── EXPORT ─────────────────────────────────────────────────────────────────

void test('EXPORT_OK：转 done 并记录 mode export 结果', () => {
  const report = { path: `${DIR}/${DEFAULT_NAME}`, files: 3, bytes: 2048, createdAt: '2026-11-19T00:00:00Z' };
  const s = run(run(run(pick(), { type: 'VALIDATE_OK' }), { type: 'INSPECT_NOT_FOUND' }), {
    type: 'EXPORT_OK',
    report,
  });
  assert.equal(s.status, 'done');
  assert.deepEqual(s.result, { mode: 'export', report });
});

void test('EXPORT_ERR 的 E_INVALID_ARG：转 error，绝不标记成功、不保留 done 结果', () => {
  const s = run(run(run(pick(), { type: 'VALIDATE_OK' }), { type: 'INSPECT_NOT_FOUND' }), {
    type: 'EXPORT_ERR',
    code: 'E_INVALID_ARG',
    message: 'exists',
  });
  assert.equal(s.status, 'error');
  assert.equal(s.result, null);
  assert.equal(s.error?.code, 'E_INVALID_ARG');
  assert.equal(s.error?.phase, 'export');
});

// ─── NAME_CHANGE ────────────────────────────────────────────────────────────

void test('NAME_CHANGE 合法名：idle 无目录时更新 backupName、destination 保持 null', () => {
  const s = run(createBackupPanelState(DEFAULT_NOW), { type: 'NAME_CHANGE', name: 'my-backup_1' });
  assert.equal(s.backupName, 'my-backup_1');
  assert.equal(s.destination, null);
});

void test('NAME_CHANGE 合法名：已选目录时重算 destination、不自动探测（保持原态）', () => {
  const done = run(run(pick(), { type: 'VALIDATE_OK' }), {
    type: 'INSPECT_OK',
    inspect: { path: `${DIR}/${DEFAULT_NAME}`, version: 1, createdAt: '2026-11-19T00:00:00Z', sourceRoot: DIR, files: 1, bytes: 1 },
  });
  const s = run(done, { type: 'NAME_CHANGE', name: 'renamed' });
  assert.equal(s.status, 'done');
  assert.equal(s.backupName, 'renamed');
  assert.equal(s.destination, `${DIR}/renamed`);
});

void test('NAME_CHANGE 非法名（分隔符/双点/保留名/首尾点）：忽略不更新', () => {
  for (const bad of ['a/b', 'a\\b', 'a..b', '..', '.', '.hid', 'hid.', 'con', 'com1', '', 'a b']) {
    const s = run(pick(), { type: 'NAME_CHANGE', name: bad });
    assert.equal(s.backupName, DEFAULT_NAME, `非法名 ${JSON.stringify(bad)} 必须被忽略`);
  }
});

// ─── GO ─────────────────────────────────────────────────────────────────────

void test('GO 未选目录：忽略', () => {
  const s = run(createBackupPanelState(DEFAULT_NOW), { type: 'GO' });
  assert.equal(s.status, 'idle');
});

void test('GO：done 态再次探测 → inspecting 且清旧 result；error 态可重试', () => {
  const dto = { path: `${DIR}/${DEFAULT_NAME}`, version: 1, createdAt: '2026-11-19T00:00:00Z', sourceRoot: DIR, files: 1, bytes: 1 };
  const done = run(run(pick(), { type: 'VALIDATE_OK' }), { type: 'INSPECT_OK', inspect: dto });
  const retry = run(done, { type: 'GO' });
  assert.equal(retry.status, 'inspecting');
  assert.equal(retry.result, null);

  // done 态直收 resolver 动作属杂散，按设计忽略；失败路径必须先 GO 进入 in-flight。
  const stray = run(done, { type: 'INSPECT_ERR', code: 'E_IO', message: 'x' });
  assert.equal(stray.status, 'done');

  const failed = run(run(done, { type: 'GO' }), { type: 'INSPECT_ERR', code: 'E_IO', message: 'x' });
  assert.equal(failed.status, 'error');
  const retried = run(failed, { type: 'GO' });
  assert.equal(retried.status, 'inspecting');
  assert.equal(retried.error, null);
});

// ─── CLOSE ──────────────────────────────────────────────────────────────────

void test('CLOSE：清空三件套/结果/错误，回 idle', () => {
  const dto = { path: `${DIR}/${DEFAULT_NAME}`, version: 1, createdAt: '2026-11-19T00:00:00Z', sourceRoot: DIR, files: 1, bytes: 1 };
  const done = run(run(pick(), { type: 'VALIDATE_OK' }), { type: 'INSPECT_OK', inspect: dto });
  const s = run(done, { type: 'CLOSE' });
  assert.equal(s.status, 'idle');
  assert.equal(s.selectedDir, null);
  assert.equal(s.backupName, '');
  assert.equal(s.destination, null);
  assert.equal(s.result, null);
  assert.equal(s.error, null);
});
