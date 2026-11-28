/**
 * CR-20261118-05 N4：拉线落空建节点的原子命令、校验与纯状态机出口。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mutate, type CanvasDocument } from '#canvas-format';
import {
  createConnectNewNodeCommands,
  createConnectionNodePorts,
} from '../../../src/app/canvas/canvas-interactions.ts';
import { CanvasInteractionController } from '../../../src/app/canvas/document-controller.ts';
import {
  createInteractionState,
  reduceInteraction,
} from '../../../src/app/canvas/interaction.ts';

const sourceDocument: CanvasDocument = {
  schemaVersion: 3,
  nodes: [
    {
      id: 'a',
      x: 0,
      y: 0,
      type: 'text',
      ports: [
        { id: 'in', dir: 'in' },
        { id: 'out', dir: 'out' },
      ],
    },
  ],
  edges: [],
};

function textNode() {
  return {
    id: 'n1',
    x: 200,
    y: 0,
    type: 'text' as const,
    label: '文本节点',
    ports: createConnectionNodePorts(),
  };
}

function startConnection() {
  return reduceInteraction(createInteractionState(), {
    type: 'pointerDown',
    point: { x: 0, y: 0 },
    button: 0,
    shiftKey: false,
    toggleKey: false,
    altKey: false,
    pan: false,
    target: { kind: 'port', port: { nodeId: 'a', portId: 'out', dir: 'out' } },
    nodes: [],
  });
}

function controllerFor(document: CanvasDocument): CanvasInteractionController {
  return new CanvasInteractionController({
    canvasId: 'n4',
    store: {
      save: () => Promise.resolve({}),
      open: () =>
        Promise.resolve({ exists: false, text: null, sha256: '', modifiedMs: null }),
    },
    document,
    applyPositions: () => {},
    onConflict: () => {},
    schedule: () => 0,
    cancelSchedule: () => {},
  });
}

void test('createConnectionNodePorts：显式 in/out 两个端口', () => {
  assert.deepEqual(createConnectionNodePorts(), [
    { id: 'in', dir: 'in' },
    { id: 'out', dir: 'out' },
  ]);
});

void test('createConnectNewNodeCommands：addNode 在前，边连到新节点 in 端口', () => {
  const node = textNode();
  const commands = createConnectNewNodeCommands(node, { nodeId: 'a', portId: 'out' });
  assert.equal(commands.length, 2);
  assert.equal(commands[0]?.kind, 'addNode');
  assert.equal(commands[0]?.kind === 'addNode' ? commands[0].node : null, node);
  const edge = commands[1];
  assert.ok(edge?.kind === 'addEdge');
  assert.equal(edge.edge.id.startsWith('e_'), true);
  assert.deepEqual(edge.edge.from, { nodeId: 'a', portId: 'out' });
  assert.deepEqual(edge.edge.to, { nodeId: 'n1', portId: 'in' });
});

void test('同批 addNode+addEdge：mutate 成功、无 schema issue、画布不进只读', () => {
  const commands = createConnectNewNodeCommands(textNode(), { nodeId: 'a', portId: 'out' });
  const result = mutate(sourceDocument, commands);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.inspection.issues, []);
  assert.equal(result.document.nodes.length, 2);
  assert.equal(result.document.edges.length, 1);

  const undone = mutate(result.document, result.inverse);
  assert.equal(undone.ok, true);
  if (!undone.ok) return;
  assert.equal(undone.document.nodes.length, 1);
  assert.equal(undone.document.edges.length, 0);
});

void test('一次 ⌘Z 同时撤销节点与边，⌘⇧Z 一次恢复', () => {
  const controller = controllerFor(sourceDocument);
  const commands = createConnectNewNodeCommands(textNode(), { nodeId: 'a', portId: 'out' });
  assert.equal(controller.execute(commands), true);
  assert.equal(controller.isReadOnly(), false);
  assert.equal(controller.getHistory().past.length, 1);
  assert.equal(controller.getDocument().nodes.length, 2);

  assert.equal(controller.undo(), true);
  assert.equal(controller.getDocument().nodes.length, 1);
  assert.equal(controller.getDocument().edges.length, 0);

  assert.equal(controller.redo(), true);
  assert.equal(controller.getDocument().nodes.length, 2);
  assert.equal(controller.getDocument().edges.length, 1);
});

void test('空白处松开产出 connectionDropEmpty，弹出新建并连接菜单', () => {
  const empty = reduceInteraction(startConnection().state, {
    type: 'pointerUp',
    point: { x: 120, y: 80 },
    scale: 1,
    target: { kind: 'blank' },
  });
  assert.deepEqual(empty.effects, [
    {
      type: 'connectionDropEmpty',
      from: { nodeId: 'a', portId: 'out' },
      point: { x: 120, y: 80 },
      reverse: false,
    },
  ]);
});

void test('目标输入端口与节点本体松开均直接连线，不弹新建菜单', () => {
  const onPort = reduceInteraction(startConnection().state, {
    type: 'pointerUp',
    point: { x: 300, y: 40 },
    scale: 1,
    target: { kind: 'port', port: { nodeId: 'b', portId: 'in', dir: 'in' } },
  });
  assert.deepEqual(onPort.effects, [
    {
      type: 'connectionCommit',
      fromNodeId: 'a',
      fromPortId: 'out',
      toNodeId: 'b',
      toPortId: 'in',
    },
  ]);

  const onNode = reduceInteraction(startConnection().state, {
    type: 'pointerUp',
    point: { x: 300, y: 40 },
    scale: 1,
    target: { kind: 'node', id: 'b' },
  });
  assert.deepEqual(onNode.effects, [
    {
      type: 'connectionCommit',
      fromNodeId: 'a',
      fromPortId: 'out',
      toNodeId: 'b',
      toPortId: 'in',
    },
  ]);
});

void test('Esc 仍走 connectionCancel；只读态不建立连线手势', () => {
  const cancelled = reduceInteraction(startConnection().state, { type: 'cancel' });
  assert.deepEqual(cancelled.effects, [{ type: 'connectionCancel' }]);

  const readOnlyDown = reduceInteraction(createInteractionState(), {
    type: 'pointerDown',
    point: { x: 0, y: 0 },
    button: 0,
    shiftKey: false,
    toggleKey: false,
    altKey: false,
    pan: false,
    target: { kind: 'port', port: { nodeId: 'a', portId: 'out', dir: 'out' } },
    nodes: [],
    readOnly: true,
  });
  assert.equal(readOnlyDown.state.gesture, null);
  const readOnlyUp = reduceInteraction(readOnlyDown.state, {
    type: 'pointerUp',
    point: { x: 120, y: 80 },
    scale: 1,
    target: { kind: 'blank' },
  });
  assert.deepEqual(readOnlyUp.effects, []);
});
