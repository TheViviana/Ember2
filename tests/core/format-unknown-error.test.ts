/**
 * CR-R1-1：13 份散落的 errorMessage / messageOf / errorMessageOf 收敛为
 * core/errors.ts 的 formatUnknownError。
 *
 * a) 表驱动：Error / string / {message} / 42 / null / undefined，
 *    语义固定为 Error→message、string→原样、其它→fallback。
 * b) 源码断言：除 core/errors.ts 外，src 下不得再有
 *    function errorMessage / messageOf / errorMessageOf 定义。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatUnknownError } from '../../src/core/errors.ts';

const SRC_DIR = fileURLToPath(new URL('../../src', import.meta.url));
const LOCAL_FN_RE = /function\s+(errorMessage|messageOf|errorMessageOf)\b/;

void test('formatUnknownError：Error 实例取 message（含空消息与子类）', () => {
  assert.equal(formatUnknownError(new Error('boom')), 'boom');
  assert.equal(formatUnknownError(new TypeError('type boom')), 'type boom');
  assert.equal(formatUnknownError(new Error('')), '');
});

void test('formatUnknownError：字符串原样返回', () => {
  assert.equal(formatUnknownError('hello'), 'hello');
  assert.equal(formatUnknownError(''), '');
  assert.equal(formatUnknownError('  spaced  '), '  spaced  ');
});

void test('formatUnknownError：非 Error / 字符串走 fallback（默认「未知错误」）', () => {
  assert.equal(formatUnknownError(42), '未知错误');
  assert.equal(formatUnknownError(null), '未知错误');
  assert.equal(formatUnknownError(undefined), '未知错误');
  assert.equal(formatUnknownError({ message: 'x' }), '未知错误');
  assert.equal(formatUnknownError([1, 2]), '未知错误');
});

void test('formatUnknownError：显式 fallback 覆盖默认', () => {
  assert.equal(formatUnknownError(42, 'oops'), 'oops');
  assert.equal(formatUnknownError({ message: 'x' }, '自定义兜底'), '自定义兜底');
  assert.equal(formatUnknownError(null, ''), '');
});

function* walkTs(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walkTs(p);
    else if (/\.(ts|tsx)$/.test(name)) yield p;
  }
}

void test('源码断言：core/errors.ts 之外无散落的 errorMessage / messageOf / errorMessageOf 定义', () => {
  const offenders: string[] = [];
  let errorsExportsFormat = false;
  for (const file of walkTs(SRC_DIR)) {
    const rel = relative(SRC_DIR, file).split(sep).join('/');
    const source = readFileSync(file, 'utf8');
    if (rel === 'core/errors.ts') {
      errorsExportsFormat = /export\s+function\s+formatUnknownError\b/.test(source);
      continue;
    }
    if (LOCAL_FN_RE.test(source)) offenders.push(rel);
  }
  assert.equal(
    offenders.length,
    0,
    `仍有散落定义未收敛: ${offenders.join(', ')}`,
  );
  assert.ok(errorsExportsFormat, 'core/errors.ts 必须导出 formatUnknownError');
});
