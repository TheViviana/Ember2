/**
 * 画布 AI 背景：命令生成、顶层字段读取、undo/redo 与未知顶层键保留。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mutate, type CanvasDocument } from '#canvas-format';
import {
  createUpdateCanvasAiContextCommand,
  readCanvasAiContext,
} from '../../../src/app/canvas/canvas-interactions.ts';

function document(aiContext?: string): CanvasDocument {
  return {
    schemaVersion: 3,
    nodes: [],
    edges: [],
    customRoot: { kept: true },
    ...(aiContext === undefined ? {} : { aiContext }),
  };
}

void test('命令生成：trim 后写入，空白转为 null', () => {
  const set = createUpdateCanvasAiContextCommand('  画布背景  ');
  assert.deepEqual(set, { kind: 'updateCanvasMeta', changes: { aiContext: '画布背景' } });
  const clear = createUpdateCanvasAiContextCommand('   ');
  assert.deepEqual(clear, { kind: 'updateCanvasMeta', changes: { aiContext: null } });
});

void test('读取：缺失或非字符串返回空串', () => {
  assert.equal(readCanvasAiContext(document()), '');
  const invalid = { ...document(), aiContext: 42 } as unknown as CanvasDocument;
  assert.equal(readCanvasAiContext(invalid), '');
});

void test('设置后可按画布读取，undo 恢复无背景状态且保留未知顶层键', () => {
  const applied = mutate(document(), [createUpdateCanvasAiContextCommand('背景')]);
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  assert.equal(readCanvasAiContext(applied.document), '背景');
  assert.deepEqual((applied.document as { customRoot?: unknown }).customRoot, { kept: true });

  const undone = mutate(applied.document, applied.inverse);
  assert.equal(undone.ok, true);
  if (!undone.ok) return;
  assert.equal(readCanvasAiContext(undone.document), '');
  assert.equal('aiContext' in undone.document, false);
});

void test('清空后撤销恢复旧背景', () => {
  const cleared = mutate(document('旧背景'), [createUpdateCanvasAiContextCommand(null)]);
  assert.equal(cleared.ok, true);
  if (!cleared.ok) return;
  assert.equal(readCanvasAiContext(cleared.document), '');

  const restored = mutate(cleared.document, cleared.inverse);
  assert.equal(restored.ok, true);
  if (!restored.ok) return;
  assert.equal(readCanvasAiContext(restored.document), '旧背景');
});