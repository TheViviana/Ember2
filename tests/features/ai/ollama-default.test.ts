import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AI_PROVIDER_PRESETS,
  DEFAULT_OLLAMA_BASE_URL,
  derivePresetId,
} from '../../../src/features/ai/ai-endpoint.ts';
import { AI_CHAT_CONFIG_INITIAL } from '../../../src/features/ai/ai-chat-store.ts';
import { AI_PANEL_INITIAL } from '../../../src/features/ai/ai-panel-reducer.ts';

void test('Ollama 默认端点：三处初始值均引用同一常量', () => {
  assert.equal(DEFAULT_OLLAMA_BASE_URL, 'http://localhost:11434');
  assert.equal(AI_CHAT_CONFIG_INITIAL.baseUrl, DEFAULT_OLLAMA_BASE_URL);
  assert.equal(AI_PANEL_INITIAL.baseUrl, DEFAULT_OLLAMA_BASE_URL);
});

void test('Ollama 预设 defaultBaseUrl 与常量一致', () => {
  const ollama = AI_PROVIDER_PRESETS.find((preset) => preset.id === 'ollama');
  assert.ok(ollama);
  assert.equal(ollama.defaultBaseUrl, DEFAULT_OLLAMA_BASE_URL);
});

void test('derivePresetId 识别 Ollama 默认端点为 ollama 预设', () => {
  assert.equal(derivePresetId(DEFAULT_OLLAMA_BASE_URL, 'ollama'), 'ollama');
});
