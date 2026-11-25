import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AI_CHAT_INITIAL,
  aiChatReducer,
  type AiChatAction,
  type AiChatState,
} from '../../../src/features/ai/ai-chat-reducer.ts';

const RID = 'rid-1';
const USER_ID = 'u1';
const ASSISTANT_ID = 'a1';

function send(state: AiChatState, text = '你好'): AiChatState {
  return aiChatReducer(state, {
    type: 'SEND',
    requestId: RID,
    userMessageId: USER_ID,
    assistantMessageId: ASSISTANT_ID,
    text,
  });
}

function run(state: AiChatState, action: AiChatAction): AiChatState {
  return aiChatReducer(state, action);
}

void test('初始状态：idle / 空消息 / 无在途请求', () => {
  assert.equal(AI_CHAT_INITIAL.status, 'idle');
  assert.equal(AI_CHAT_INITIAL.messages.length, 0);
  assert.equal(AI_CHAT_INITIAL.activeRequestId, null);
  assert.equal(AI_CHAT_INITIAL.activeAssistantId, null);
  assert.equal(AI_CHAT_INITIAL.error, null);
});

void test('SEND 追加 user + assistant 占位并转 streaming', () => {
  const s = send(AI_CHAT_INITIAL);
  assert.equal(s.status, 'streaming');
  assert.equal(s.messages.length, 2);
  assert.equal(s.messages[0]?.role, 'user');
  assert.equal(s.messages[0]?.content, '你好');
  assert.equal(s.messages[0]?.completed, true);
  assert.equal(s.messages[1]?.role, 'assistant');
  assert.equal(s.messages[1]?.content, '');
  assert.equal(s.messages[1]?.completed, false);
  assert.equal(s.activeRequestId, RID);
  assert.equal(s.activeAssistantId, ASSISTANT_ID);
});

void test('SEND 空白文本被忽略', () => {
  const s = send(AI_CHAT_INITIAL, '   ');
  assert.equal(s, AI_CHAT_INITIAL);
});

void test('streaming 中再次 SEND 被忽略', () => {
  const streaming = send(AI_CHAT_INITIAL);
  const again = send(streaming, '第二次');
  assert.equal(again, streaming);
});

void test('DELTA 追加到当前 assistant', () => {
  const s1 = send(AI_CHAT_INITIAL);
  const s2 = run(s1, { type: 'DELTA', requestId: RID, text: '你' });
  const s3 = run(s2, { type: 'DELTA', requestId: RID, text: '好' });
  assert.equal(s3.messages[1]?.content, '你好');
  assert.equal(s3.status, 'streaming');
});

void test('DELTA 的 requestId 不匹配则丢弃', () => {
  const s1 = send(AI_CHAT_INITIAL);
  const s2 = run(s1, { type: 'DELTA', requestId: 'stale', text: 'x' });
  assert.equal(s2, s1);
});

void test('DONE 收尾：assistant completed + 清空在途', () => {
  const s1 = run(send(AI_CHAT_INITIAL), { type: 'DELTA', requestId: RID, text: '回答' });
  const s2 = run(s1, { type: 'DONE', requestId: RID });
  assert.equal(s2.status, 'done');
  assert.equal(s2.messages[1]?.completed, true);
  assert.equal(s2.activeRequestId, null);
  assert.equal(s2.activeAssistantId, null);
  assert.equal(s2.error, null);
});

void test('DONE 的 requestId 不匹配则丢弃（取消后迟到）', () => {
  const s1 = run(send(AI_CHAT_INITIAL), { type: 'CANCEL', requestId: RID });
  const s2 = run(s1, { type: 'DONE', requestId: RID });
  assert.equal(s2, s1);
});

void test('ERROR 保存 code/message 并保留部分文本', () => {
  const s1 = run(send(AI_CHAT_INITIAL), { type: 'DELTA', requestId: RID, text: '部分' });
  const s2 = run(s1, {
    type: 'ERROR',
    requestId: RID,
    error: { code: 'E_AI_NETWORK', message: '断网' },
  });
  assert.equal(s2.status, 'error');
  assert.equal(s2.messages[1]?.content, '部分');
  assert.equal(s2.messages[1]?.completed, false);
  assert.equal(s2.error?.code, 'E_AI_NETWORK');
  assert.equal(s2.activeRequestId, null);
});

void test('ERROR 的 E_AI_CANCELLED → cancelled 且不显示为错误', () => {
  const s1 = run(send(AI_CHAT_INITIAL), { type: 'DELTA', requestId: RID, text: '部分' });
  const s2 = run(s1, {
    type: 'ERROR',
    requestId: RID,
    error: { code: 'E_AI_CANCELLED', message: '请求已取消' },
  });
  assert.equal(s2.status, 'cancelled');
  assert.equal(s2.error, null);
});

void test('CANCEL 立即转 cancelled，迟到 delta/done 丢弃', () => {
  const s1 = run(send(AI_CHAT_INITIAL), { type: 'DELTA', requestId: RID, text: '部分' });
  const s2 = run(s1, { type: 'CANCEL', requestId: RID });
  assert.equal(s2.status, 'cancelled');
  assert.equal(s2.activeRequestId, null);
  assert.equal(s2.error, null);
  assert.equal(s2.messages[1]?.completed, false);

  const lateDelta = run(s2, { type: 'DELTA', requestId: RID, text: '迟到' });
  const lateDone = run(s2, { type: 'DONE', requestId: RID });
  assert.equal(lateDelta, s2);
  assert.equal(lateDone, s2);
});

void test('新一轮 SEND 保留历史并清理旧 error', () => {
  const s1 = run(send(AI_CHAT_INITIAL), {
    type: 'ERROR',
    requestId: RID,
    error: { code: 'E_AI_TIMEOUT', message: '超时' },
  });
  const s2 = run(s1, {
    type: 'SEND',
    requestId: 'rid-2',
    userMessageId: 'u2',
    assistantMessageId: 'a2',
    text: '再试一次',
  });
  assert.equal(s2.status, 'streaming');
  assert.equal(s2.error, null);
  assert.equal(s2.messages.length, 4);
  assert.equal(s2.messages[2]?.content, '再试一次');
});
