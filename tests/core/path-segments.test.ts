/**
 * CR-R2-1：路径段合法性下沉 core 后的表驱动回归 + 与旧 `.some(...)` 行为等价。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { illegalSegment } from '../../src/core/path-segments.ts';

/** 迁移前的段检查基准：`path.split('/').some(s => s === '' || s === '.' || s === '..')`。 */
function legacyHasIllegalSegment(path: string): boolean {
  return path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

/** [输入, illegalSegment 返回值] */
const CASES: readonly (readonly [string, 'empty' | 'dot' | 'dotdot' | null])[] = [
  ['a/b', null],
  ['a//b', 'empty'],
  ['./a', 'dot'],
  ['a/../b', 'dotdot'],
  ['a..b', null],
  ['', 'empty'],
];

void test('表驱动 6 条：illegalSegment 返回首个非法段类别或 null', () => {
  for (const [input, expected] of CASES) {
    assert.equal(
      illegalSegment(input),
      expected,
      `illegalSegment(${JSON.stringify(input)})`,
    );
  }
});

void test('行为等价：illegalSegment !== null 与旧 some 判定逐条一致', () => {
  const probes = [
    '', 'a', 'a/b', '/a', 'a/', 'a//b', './a', 'a/.', 'a/..', 'a/../b',
    '..', '../a', 'a..b', 'a.b', 'a\\b', 'media/image/x.png', 'a//..//b',
  ];
  for (const path of probes) {
    assert.equal(
      illegalSegment(path) !== null,
      legacyHasIllegalSegment(path),
      `diverged on ${JSON.stringify(path)}`,
    );
  }
});

void test('反斜杠不被当分隔符：macOS 合法文件名字符', () => {
  assert.equal(illegalSegment('a\\b'), null);
  assert.equal(illegalSegment('dir\\..\\x'), null);
});
