/**
 * C1-D D-a：编辑器选区拖入画布的标签提取与一次 addNode。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createAddTextNodeCommand,
  textLabelFromText,
} from '../../../src/app/canvas/canvas-interactions.ts';

void test('标签取首个非空行并 trim，空文本回退「文本节点」', () => {
  assert.equal(textLabelFromText('第一行\n第二行'), '第一行');
  assert.equal(textLabelFromText('\n\n  缩进行  \n'), '缩进行');
  assert.equal(textLabelFromText('   \n\t\n'), '文本节点');
  assert.equal(textLabelFromText(''), '文本节点');
});

void test('标签超过 40 字符截断，恰好 40 字符不截断', () => {
  assert.equal(textLabelFromText('a'.repeat(40)), 'a'.repeat(40));
  assert.equal(textLabelFromText('b'.repeat(41)), 'b'.repeat(40));
});

void test('createAddTextNodeCommand 一次生成带 label 的 addNode', () => {
  const command = createAddTextNodeCommand(12, 34, '来自编辑器');
  assert.equal(command.kind, 'addNode');
  if (command.kind !== 'addNode') return;
  assert.equal(command.node.type, 'text');
  assert.equal(command.node.label, '来自编辑器');
  assert.equal(command.node.x, 12);
  assert.equal(command.node.y, 34);
  assert.equal(command.node.id.startsWith('n_'), true);
});

void test('缺省 label 仍为「文本节点」，既有调用语义不变', () => {
  const command = createAddTextNodeCommand(0, 0);
  assert.equal(command.kind, 'addNode');
  if (command.kind !== 'addNode') return;
  assert.equal(command.node.label, '文本节点');
});
