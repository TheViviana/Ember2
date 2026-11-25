/**
 * CR-R1-5：Windows 保留名下沉 core 后的表驱动回归 + 定义唯一性。
 *
 * 期望值取自改动前 validateBackupName 的逐条快照（不变量：行为零变化）；
 * COM10 在改动前即为 true（清单仅 COM1-9），本表按快照断言，不改测试凑「前 9 条全拦截」。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isReservedDeviceName, WINDOWS_RESERVED_NAMES } from '../../src/core/reserved-names.ts';
import { validateBackupName } from '../../src/features/backup/backup-flow.ts';

const SRC_ROOT = fileURLToPath(new URL('../../src', import.meta.url));

/** [输入, isReservedDeviceName, validateBackupName] */
const CASES: readonly (readonly [string, boolean, boolean])[] = [
  ['CON', true, false],
  ['con', true, false],
  ['CON.txt', true, false],
  ['COM1.log', true, false],
  ['COM10', false, true],
  ['LPT9', true, false],
  ['NUL', true, false],
  ['PRN', true, false],
  ['AUX', true, false],
  ['a b', false, false],
  ['.x', false, false],
  ['x.', false, false],
  ['..', false, false],
  ['', false, false],
  ['console', false, true],
  ['CONSOLE', false, true],
];

void test('WINDOWS_RESERVED_NAMES：22 项且与备份名原清单逐项一致', () => {
  assert.equal(WINDOWS_RESERVED_NAMES.length, 22);
  assert.equal(
    WINDOWS_RESERVED_NAMES.join(','),
    'CON,PRN,AUX,NUL,COM1,COM2,COM3,COM4,COM5,COM6,COM7,COM8,COM9,LPT1,LPT2,LPT3,LPT4,LPT5,LPT6,LPT7,LPT8,LPT9',
  );
});

void test('表驱动 16 条：isReservedDeviceName 与 validateBackupName 行为对齐快照', () => {
  for (const [input, reserved, valid] of CASES) {
    assert.equal(isReservedDeviceName(input), reserved, `isReservedDeviceName(${JSON.stringify(input)})`);
    assert.equal(validateBackupName(input), valid, `validateBackupName(${JSON.stringify(input)})`);
  }
});

void test('console / CONSOLE 放行（stem 非全等不算保留名）', () => {
  assert.equal(isReservedDeviceName('console'), false);
  assert.equal(isReservedDeviceName('CONSOLE'), false);
  assert.equal(validateBackupName('console'), true);
  assert.equal(validateBackupName('CONSOLE'), true);
});

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...listSourceFiles(path));
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      out.push(path);
    }
  }
  return out;
}

void test('源码断言：src 下只有 core/reserved-names.ts 定义 WINDOWS_RESERVED_NAMES', () => {
  const definition = /\b(?:const|let|var)\s+WINDOWS_RESERVED_NAMES\b/;
  const defining = listSourceFiles(SRC_ROOT)
    .filter((path) => definition.test(readFileSync(path, 'utf8')))
    .map((path) => path.slice(SRC_ROOT.length + 1).split('\\').join('/'));
  assert.deepEqual(defining, ['core/reserved-names.ts']);
});
