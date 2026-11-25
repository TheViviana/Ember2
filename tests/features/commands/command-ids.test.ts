/**
 * CR-R6-2：命令 id 类型化与分发表——
 * ids 无重复 / 定义集合与 COMMAND_IDS 一致 / AppShell 分发表键覆盖全部命令。
 * 项目无 JSX 运行时，分发表按源码结构断言（与 source-shape / edge-panel-a11y 同一手法）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COMMAND_IDS } from '../../../src/features/commands/ids.ts';
import { COMMAND_DEFINITIONS } from '../../../src/features/commands/commands.ts';

const sorted = (values: readonly string[]): string[] => [...values].sort();

void test('COMMAND_IDS 无重复', () => {
  assert.equal(new Set(COMMAND_IDS).size, COMMAND_IDS.length);
});

void test('COMMAND_DEFINITIONS 的 id 集合 === COMMAND_IDS', () => {
  assert.deepEqual(sorted(COMMAND_DEFINITIONS.map((def) => def.id)), sorted(COMMAND_IDS));
});

void test('AppShell 分发表键集合 === COMMAND_IDS，且无 default 兜底', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const source = readFileSync(`${root}src/app/shell/AppShell.tsx`, 'utf8');
  const start = source.indexOf('// R6-2:dispatch-table:start');
  const end = source.indexOf('// R6-2:dispatch-table:end');
  assert.ok(start !== -1 && end > start, '存在分发表起止标记');
  const block = source.slice(start, end);
  const keys = [...block.matchAll(/^ {6}'([^']+)':/gm)].map((match) => match[1] ?? '');
  assert.deepEqual(sorted(keys), sorted(COMMAND_IDS));
  assert.doesNotMatch(source, /switch \(def\.id\)/, '旧 switch 已删除');
  assert.doesNotMatch(source, /default:\s*\n\s*break;/, '无 default 兜底');
});
