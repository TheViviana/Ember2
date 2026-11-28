/**
 * ⌘C/⌘V 纯命令层：快照收集、偏移、新 id 与字段保留。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanvasNodeInput } from '#canvas-format';
import {
  collectNodeSnapshots,
  createPasteNodeCommands,
} from '../../../src/app/canvas/canvas-interactions.ts';

const nodes: readonly unknown[] = [
  { id: 'a', x: 10, y: 20, type: 'text', label: 'A', text: '正文' },
  { id: 'b', x: 100, y: 200, type: 'ai', label: 'B', model: 'm1', parentId: 'g1' },
  { id: 'bad', x: 'nope', y: 0 },
];

void test('快照收集：按选中顺序、跳过缺失与非法形状', () => {
  const snapshots = collectNodeSnapshots(nodes, ['b', 'missing', 'a']);
  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots.map((node) => node.id), ['b', 'a']);
});

void test('粘贴命令：新 id、整体偏移、其余字段原样保留', () => {
  const snapshots = collectNodeSnapshots(nodes, ['a', 'b']);
  const commands = createPasteNodeCommands(snapshots, { dx: 24, dy: 48 });
  assert.equal(commands.length, 2);
  const first = commands[0];
  const second = commands[1];
  assert.ok(first?.kind === 'addNode');
  assert.ok(second?.kind === 'addNode');
  const firstNode = first.node as CanvasNodeInput & { readonly text?: string };
  assert.notEqual(firstNode.id, 'a');
  assert.equal(firstNode.x, 34);
  assert.equal(firstNode.y, 68);
  assert.equal(firstNode.label, 'A');
  assert.equal(firstNode.text, '正文');
  const secondNode = second.node as CanvasNodeInput & { readonly model?: string; readonly parentId?: string };
  assert.notEqual(secondNode.id, 'b');
  assert.equal(secondNode.parentId, 'g1');
  assert.equal(secondNode.model, 'm1');
  assert.notEqual(firstNode.id, secondNode.id);
});