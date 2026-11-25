import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildChatRequest,
  createChatRequestId,
  type ChatRequestConfig,
} from '../../../src/features/ai/ai-chat-request.ts';
import type { AiChatTurn } from '../../../src/features/ai/ai-chat-reducer.ts';

const CONFIG: ChatRequestConfig = {
  provider: 'ollama',
  baseUrl: 'http://localhost:11434',
  allowInsecureHttp: true,
  model: 'gpt-oss:20b',
};

const TURNS: readonly AiChatTurn[] = [
  { id: 'u1', role: 'user', content: '第一问', completed: true },
  { id: 'a1', role: 'assistant', content: '第一答', completed: true },
  { id: 'u2', role: 'user', content: '第二问', completed: true },
];

void test('buildChatRequest 字段映射完整', () => {
  const result = buildChatRequest({ requestId: 'rid-1', config: CONFIG, messages: TURNS });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.request.requestId, 'rid-1');
  assert.equal(result.request.provider, 'ollama');
  assert.equal(result.request.baseUrl, 'http://localhost:11434');
  assert.equal(result.request.allowInsecureHttp, true);
  assert.equal(result.request.model, 'gpt-oss:20b');
  assert.deepEqual(result.request.messages, [
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答' },
    { role: 'user', content: '第二问' },
  ]);
});

void test('messages 排除未完成 assistant 占位与失败/取消残留', () => {
  const turns: readonly AiChatTurn[] = [
    { id: 'u1', role: 'user', content: '问', completed: true },
    { id: 'a1', role: 'assistant', content: '半截', completed: false },
    { id: 'u2', role: 'user', content: '再问', completed: true },
    { id: 'a2', role: 'assistant', content: '', completed: false },
  ];
  const result = buildChatRequest({ requestId: 'rid-1', config: CONFIG, messages: turns });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.request.messages, [
    { role: 'user', content: '问' },
    { role: 'user', content: '再问' },
  ]);
});

void test('requestId 校验：合法字符与长度', () => {
  const ok = buildChatRequest({ requestId: 'abcdefghij-KLMNOPQRST_0123456789', config: CONFIG, messages: TURNS });
  assert.equal(ok.ok, true);

  const empty = buildChatRequest({ requestId: '', config: CONFIG, messages: TURNS });
  assert.deepEqual(empty, { ok: false, reason: 'invalid_request_id' });

  const tooLong = buildChatRequest({ requestId: 'a'.repeat(129), config: CONFIG, messages: TURNS });
  assert.deepEqual(tooLong, { ok: false, reason: 'invalid_request_id' });

  const space = buildChatRequest({ requestId: 'has space', config: CONFIG, messages: TURNS });
  assert.deepEqual(space, { ok: false, reason: 'invalid_request_id' });

  const unicode = buildChatRequest({ requestId: '请求id', config: CONFIG, messages: TURNS });
  assert.deepEqual(unicode, { ok: false, reason: 'invalid_request_id' });
});

void test('model 为空返回 missing_model', () => {
  const result = buildChatRequest({
    requestId: 'rid-1',
    config: { ...CONFIG, model: '   ' },
    messages: TURNS,
  });
  assert.deepEqual(result, { ok: false, reason: 'missing_model' });
});

void test('messages 为空返回 empty_messages', () => {
  const result = buildChatRequest({
    requestId: 'rid-1',
    config: CONFIG,
    messages: [{ id: 'a1', role: 'assistant', content: '半截', completed: false }],
  });
  assert.deepEqual(result, { ok: false, reason: 'empty_messages' });
});

void test('baseUrl 非法返回 invalid_base_url', () => {
  const result = buildChatRequest({
    requestId: 'rid-1',
    config: { ...CONFIG, baseUrl: 'not-a-url' },
    messages: TURNS,
  });
  assert.deepEqual(result, { ok: false, reason: 'invalid_base_url' });
});

void test('请求体不包含 Key 字段', () => {
  const result = buildChatRequest({ requestId: 'rid-1', config: CONFIG, messages: TURNS });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal('key' in result.request, false);
});

void test('createChatRequestId 生成合法 requestId', () => {
  const id = createChatRequestId();
  assert.match(id, /^[A-Za-z0-9_-]{1,128}$/);
  assert.notEqual(createChatRequestId(), id);
});
