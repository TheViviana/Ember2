import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildChatRequest,
  createChatRequestId,
  LOCAL_CONTEXT_CHAR_BUDGET,
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

void test('中文模型别名原样进入请求体（Ember 不做 ASCII 限制）', () => {
  const result = buildChatRequest({
    requestId: 'rid-1',
    config: {
      ...CONFIG,
      provider: 'openai-compatible-local',
      baseUrl: 'http://127.0.0.1:8000/v1',
      model: '主力：编程/写作/看图',
    },
    messages: TURNS,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.request.model, '主力：编程/写作/看图');
});

void test('本地 provider 超预算时丢弃最早轮次，保留最后一条用户消息', () => {
  const chunk = 'x'.repeat(10_000);
  const turns: readonly AiChatTurn[] = [
    { id: 'u1', role: 'user', content: chunk, completed: true },
    { id: 'a1', role: 'assistant', content: chunk, completed: true },
    { id: 'u2', role: 'user', content: chunk, completed: true },
  ];
  const result = buildChatRequest({
    requestId: 'rid-1',
    config: { ...CONFIG, provider: 'openai-compatible-local' },
    messages: turns,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.request.messages, [{ role: 'user', content: chunk }]);
});

void test('公网 provider 不裁剪历史（保持原有行为）', () => {
  const chunk = 'x'.repeat(10_000);
  const turns: readonly AiChatTurn[] = [
    { id: 'u1', role: 'user', content: chunk, completed: true },
    { id: 'a1', role: 'assistant', content: chunk, completed: true },
    { id: 'u2', role: 'user', content: chunk, completed: true },
  ];
  const result = buildChatRequest({
    requestId: 'rid-1',
    config: { ...CONFIG, provider: 'openai-compatible', baseUrl: 'https://api.test/v1' },
    messages: turns,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.request.messages.length, 3);
});

void test('最后一条用户消息本身超预算也原样保留', () => {
  const huge = 'x'.repeat(LOCAL_CONTEXT_CHAR_BUDGET + 100);
  const result = buildChatRequest({
    requestId: 'rid-1',
    config: { ...CONFIG, provider: 'openai-compatible-local' },
    messages: [{ id: 'u1', role: 'user', content: huge, completed: true }],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.request.messages, [{ role: 'user', content: huge }]);
});

void test('createChatRequestId 生成合法 requestId', () => {
  const id = createChatRequestId();
  assert.match(id, /^[A-Za-z0-9_-]{1,128}$/);
  assert.notEqual(createChatRequestId(), id);
});
