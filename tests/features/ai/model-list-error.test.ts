import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeModelListError } from '../../../src/features/ai/ai-error-map.ts';

void test('503 模型不可用：列表失败文案不复用聊天选模型提示', () => {
  const result = describeModelListError('E_AI_MODEL_UNAVAILABLE');
  assert.ok(result.text.startsWith('拉取模型失败：'));
  assert.ok(!result.text.includes('请在聊天时选择其他模型'));
  assert.ok(result.text.includes('模型 ID'), '应提示手动填写模型 ID');
  assert.equal(result.tone, 'warning');
});

void test('网络错误：保留真实原因并加拉取前缀', () => {
  const result = describeModelListError('E_AI_NETWORK');
  assert.equal(result.tone, 'error');
  assert.ok(result.text.startsWith('拉取模型失败：'));
  assert.ok(result.text.includes('网络连接失败'));
});

void test('未知码：保留原始码与原始消息', () => {
  const result = describeModelListError('E_AI_FUTURE', 'boom');
  assert.ok(result.text.includes('E_AI_FUTURE'));
  assert.ok(result.text.includes('boom'));
});
