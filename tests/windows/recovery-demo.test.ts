/**
 * P5-C5：恢复检测演示状态机测试（纯逻辑，无 DOM / 无 I/O）。
 *
 * 固定三件事：
 * 1. 判定是合取：崩溃标志 ∧ 末版 ≠ 磁盘；
 * 2. 单边差异不进入恢复候选，但要在 excluded 中可见；
 * 3. seed 是完整场景注入：同侧重复 docId 一律拒绝，不替调用方去重。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRecoveryDemo, type DemoSeed } from '../../src/windows/recovery-demo.ts';

const DIRTY: DemoSeed = {
  crashFlag: true,
  latest: [
    { docId: 'b.md', token: 'v2' },
    { docId: 'a.md', token: 'v2' },
  ],
  onDisk: [
    { docId: 'a.md', hash: 'v1' },
    { docId: 'b.md', hash: 'v1' },
  ],
};

void test('崩溃标志 + 末版差异：列出按 docId 排序的恢复候选', () => {
  const demo = createRecoveryDemo();
  assert.equal(demo.seed(DIRTY).ok, true);
  assert.equal(demo.scan().ok, true);

  const snapshot = demo.snapshot();
  assert.equal(snapshot.scanReason, 'crashed');
  assert.deepEqual(
    snapshot.candidates.map((candidate) => candidate.docId),
    ['a.md', 'b.md'],
  );
  assert.deepEqual(
    snapshot.candidates.map((candidate) => candidate.latestToken),
    ['v2', 'v2'],
  );
  assert.deepEqual(
    snapshot.candidates.map((candidate) => candidate.diskHash),
    ['v1', 'v1'],
  );
  assert.deepEqual(
    snapshot.candidates.map((candidate) => candidate.decision),
    [null, null],
  );
  assert.deepEqual(snapshot.excluded, []);
});

void test('崩溃标志 + 末版与磁盘一致：无候选', () => {
  const demo = createRecoveryDemo();
  demo.seed({
    crashFlag: true,
    latest: [{ docId: 'a.md', token: 'v2' }],
    onDisk: [{ docId: 'a.md', hash: 'v2' }],
  });
  demo.scan();

  const snapshot = demo.snapshot();
  assert.equal(snapshot.scanReason, 'no-diff');
  assert.deepEqual(snapshot.candidates, []);
  assert.deepEqual(snapshot.excluded, []);
});

void test('无崩溃标志：即使存在差异也不触发（合取）', () => {
  const demo = createRecoveryDemo();
  demo.seed({
    crashFlag: false,
    latest: [{ docId: 'a.md', token: 'v2' }],
    onDisk: [{ docId: 'a.md', hash: 'v1' }],
  });
  demo.scan();

  const snapshot = demo.snapshot();
  assert.equal(snapshot.scanReason, 'no-crash');
  assert.deepEqual(snapshot.candidates, []);
  assert.deepEqual(snapshot.excluded, []);
});

void test('仅末版存在（磁盘缺失）：排除并标注 missing-on-disk', () => {
  const demo = createRecoveryDemo();
  demo.seed({
    crashFlag: true,
    latest: [{ docId: 'a.md', token: 'v2' }],
    onDisk: [],
  });
  demo.scan();

  const snapshot = demo.snapshot();
  assert.deepEqual(snapshot.candidates, []);
  assert.deepEqual(snapshot.excluded, [
    { docId: 'a.md', reason: 'missing-on-disk' },
  ]);
  assert.equal(snapshot.scanReason, 'no-diff');
});

void test('仅磁盘存在（无会话末版）：排除并标注 no-latest-version', () => {
  const demo = createRecoveryDemo();
  demo.seed({
    crashFlag: true,
    latest: [],
    onDisk: [{ docId: 'a.md', hash: 'v1' }],
  });
  demo.scan();

  const snapshot = demo.snapshot();
  assert.deepEqual(snapshot.candidates, []);
  assert.deepEqual(snapshot.excluded, [
    { docId: 'a.md', reason: 'no-latest-version' },
  ]);
});

void test('latest 内重复 docId：seed 拒绝，完整快照不变且不通知订阅者', () => {
  const demo = createRecoveryDemo();
  const before = demo.snapshot();
  let notifications = 0;
  demo.subscribe(() => {
    notifications += 1;
  });

  const result = demo.seed({
    crashFlag: true,
    latest: [
      { docId: 'a.md', token: 'v1' },
      { docId: 'a.md', token: 'v2' },
    ],
    onDisk: [],
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'duplicate-doc-id');
  assert.deepEqual(demo.snapshot(), before);
  assert.equal(notifications, 0);
});

void test('onDisk 内重复 docId：seed 拒绝，完整快照不变', () => {
  const demo = createRecoveryDemo();
  const before = demo.snapshot();

  const result = demo.seed({
    crashFlag: true,
    latest: [],
    onDisk: [
      { docId: 'a.md', hash: 'v1' },
      { docId: 'a.md', hash: 'v2' },
    ],
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'duplicate-doc-id');
  assert.deepEqual(demo.snapshot(), before);
});

void test('未决候选期间的非法 seed：校验错误优先，完整快照不变', () => {
  const demo = createRecoveryDemo();
  demo.seed(DIRTY);
  demo.scan();
  const before = demo.snapshot();
  let notifications = 0;
  demo.subscribe(() => {
    notifications += 1;
  });

  const result = demo.seed({
    crashFlag: true,
    latest: [
      { docId: 'a.md', token: 'v1' },
      { docId: 'a.md', token: 'v2' },
    ],
    onDisk: [],
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'duplicate-doc-id');
  assert.deepEqual(demo.snapshot(), before);
  assert.equal(notifications, 0);
});

void test('跨两侧同名 docId 是正常配对，不判重复', () => {
  const demo = createRecoveryDemo();
  const result = demo.seed({
    crashFlag: true,
    latest: [{ docId: 'a.md', token: 'v2' }],
    onDisk: [{ docId: 'a.md', hash: 'v1' }],
  });

  assert.equal(result.ok, true);
  demo.scan();
  assert.equal(demo.snapshot().candidates.length, 1);
});

void test('空 docId / 空 token：seed 拒绝', () => {
  const demo = createRecoveryDemo();

  const emptyId = demo.seed({
    crashFlag: true,
    latest: [{ docId: '   ', token: 'v1' }],
    onDisk: [],
  });
  assert.equal(emptyId.ok, false);
  if (!emptyId.ok) assert.equal(emptyId.code, 'invalid-doc-id');

  const emptyToken = demo.seed({
    crashFlag: true,
    latest: [{ docId: 'a.md', token: ' ' }],
    onDisk: [],
  });
  assert.equal(emptyToken.ok, false);
  if (!emptyToken.ok) assert.equal(emptyToken.code, 'invalid-token');
});

void test('未注入场景就扫描：拒绝', () => {
  const demo = createRecoveryDemo();
  const result = demo.scan();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'not-seeded');
});

void test('同一场景重复扫描：拒绝', () => {
  const demo = createRecoveryDemo();
  demo.seed(DIRTY);
  demo.scan();

  const again = demo.scan();
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.code, 'already-scanned');
});

void test('决定未知 docId：拒绝且不改动已有候选', () => {
  const demo = createRecoveryDemo();
  demo.seed(DIRTY);
  demo.scan();

  const result = demo.decide('missing.md', 'restore');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'unknown-doc-id');
  assert.deepEqual(
    demo.snapshot().candidates.map((candidate) => candidate.decision),
    [null, null],
  );
});

void test('重复决定同一 docId：拒绝且保留首次决定', () => {
  const demo = createRecoveryDemo();
  demo.seed(DIRTY);
  demo.scan();
  assert.equal(demo.decide('a.md', 'restore').ok, true);

  const again = demo.decide('a.md', 'discard');
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.code, 'already-decided');

  const target = demo.snapshot().candidates.find((candidate) => candidate.docId === 'a.md');
  assert.equal(target?.decision, 'restore');
  assert.equal(target?.latestToken, 'v2');
  assert.equal(target?.diskHash, 'v1');
});

void test('全部候选决定后进入 resolved', () => {
  const demo = createRecoveryDemo();
  demo.seed(DIRTY);
  demo.scan();
  demo.decide('a.md', 'restore');
  demo.decide('b.md', 'discard');

  const snapshot = demo.snapshot();
  assert.equal(snapshot.phase, 'resolved');
  assert.deepEqual(
    snapshot.candidates.map((candidate) => candidate.decision),
    ['restore', 'discard'],
  );
});

void test('未决候选存在时重新注入：拒绝；resolved 后可重新注入', () => {
  const demo = createRecoveryDemo();
  demo.seed(DIRTY);
  demo.scan();

  const blocked = demo.seed(DIRTY);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.code, 'unresolved-candidates');

  demo.decide('a.md', 'restore');
  demo.decide('b.md', 'discard');
  assert.equal(demo.seed(DIRTY).ok, true);
  assert.equal(demo.snapshot().phase, 'seeded');
});

void test('reset 清空标志、候选与消息', () => {
  const demo = createRecoveryDemo();
  demo.seed(DIRTY);
  demo.scan();
  demo.decide('a.md', 'restore');

  assert.equal(demo.reset().ok, true);
  const snapshot = demo.snapshot();
  assert.equal(snapshot.phase, 'idle');
  assert.equal(snapshot.crashFlag, false);
  assert.deepEqual(snapshot.candidates, []);
  assert.deepEqual(snapshot.excluded, []);
  assert.equal(snapshot.scanReason, null);
  assert.equal(snapshot.message, null);
});

void test('订阅在状态变化时通知，退订后停止', () => {
  const demo = createRecoveryDemo();
  let notifications = 0;
  const unsubscribe = demo.subscribe(() => {
    notifications += 1;
  });

  demo.seed(DIRTY);
  demo.scan();
  unsubscribe();
  demo.reset();

  assert.equal(notifications, 2);
});
