/**
 * C0-B B4：统一可逆历史（move 与非 move 共用 past/future）与 R8 写锁。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CanvasInteractionController,
  CANVAS_HISTORY_LIMIT,
} from '../../../src/app/canvas/document-controller.ts';
import type { CanvasDocument } from '../../../src/app/canvas/format.ts';
import type { CanvasSchemaIssue } from '#canvas-format';

function document(): CanvasDocument {
  return {
    schemaVersion: 2,
    nodes: [
      { id: 'a', label: 'A', x: 0, y: 0 },
      { id: 'b', label: 'B', x: 100, y: 0 },
    ],
    edges: [
      { id: 'e1', from: { nodeId: 'a', portId: 'out' }, to: { nodeId: 'b', portId: 'in' } },
      { id: 'e2', from: { nodeId: 'b', portId: 'out' }, to: { nodeId: 'a', portId: 'in' } },
    ],
  };
}

function controller(
  options: {
    readonly document?: CanvasDocument;
    readonly readOnly?: boolean;
    readonly issues?: readonly CanvasSchemaIssue[];
  } = {},
): {
  controller: CanvasInteractionController;
  failures: { readonly commandIndex: number; readonly code: string; readonly message: string }[];
} {
  const failures: { commandIndex: number; code: string; message: string }[] = [];
  return {
    failures,
    controller: new CanvasInteractionController({
      canvasId: 'b4',
      document: options.document ?? document(),
      readOnly: options.readOnly,
      issues: options.issues,
      store: {
        save: () => Promise.resolve({}),
        open: () => Promise.resolve({ exists: true, text: null, sha256: 'sha', modifiedMs: null }),
      },
      applyPositions: () => undefined,
      onConflict: () => undefined,
      onCommandError: (error) => failures.push(error),
      schedule: () => 1,
      cancelSchedule: () => undefined,
    }),
  };
}

void test('addNode 入统一历史，undo/redo 走同一 mutate 路径', () => {
  const { controller: instance } = controller();
  assert.equal(instance.execute([{ kind: 'addNode', node: { id: 'c', x: 10, y: 20 } }]), true);
  assert.equal(instance.getDocument().nodes.length, 3);
  assert.equal(instance.getHistory().past.length, 1);
  assert.deepEqual(instance.getHistory().past[0]?.entries, []);
  assert.equal(instance.getHistory().past[0]?.kind, 'addNode');

  assert.equal(instance.undo(), true);
  assert.equal(instance.getDocument().nodes.length, 2);
  assert.equal(instance.redo(), true);
  assert.equal(instance.getDocument().nodes.length, 3);
});

void test('removeNode 级联边随批 inverse 完整恢复（原顺序）', () => {
  const { controller: instance } = controller();
  assert.equal(instance.execute([{ kind: 'removeNode', id: 'a' }]), true);
  const removed = instance.getDocument();
  assert.deepEqual(removed.nodes.map((node) => (node as { id: string }).id), ['b']);
  assert.deepEqual(removed.edges, []);

  assert.equal(instance.undo(), true);
  const restored = instance.getDocument();
  assert.deepEqual(restored.nodes.map((node) => (node as { id: string }).id), ['a', 'b']);
  assert.deepEqual(restored.edges, document().edges);
});

void test('updateNode 区分字段原缺失与原空串，undo 精确还原', () => {
  const { controller: instance } = controller();
  // label 原为空串：改回原值必须仍是空串，而非删除字段。
  assert.equal(instance.execute([{ kind: 'updateNode', id: 'a', changes: { label: '' } }]), true);
  const [first] = instance.getDocument().nodes;
  assert.equal((first as { label: string }).label, '');
  instance.undo();
  assert.equal((instance.getDocument().nodes[0] as { label: string }).label, 'A');

  // label 原缺失：undo 必须删除字段而不是写回空串/null。
  const missingLabel: CanvasDocument = {
    schemaVersion: 2,
    nodes: [{ id: 'a', x: 0, y: 0 }],
    edges: [],
  };
  const { controller: withoutLabel } = controller({ document: missingLabel });
  assert.equal(
    withoutLabel.execute([{ kind: 'updateNode', id: 'a', changes: { label: 'A2' } }]),
    true,
  );
  withoutLabel.undo();
  const restored = withoutLabel.getDocument().nodes[0] as Record<string, unknown>;
  assert.equal(Object.prototype.hasOwnProperty.call(restored, 'label'), false);
});

void test('addEdge/removeEdge 可逆；整批命令 undo 逆序、redo 原序', () => {
  const { controller: instance } = controller();
  assert.equal(
    instance.execute([
      { kind: 'addNode', node: { id: 'c', x: 200, y: 0 } },
      { kind: 'addEdge', edge: { id: 'e3', from: { nodeId: 'b' }, to: { nodeId: 'c' } } },
    ]),
    true,
  );
  assert.equal(instance.getDocument().nodes.length, 3);
  assert.equal(instance.getDocument().edges.length, 3);
  assert.equal(instance.getHistory().past.length, 1);

  assert.equal(instance.undo(), true, '整批 undo 必须一次完成');
  assert.equal(instance.getDocument().nodes.length, 2);
  assert.equal(instance.getDocument().edges.length, 2);

  assert.equal(instance.redo(), true);
  assert.equal(instance.getDocument().nodes.length, 3);
  assert.equal(instance.getDocument().edges.length, 3);
});

void test('CR-20261119-11 A8：move+updateNode 同批 execute = 一条 history + 一次 ⌘Z 同时还原', () => {
  const { controller: instance } = controller();
  assert.equal(
    instance.execute([
      { kind: 'move', entries: [{ id: 'a', dx: 30, dy: -10 }] },
      { kind: 'updateNode', id: 'a', changes: { w: 200, h: 160 } },
    ]),
    true,
  );
  assert.equal(instance.getHistory().past.length, 1);
  const node = instance.getDocument().nodes[0] as Record<string, unknown>;
  assert.equal(node.x, 30);
  assert.equal(node.y, -10);
  assert.equal(node.w, 200);
  assert.equal(node.h, 160);

  assert.equal(instance.undo(), true);
  // 一次 undo 同时还原 move + updateNode（整批 inverse 逆序执行）
  const restored = instance.getDocument().nodes[0] as Record<string, unknown>;
  assert.equal(restored.x, 0);
  assert.equal(restored.y, 0);
  assert.equal('w' in restored, false);
  assert.equal('h' in restored, false);

  assert.equal(instance.redo(), true);
  assert.equal(instance.getHistory().future.length, 0);  // 一次 redo 清 future
});

void test('move 仍写统一历史并保留 entries 形状', () => {
  const { controller: instance } = controller();
  assert.equal(
    instance.commit({ kind: 'move', entries: [{ id: 'a', dx: 5, dy: -3 }] }),
    true,
  );
  const entry = instance.getHistory().past[0];
  assert.equal(entry?.kind, 'move');
  assert.deepEqual(entry?.entries, [{ id: 'a', dx: 5, dy: -3 }]);

  assert.equal(instance.undo(), true);
  assert.deepEqual(
    { x: (instance.getDocument().nodes[0] as { x: number }).x, y: (instance.getDocument().nodes[0] as { y: number }).y },
    { x: 0, y: 0 },
  );
  assert.equal(instance.redo(), true);
  assert.deepEqual(
    { x: (instance.getDocument().nodes[0] as { x: number }).x, y: (instance.getDocument().nodes[0] as { y: number }).y },
    { x: 5, y: -3 },
  );
});

void test('命令失败：整批不应用、history 不推进、错误回调逐项', () => {
  const { controller: instance, failures } = controller();
  const before = instance.getDocument();
  assert.equal(
    instance.execute([
      { kind: 'addNode', node: { id: 'c', x: 10, y: 10 } },
      { kind: 'removeNode', id: 'missing' },
    ]),
    false,
  );
  assert.equal(instance.getDocument(), before);
  assert.equal(instance.getHistory().past.length, 0);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.code, 'E_MUTATE_TARGET');
  assert.equal(failures[0]?.commandIndex, 1);
});

void test('R8：构造时带 issues 即整幅只读，execute/commit 一律拒绝', () => {
  const { controller: instance } = controller({
    readOnly: true,
    issues: [{ code: 'E_SCHEMA_FIELD', path: '/nodes/0/x', message: 'x 非法' }],
  });
  assert.equal(instance.isReadOnly(), true);
  assert.equal(instance.getIssues().length, 1);
  assert.equal(instance.execute([{ kind: 'addNode', node: { id: 'c', x: 1, y: 1 } }]), false);
  assert.equal(instance.commit({ kind: 'move', entries: [{ id: 'a', dx: 1, dy: 1 }] }), false);
  assert.equal(instance.getHistory().past.length, 0);
});

void test(`历史上限 ${CANVAS_HISTORY_LIMIT}：超出丢最旧`, () => {
  const { controller: instance } = controller();
  for (let index = 0; index <= CANVAS_HISTORY_LIMIT; index += 1) {
    assert.equal(
      instance.execute([{ kind: 'addNode', node: { id: `n${index}`, x: index, y: 0 } }]),
      true,
    );
  }
  const past = instance.getHistory().past;
  assert.equal(past.length, CANVAS_HISTORY_LIMIT);
  assert.equal(past.at(-1)?.kind, 'addNode');
});
