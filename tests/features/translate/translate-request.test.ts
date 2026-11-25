/**
 * 翻译请求构造测试：AI 翻译复用既有流式通道，只校验请求语义与前置错误。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_TRANSLATE_LANGUAGE,
  buildTranslateRequest,
} from '../../../src/features/translate/translate-request.ts';

const CONFIG = {
  provider: 'openai-compatible' as const,
  baseUrl: 'https://api.openai.com/v1',
  allowInsecureHttp: false,
  model: 'gpt-4o-mini',
};

void test('有效配置生成单条 user 消息，包含目标语言与原文', () => {
  const built = buildTranslateRequest({
    config: CONFIG,
    text: 'Hello world',
    targetLang: '中文',
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.request.provider, 'openai-compatible');
  assert.equal(built.request.model, 'gpt-4o-mini');
  assert.equal(built.request.messages.length, 1);
  const message = built.request.messages[0];
  assert.equal(message?.role, 'user');
  assert.match(message?.content ?? '', /中文/);
  assert.match(message?.content ?? '', /Hello world/);
});

void test('空原文直接失败，不发起请求', () => {
  const built = buildTranslateRequest({ config: CONFIG, text: '   ', targetLang: '中文' });
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.match(built.reason, /没有可翻译/);
});

void test('缺少模型或端点无效时给出明确原因', () => {
  const noModel = buildTranslateRequest({
    config: { ...CONFIG, model: '' },
    text: 'hi',
    targetLang: '中文',
  });
  assert.equal(noModel.ok, false);
  if (!noModel.ok) assert.match(noModel.reason, /模型/);

  const badUrl = buildTranslateRequest({
    config: { ...CONFIG, baseUrl: 'not a url' },
    text: 'hi',
    targetLang: '中文',
  });
  assert.equal(badUrl.ok, false);
  if (!badUrl.ok) assert.match(badUrl.reason, /端点/);
});

void test('空目标语言回落到默认语言', () => {
  const built = buildTranslateRequest({ config: CONFIG, text: 'hi', targetLang: '  ' });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.match(built.request.messages[0]?.content ?? '', new RegExp(DEFAULT_TRANSLATE_LANGUAGE));
});
