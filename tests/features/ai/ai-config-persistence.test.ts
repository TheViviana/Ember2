/**
 * 2026-11-25：设置页要求「改完即存、重启不变」。
 * AI 设置的端点与模型此前只在内存里，重启回到 Ollama 默认；这里锁定持久化契约，
 * 同时保证 Key 不会写进 localStorage。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AI_CHAT_CONFIG_INITIAL,
  AI_CHAT_CONFIG_STORAGE_KEY,
  loadAiChatConfig,
  saveAiChatConfig,
} from '../../../src/features/ai/ai-chat-store.ts';
import { DEFAULT_GLOBAL_SYSTEM_PROMPT } from '../../../src/features/ai/default-system-prompt.ts';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    removeItem: (key: string) => void data.delete(key),
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const CUSTOM = Object.freeze({
  preset: 'deepseek' as const,
  provider: 'openai-compatible' as const,
  baseUrl: 'https://api.deepseek.com',
  allowInsecureHttp: false,
  model: 'deepseek-chat',
  systemPrompt: '始终用中文',
});

void test('AI 端点、模型与全局提示词写入后可按同名键读回', () => {
  const storage = memoryStorage();
  saveAiChatConfig(CUSTOM, storage);
  assert.equal(storage.getItem(AI_CHAT_CONFIG_STORAGE_KEY), JSON.stringify(CUSTOM));
  assert.deepEqual(loadAiChatConfig(storage), CUSTOM);
});

void test('AI 配置只落六个字段，绝不包含 Key', () => {
  const storage = memoryStorage();
  saveAiChatConfig(CUSTOM, storage);
  const parsed = JSON.parse(storage.getItem(AI_CHAT_CONFIG_STORAGE_KEY) ?? '{}') as Record<
    string,
    unknown
  >;
  assert.deepEqual(Object.keys(parsed).sort(), [
    'allowInsecureHttp',
    'baseUrl',
    'model',
    'preset',
    'provider',
    'systemPrompt',
  ]);
});

void test('旧配置缺 systemPrompt 时回退默认提示词', () => {
  const storage = memoryStorage();
  const legacy: Record<string, unknown> = { ...CUSTOM };
  delete legacy.systemPrompt;
  storage.setItem(AI_CHAT_CONFIG_STORAGE_KEY, JSON.stringify(legacy));
  const loaded = loadAiChatConfig(storage);
  assert.equal(loaded.systemPrompt, DEFAULT_GLOBAL_SYSTEM_PROMPT);
  assert.equal(loaded.model, 'deepseek-chat');
});

void test('显式空串保持为空：清空仍表示不注入全局提示词', () => {
  const storage = memoryStorage();
  saveAiChatConfig({ ...CUSTOM, systemPrompt: '' }, storage);
  assert.equal(loadAiChatConfig(storage).systemPrompt, '');
});

void test('初始配置自带默认系统提示词', () => {
  assert.equal(AI_CHAT_CONFIG_INITIAL.systemPrompt, DEFAULT_GLOBAL_SYSTEM_PROMPT);
});

void test('缺省、坏 JSON 与非法 preset 都回退默认配置', () => {
  const storage = memoryStorage();
  assert.deepEqual(loadAiChatConfig(storage), AI_CHAT_CONFIG_INITIAL);
  storage.setItem(AI_CHAT_CONFIG_STORAGE_KEY, 'not-json');
  assert.deepEqual(loadAiChatConfig(storage), AI_CHAT_CONFIG_INITIAL);
  storage.setItem(AI_CHAT_CONFIG_STORAGE_KEY, '{"preset":"unknown"}');
  assert.deepEqual(loadAiChatConfig(storage), AI_CHAT_CONFIG_INITIAL);
});

void test('单字段损坏时按字段回退，不让整份配置失效', () => {
  const storage = memoryStorage();
  storage.setItem(
    AI_CHAT_CONFIG_STORAGE_KEY,
    JSON.stringify({ ...CUSTOM, allowInsecureHttp: 'yes', model: '' }),
  );
  const loaded = loadAiChatConfig(storage);
  assert.equal(loaded.preset, 'deepseek');
  assert.equal(loaded.baseUrl, 'https://api.deepseek.com');
  assert.equal(loaded.allowInsecureHttp, AI_CHAT_CONFIG_INITIAL.allowInsecureHttp);
  assert.equal(loaded.model, null);
});
