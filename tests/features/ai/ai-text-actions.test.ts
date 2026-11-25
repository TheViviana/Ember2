import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AI_TEXT_ACTIONS,
  buildAiTextPrompt,
  findAiTextAction,
  type AiTextActionId,
} from '../../../src/features/ai/ai-text-actions.ts';

void test('CR-49：八个选中文本动作与菜单顺序一致', () => {
  assert.deepEqual(
    AI_TEXT_ACTIONS.map((action) => action.label),
    ['润色', '扩写', '缩写', '总结', '解释', '延伸', '定义', '研究'],
  );
  assert.equal(new Set(AI_TEXT_ACTIONS.map((action) => action.id)).size, 8);
});

void test('CR-49：动作提示同时包含指令与原文，且要求只输出结果', () => {
  const action = findAiTextAction('polish');
  assert.notEqual(action, null);
  if (action === null) return;
  const prompt = buildAiTextPrompt(action, '原文段落');
  assert.ok(prompt.system.includes('只输出结果本身'));
  assert.ok(prompt.user.includes('润色'));
  assert.ok(prompt.user.endsWith('原文段落'));
});

void test('CR-49：未知动作返回 null', () => {
  assert.equal(findAiTextAction('unknown' as AiTextActionId), null);
});
