import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  collectMergeConfig,
  countMergeInputs,
} from '../../../src/app/canvas/split-node-execution.ts';

const nodes = [
  { id: 'm1', type: 'merge' },
  { id: 'b1', type: 'text', label: 'A' },
  { id: 'b2', type: 'text', label: 'B' },
];

function edge(from: string, to: string) {
  return { from: { nodeId: from }, to: { nodeId: to } };
}

void test('S1：merge 重复入边按来源节点去重，保留首次顺序', () => {
  const collected = collectMergeConfig(
    nodes,
    [edge('b1', 'm1'), edge('b2', 'm1'), edge('b1', 'm1')],
    'm1',
  );
  assert.deepEqual(
    collected.inputs.map((input) => input.nodeId),
    ['b1', 'b2'],
  );
});

void test('S1：重复入边不改变其他 merge 配置', () => {
  const collected = collectMergeConfig(
    [...nodes, { id: 'o1', type: 'text', label: '' }],
    [edge('m1', 'o1'), edge('b1', 'm1'), edge('b1', 'm1')],
    'm1',
  );
  assert.equal(collected.outputNodeId, 'o1');
  assert.equal(collected.inputs.length, 1);
});

void test('S1：卡片计数复用 collectMergeConfig 去重结果', () => {
  const edges = [edge('b1', 'm1'), edge('b2', 'm1'), edge('b1', 'm1')];
  assert.equal(countMergeInputs(nodes, edges, 'm1'), 2);
  assert.equal(
    countMergeInputs(nodes, edges, 'm1'),
    collectMergeConfig(nodes, edges, 'm1').inputs.length,
  );
});

void test('S1：非 text 上游不计数', () => {
  const withDoc = [...nodes, { id: 'd1', type: 'document', docPath: 'a.md', label: 'A' }];
  const edges = [edge('b1', 'm1'), edge('d1', 'm1')];
  assert.equal(countMergeInputs(withDoc, edges, 'm1'), 1);
});