import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createDuplicateNodeCommands,
} from '../../../src/app/canvas/canvas-interactions.ts';
import {
  CanvasInteractionController,
} from '../../../src/app/canvas/document-controller.ts';
import {
  createInteractionState,
  reduceInteraction,
} from '../../../src/app/canvas/interaction.ts';
import type { InteractionState } from '../../../src/app/canvas/interaction.ts';
import {
  createEmptyCanvasDocument,
  type CanvasDocument,
} from '../../../src/app/canvas/format.ts';

function documentWith(node: Readonly<Record<string, unknown>>): CanvasDocument {
  return { ...createEmptyCanvasDocument(), nodes: [node] };
}

function controllerFor(document: CanvasDocument, readOnly = false): CanvasInteractionController {
  return new CanvasInteractionController({
    canvasId: 'c1b',
    document,
    readOnly,
    store: {
      save: () => Promise.resolve({}),
      open: () => Promise.resolve({ exists: true, text: null, sha256: 'sha', modifiedMs: null }),
    },
    applyPositions: () => undefined,
    onConflict: () => undefined,
    schedule: () => 1,
    cancelSchedule: () => undefined,
  });
}

void test('⌥复制：新 id、字段保留、不补 schema 默认值', () => {
  const document = documentWith({
    id: 'a',
    label: 'A',
    x: 0,
    y: 0,
    type: 'document',
    docPath: 'notes/a.md',
    custom: { kept: true },
  });
  const commands = createDuplicateNodeCommands([{ id: 'a', x: 40, y: 10 }], document.nodes);
  assert.equal(commands.length, 1);

  const command = commands[0];
  assert.equal(command?.kind, 'addNode');
  if (command?.kind === 'addNode') {
    assert.notEqual(command.node.id, 'a');
    assert.match(command.node.id, /^n_/);
    assert.equal(command.node.x, 40);
    assert.equal(command.node.y, 10);
    assert.equal(command.node.label, 'A');
    assert.equal(command.node.type, 'document');
    assert.equal(command.node.docPath, 'notes/a.md');
    assert.deepEqual(command.node['custom'], { kept: true });
    // 源节点没有 ports，副本也不补默认端口。
    assert.equal(command.node.ports, undefined);
  }
});

void test('⌥复制：源节点不存在时跳过，不伪造空节点', () => {
  const document = documentWith({ id: 'a', label: 'A', x: 0, y: 0 });
  const commands = createDuplicateNodeCommands([{ id: 'missing', x: 1, y: 1 }], document.nodes);
  assert.equal(commands.length, 0);
});

void test('⌥复制：多选时每个节点生成一条 addNode', () => {
  const document: CanvasDocument = {
    ...createEmptyCanvasDocument(),
    nodes: [
      { id: 'a', label: 'A', x: 0, y: 0 },
      { id: 'b', label: 'B', x: 100, y: 0 },
    ],
  };
  const commands = createDuplicateNodeCommands(
    [
      { id: 'a', x: 10, y: 10 },
      { id: 'b', x: 110, y: 10 },
    ],
    document.nodes,
  );
  assert.equal(commands.length, 2);
});

void test('⌥复制进统一历史，可 undo / redo', () => {
  const document = documentWith({ id: 'a', label: 'A', x: 0, y: 0, type: 'document', docPath: 'a.md' });
  const controller = controllerFor(document);
  const commands = createDuplicateNodeCommands([{ id: 'a', x: 40, y: 10 }], document.nodes);

  assert.equal(controller.execute(commands), true);
  assert.equal(controller.getDocument().nodes.length, 2);
  assert.equal(controller.getHistory().past.length, 1);

  assert.equal(controller.undo(), true);
  assert.equal(controller.getDocument().nodes.length, 1);
  assert.deepEqual(controller.getDocument().nodes[0], {
    id: 'a',
    label: 'A',
    x: 0,
    y: 0,
    type: 'document',
    docPath: 'a.md',
  });

  assert.equal(controller.redo(), true);
  assert.equal(controller.getDocument().nodes.length, 2);
});

void test('R8 只读态下 ⌥复制命令被拒', () => {
  const document = documentWith({ id: 'a', label: 'A', x: 0, y: 0 });
  const controller = controllerFor(document, true);
  const commands = createDuplicateNodeCommands([{ id: 'a', x: 40, y: 10 }], document.nodes);

  assert.equal(controller.execute(commands), false);
  assert.equal(controller.getDocument().nodes.length, 1);
  assert.equal(controller.getHistory().past.length, 0);
});

function downAt(state: InteractionState, altKey: boolean, readOnly = false) {
  return reduceInteraction(state, {
    type: 'pointerDown',
    point: { x: 10, y: 10 },
    button: 0,
    shiftKey: false,
    toggleKey: false,
    altKey,
    pan: false,
    target: { kind: 'node', id: 'a' },
    nodes: [{ id: 'a', label: 'A', x: 0, y: 0 }],
    readOnly,
  });
}

void test('⌥拖动产生 duplicate 效果并复位原节点', () => {
  const start = downAt(createInteractionState(), true);
  assert.equal(start.state.gesture?.kind, 'node');

  const moved = reduceInteraction(start.state, {
    type: 'pointerMove',
    point: { x: 50, y: 10 },
    scale: 1,
  });
  const up = reduceInteraction(moved.state, {
    type: 'pointerUp',
    point: { x: 50, y: 10 },
    scale: 1,
  });

  const duplicate = up.effects.find((effect) => effect.type === 'duplicate');
  assert.ok(duplicate !== undefined);
  if (duplicate.type === 'duplicate') {
    assert.deepEqual(duplicate.entries, [{ id: 'a', x: 40, y: 0 }]);
  }
  // 原节点先复位，再生成副本。
  const preview = up.effects.find((effect) => effect.type === 'preview');
  assert.ok(preview !== undefined);
  if (preview.type === 'preview') {
    assert.deepEqual(preview.positions, [{ id: 'a', label: 'A', x: 0, y: 0 }]);
  }
});

void test('不按 ⌥ 时拖动仍生成 move 命令', () => {
  const start = downAt(createInteractionState(), false);
  const moved = reduceInteraction(start.state, {
    type: 'pointerMove',
    point: { x: 50, y: 10 },
    scale: 1,
  });
  const up = reduceInteraction(moved.state, {
    type: 'pointerUp',
    point: { x: 50, y: 10 },
    scale: 1,
  });
  assert.equal(up.effects.some((effect) => effect.type === 'duplicate'), false);
  const commit = up.effects.find((effect) => effect.type === 'commit');
  assert.ok(commit !== undefined);
});

void test('⌥按下但未位移不产生副本', () => {
  const start = downAt(createInteractionState(), true);
  const up = reduceInteraction(start.state, {
    type: 'pointerUp',
    point: { x: 10, y: 10 },
    scale: 1,
  });
  assert.equal(up.effects.some((effect) => effect.type === 'duplicate'), false);
});

void test('R8 只读态下 ⌥按下不创建拖拽手势', () => {
  const result = downAt(createInteractionState(), true, true);
  assert.equal(result.state.gesture, null);
});
