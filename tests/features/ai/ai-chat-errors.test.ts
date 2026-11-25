import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chatErrorFromEvent,
  chatErrorFromUnknown,
  isCancelledChatError,
} from '../../../src/features/ai/ai-chat-errors.ts';
import { mapAiErrorCode } from '../../../src/features/ai/ai-error-map.ts';

void test('chatErrorFromEvent 保留 code / message', () => {
  const error = chatErrorFromEvent({
    type: 'error',
    requestId: 'rid-1',
    code: 'E_AI_NETWORK',
    message: '断网',
  });
  assert.equal(error.code, 'E_AI_NETWORK');
  assert.equal(error.message, '断网');
});

void test('chatErrorFromUnknown：Error 实例带 code', () => {
  const raw = new Error('鉴权失败');
  (raw as Error & { code?: string }).code = 'E_AI_UNAUTHORIZED';
  const error = chatErrorFromUnknown(raw);
  assert.equal(error.code, 'E_AI_UNAUTHORIZED');
  assert.equal(error.message, '鉴权失败');
});

void test('chatErrorFromUnknown：普通对象 / 字符串兜底', () => {
  const fromObject = chatErrorFromUnknown({ code: 'E_AI_TIMEOUT', message: '超时' });
  assert.equal(fromObject.code, 'E_AI_TIMEOUT');
  assert.equal(fromObject.message, '超时');

  const fromString = chatErrorFromUnknown('boom');
  assert.equal(fromString.code, undefined);
  assert.equal(fromString.message, 'boom');
});

void test('isCancelledChatError 只识别 E_AI_CANCELLED', () => {
  assert.equal(isCancelledChatError({ code: 'E_AI_CANCELLED', message: '取消' }), true);
  assert.equal(isCancelledChatError({ code: 'E_AI_NETWORK', message: '断网' }), false);
  assert.equal(isCancelledChatError({ code: undefined, message: '未知' }), false);
});

void test('未知码经由 mapAiErrorCode 回退为通用错误文案', () => {
  const message = mapAiErrorCode('E_AI_UNKNOWN_X', '原始信息');
  assert.equal(message.tone, 'error');
  assert.match(message.text, /E_AI_UNKNOWN_X/);
  assert.match(message.text, /原始信息/);
});
