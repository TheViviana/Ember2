/**
 * CR-20261123-69 / S3：标签 → 八维规则。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDimensionRule,
  loadDimensionRules,
  matchDimensionRules,
  removeDimensionRule,
  rulesStorageKey,
  saveDimensionRules,
  type BoardDimensionRule,
  type RulesStorage,
} from '../../../src/features/board/rules-store.ts';

function memoryStorage(initial: Record<string, string> = {}): RulesStorage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

void test('规则保存 → 读取往返，按库隔离', () => {
  const storage = memoryStorage();
  const rules: readonly BoardDimensionRule[] = [
    { pattern: '方法/*', dimension: 'procedural' },
    { pattern: '原则', dimension: 'value' },
  ];
  assert.equal(saveDimensionRules(storage, 'v1', rules), null);

  const loaded = loadDimensionRules(storage, 'v1');
  assert.equal(loaded.warning, null);
  assert.deepEqual(loaded.rules, rules);
  assert.deepEqual(loadDimensionRules(storage, 'v2').rules, []);
  assert.ok(rulesStorageKey('v1').endsWith(':v1'));
});

void test('新增去重（忽略大小写与首尾空白），空模式拒绝', () => {
  const rules = addDimensionRule([], ' 方法/* ', 'procedural');
  assert.deepEqual(rules, [{ pattern: '方法/*', dimension: 'procedural' }]);

  const same = addDimensionRule(rules, '方法/*', 'procedural');
  assert.equal(same, rules);

  const anotherDimension = addDimensionRule(rules, '方法/*', 'factual');
  assert.equal(anotherDimension.length, 2);

  const empty = addDimensionRule(rules, '   ', 'factual');
  assert.equal(empty, rules);
});

void test('删除按下标', () => {
  const rules: readonly BoardDimensionRule[] = [
    { pattern: 'a', dimension: 'factual' },
    { pattern: 'b', dimension: 'tacit' },
  ];
  assert.deepEqual(removeDimensionRule(rules, 0), [{ pattern: 'b', dimension: 'tacit' }]);
  assert.equal(removeDimensionRule(rules, 9), rules);
});

void test('通配匹配、去重并按八维固定顺序输出', () => {
  const rules: readonly BoardDimensionRule[] = [
    { pattern: '方法/*', dimension: 'procedural' },
    { pattern: '价值*', dimension: 'value' },
    { pattern: '*', dimension: 'factual' },
    { pattern: '方法/写作', dimension: 'procedural' },
  ];
  assert.deepEqual(matchDimensionRules(['方法/写作'], rules), ['factual', 'procedural']);

  const caseInsensitive = addDimensionRule([], 'Method/*', 'metacognitive');
  assert.deepEqual(matchDimensionRules(['method/retro'], caseInsensitive), ['metacognitive']);

  assert.deepEqual(matchDimensionRules(['未命中'], [rules[0] as BoardDimensionRule]), []);
  assert.deepEqual(matchDimensionRules([], rules), []);
});

void test('损坏 / 版本不符 / 无效条目的降级', () => {
  assert.deepEqual(loadDimensionRules(memoryStorage(), 'v').rules, []);

  const broken = memoryStorage({ [rulesStorageKey('v')]: '{oops' });
  assert.match(loadDimensionRules(broken, 'v').warning ?? '', /无法解析/);

  const wrongVersion = memoryStorage({
    [rulesStorageKey('v')]: JSON.stringify({ version: 2, rules: [] }),
  });
  assert.match(loadDimensionRules(wrongVersion, 'v').warning ?? '', /格式无效/);

  const mixed = memoryStorage({
    [rulesStorageKey('v')]: JSON.stringify({
      version: 1,
      rules: [
        { pattern: 'ok', dimension: 'factual' },
        { pattern: 'ok', dimension: 'factual' },
        { pattern: '', dimension: 'factual' },
        { pattern: 'x', dimension: 'not-a-dimension' },
      ],
    }),
  });
  const loaded = loadDimensionRules(mixed, 'v');
  assert.deepEqual(loaded.rules, [{ pattern: 'ok', dimension: 'factual' }]);
  assert.match(loaded.warning ?? '', /2 条无效记录/);
});

void test('写入失败返回提示', () => {
  const failing: RulesStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error('quota');
    },
  };
  assert.match(saveDimensionRules(failing, 'v', []) ?? '', /保存失败/);
});
