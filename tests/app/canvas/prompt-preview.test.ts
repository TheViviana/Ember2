/**
 * AI 节点 System Prompt 预览：三层顺序、缺层、fallback、非 AI 节点。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAiNodePromptPreview } from '../../../src/app/canvas/prompt-preview.ts';
import { createEmptyCanvasDocument, type CanvasDocument } from '../../../src/app/canvas/format.ts';
import { PROMPT_SECTION } from '../../../src/features/ai/system-prompt.ts';
import { DEFAULT_AI_INSTRUCTION } from '../../../src/app/canvas/ai-node-execution.ts';

function previewDocument(): CanvasDocument {
  return {
    ...createEmptyCanvasDocument(),
    nodes: [
      { id: 'ai', type: 'ai', x: 0, y: 0, text: '节点指令' },
      { id: 'doc', type: 'document', docPath: 'note.md' },
      { id: 'prompt', type: 'prompt', text: '相连提示词' },
    ],
    edges: [
      { id: 'e1', from: { nodeId: 'doc', portId: 'out' }, to: { nodeId: 'ai', portId: 'in' } },
      { id: 'e2', from: { nodeId: 'prompt', portId: 'out' }, to: { nodeId: 'ai', portId: 'in' } },
    ],
  };
}

void test('三层预览：全局 → 画布 → 节点，统计素材与提示词数量', () => {
  const preview = buildAiNodePromptPreview(previewDocument(), 'ai', {
    global: '全局规范',
    canvas: '画布背景',
  });
  assert.notEqual(preview, null);
  if (preview === null) return;
  assert.deepEqual(preview.sections.map((section) => section.source), ['global', 'canvas', 'node']);
  assert.equal(
    preview.system,
    [
      `${PROMPT_SECTION.global}\n全局规范`,
      `${PROMPT_SECTION.canvas}\n画布背景`,
      `${PROMPT_SECTION.node}\n节点指令\n\n相连提示词`,
    ].join('\n\n'),
  );
  assert.equal(preview.promptCount, 2);
  assert.equal(preview.docCount, 1);
});

void test('无全局/画布层时只展示节点层，不加标题', () => {
  const preview = buildAiNodePromptPreview(previewDocument(), 'ai', {});
  assert.notEqual(preview, null);
  if (preview === null) return;
  assert.deepEqual(preview.sections.map((section) => section.source), ['node']);
  assert.equal(preview.system, '节点指令\n\n相连提示词');
});

void test('节点指令为空时使用默认指令', () => {
  const document: CanvasDocument = {
    ...createEmptyCanvasDocument(),
    nodes: [{ id: 'ai', type: 'ai', x: 0, y: 0, text: '   ' }],
  };
  const preview = buildAiNodePromptPreview(document, 'ai', {});
  assert.notEqual(preview, null);
  assert.equal(preview?.system, DEFAULT_AI_INSTRUCTION);
});

void test('不存在的节点或非 AI 节点返回 null', () => {
  const document = previewDocument();
  assert.equal(buildAiNodePromptPreview(document, 'missing', {}), null);
  assert.equal(buildAiNodePromptPreview(document, 'doc', {}), null);
});