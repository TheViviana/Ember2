import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createSplitFailureCleanup,
  finishRetryBlock,
} from '../../../src/app/canvas/split-failure-cleanup.ts';

const nodes = [
  { id: 's1', type: 'split' },
  { id: 'b1', type: 'text', sourceNodeId: 's1' },
  { id: 'b2', type: 'text', sourceNodeId: 's2' },
];

function clearFrom(failed: Set<string>): (id: string, value: boolean) => void {
  return (id, value) => {
    if (!value) failed.delete(id);
  };
}

void test('B1：直接执行 committed=true 后清理当前 split，其他 split 不变', () => {
  const failed = new Set(['b1', 'b2']);
  const cleanup = createSplitFailureCleanup();
  cleanup.collect(nodes, 's1');
  cleanup.finish(true, clearFrom(failed));

  assert.equal(failed.has('b1'), false, '旧子块标记被清除');
  assert.equal(failed.has('b2'), true, '其他 split 的标记不受影响');
});

void test('B1：确认重跑 committed=true 后同样清理（与直接路径合流）', () => {
  const failed = new Set(['b1']);
  const cleanup = createSplitFailureCleanup();
  // 第一次运行命中 guard：只收集，不 finish，标记保留。
  cleanup.collect(nodes, 's1');
  assert.equal(failed.has('b1'), true);

  // 确认后第二次运行真正提交，走同一个 finish。
  cleanup.collect(nodes, 's1');
  cleanup.finish(true, clearFrom(failed));
  assert.equal(failed.has('b1'), false);
});

void test('B1：start 未提交（committed=false）时保留标记并丢弃计划', () => {
  const failed = new Set(['b1']);
  const cleanup = createSplitFailureCleanup();
  cleanup.collect(nodes, 's1');
  cleanup.finish(false, clearFrom(failed));
  assert.equal(failed.has('b1'), true, '失败/取消不清理');

  // 计划已丢弃，后续即使误调 finish(true) 也不得清。
  let calls = 0;
  cleanup.finish(true, () => {
    calls += 1;
  });
  assert.equal(calls, 0);
  assert.equal(failed.has('b1'), true);
});

void test('B1：取消确认只丢弃计划，失败标记保留', () => {
  const failed = new Set(['b1']);
  const cleanup = createSplitFailureCleanup();
  cleanup.collect(nodes, 's1');
  cleanup.discard();

  assert.equal(failed.has('b1'), true);
  let calls = 0;
  cleanup.finish(true, () => {
    calls += 1;
  });
  assert.equal(calls, 0);
  assert.equal(failed.has('b1'), true);
});

void test('B1：retryBlock 未提交时保留标记，可再次重试成功后清除', () => {
  const failed = new Set(['b1']);
  finishRetryBlock(false, 'b1', clearFrom(failed));
  assert.equal(failed.has('b1'), true, '失败/取消后标记仍在，可再次重试');

  finishRetryBlock(true, 'b1', clearFrom(failed));
  assert.equal(failed.has('b1'), false, '写回成功后清除');
});