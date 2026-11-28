import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canQueryModels,
  derivePresetId,
  inferAllowInsecureHttp,
  isKeyOptional,
  isLocalProvider,
  requiresApiKey,
  validateBaseUrl,
  AI_PROVIDER_PRESETS,
} from '../../../src/features/ai/ai-endpoint.ts';

// ─── inferAllowInsecureHttp ────────────────────────────────────────

void test('inferAllowInsecureHttp：http + localhost → true', () => {
  assert.equal(inferAllowInsecureHttp('http://localhost:11434'), true);
  assert.equal(inferAllowInsecureHttp('http://localhost'), true);
});

void test('inferAllowInsecureHttp：http + 127.0.0.1 → true', () => {
  assert.equal(inferAllowInsecureHttp('http://127.0.0.1:11434'), true);
});

void test('inferAllowInsecureHttp：http + ::1 → true', () => {
  assert.equal(inferAllowInsecureHttp('http://[::1]:11434'), true);
});

void test('inferAllowInsecureHttp：http + 非回环 → false', () => {
  assert.equal(inferAllowInsecureHttp('http://10.0.0.1:8080/v1'), false);
  assert.equal(inferAllowInsecureHttp('http://192.168.1.100:8080'), false);
  assert.equal(inferAllowInsecureHttp('http://api.internal.company.com'), false);
});

void test('inferAllowInsecureHttp：https → false', () => {
  assert.equal(inferAllowInsecureHttp('https://api.openai.com/v1'), false);
  assert.equal(inferAllowInsecureHttp('https://localhost:11434'), false);
});

void test('inferAllowInsecureHttp：空 / 无效 URL → false', () => {
  assert.equal(inferAllowInsecureHttp(''), false);
  assert.equal(inferAllowInsecureHttp('not-a-url'), false);
  assert.equal(inferAllowInsecureHttp('ftp://localhost'), false);
});

// ─── validateBaseUrl ────────────────────────────────────────────────

void test('validateBaseUrl：合法 http/https → null', () => {
  assert.equal(validateBaseUrl('http://localhost:11434'), null);
  assert.equal(validateBaseUrl('https://api.openai.com/v1'), null);
  assert.equal(validateBaseUrl('https://example.ai/custom'), null);
});

void test('validateBaseUrl：空字符串 → 错误', () => {
  const r = validateBaseUrl('');
  assert.ok(r !== null);
  assert.ok(r.includes('请填写'));
});

void test('validateBaseUrl：非法协议 → 错误', () => {
  const r = validateBaseUrl('ftp://localhost');
  assert.ok(r !== null);
  assert.ok(r.includes('http') || r.includes('https'));
});

void test('validateBaseUrl：格式无效 → 错误', () => {
  const r = validateBaseUrl('not-a-url');
  assert.ok(r !== null);
});

// ─── AI_PROVIDER_PRESETS ─────────────────────────────────────────────

void test('预设表：常见生产商全部暴露，provider 值与 AiProvider 对齐', () => {
  // 9 个已知生产商；`custom` 不在表中，由 derivePresetId 回退。
  assert.equal(AI_PROVIDER_PRESETS.length, 9);

  // Provider 值只能是 3 个 AiProvider 有效值
  const validProviders: readonly string[] = ['ollama', 'openai-compatible', 'openai-compatible-local'];
  for (const preset of AI_PROVIDER_PRESETS) {
    assert.ok(validProviders.includes(preset.provider), `${preset.label} provider 非法: ${preset.provider}`);
  }
  for (const preset of AI_PROVIDER_PRESETS) {
    if (preset.id === 'ollama') {
      assert.equal(preset.provider, 'ollama');
      assert.equal(preset.showKeyField, false);
      assert.equal(preset.hideSaveDelete, true);
    } else if (preset.id === 'openai-compatible-local') {
      assert.equal(preset.provider, 'openai-compatible-local');
      assert.equal(preset.showKeyField, true, '本地端点 Key 可选，但仍展示 Key 输入框');
      assert.equal(preset.hideSaveDelete, false);
      assert.equal(preset.defaultBaseUrl, 'http://127.0.0.1:8000/v1');
    } else {
      assert.equal(preset.provider, 'openai-compatible');
      assert.equal(preset.showKeyField, true);
      assert.equal(preset.hideSaveDelete, false);
    }
  }
  // id 唯一
  assert.equal(new Set(AI_PROVIDER_PRESETS.map((p) => p.id)).size, 9);

  // DeepSeek 预设的 BASE URL 已预填
  const deepseek = AI_PROVIDER_PRESETS.find((p) => p.id === 'deepseek');
  assert.ok(deepseek !== undefined);
  assert.equal(deepseek.defaultBaseUrl, 'https://api.deepseek.com');
});

// ─── derivePresetId（生产商下拉回显） ───────────────────────────────

void test('derivePresetId：匹配已知生产商 → 返回其 id', () => {
  assert.equal(derivePresetId('http://localhost:11434', 'ollama'), 'ollama');
  assert.equal(derivePresetId('https://api.openai.com/v1', 'openai-compatible'), 'openai-official');
  assert.equal(derivePresetId('https://api.deepseek.com', 'openai-compatible'), 'deepseek');
});

void test('derivePresetId：不匹配 → custom；provider 不同即使 URL 相同也 custom', () => {
  assert.equal(derivePresetId('https://my.endpoint/v1', 'openai-compatible'), 'custom');
  // openai 的 URL 但 provider 是 ollama → 不匹配 → custom
  assert.equal(derivePresetId('https://api.openai.com/v1', 'ollama'), 'custom');
  assert.equal(derivePresetId('', 'openai-compatible'), 'custom');
});

// ─── Key 语义（Ollama 无 Key） ───────────────────────────────────────

void test('requiresApiKey：仅公网 openai-compatible 强制需要 Key', () => {
  assert.equal(requiresApiKey('ollama'), false);
  assert.equal(requiresApiKey('openai-compatible'), true);
  assert.equal(requiresApiKey('openai-compatible-local'), false);
});

void test('isKeyOptional / isLocalProvider：本地 OpenAI 兼容端点 Key 可选', () => {
  assert.equal(isKeyOptional('openai-compatible-local'), true);
  assert.equal(isKeyOptional('ollama'), false);
  assert.equal(isKeyOptional('openai-compatible'), false);
  assert.equal(isLocalProvider('ollama'), true);
  assert.equal(isLocalProvider('openai-compatible-local'), true);
  assert.equal(isLocalProvider('openai-compatible'), false);
});

void test('canQueryModels：本地端点未配置也可查，公网 openai-compatible 需 configured', () => {
  assert.equal(canQueryModels('ollama', false), true);
  assert.equal(canQueryModels('ollama', true), true);
  assert.equal(canQueryModels('openai-compatible-local', false), true);
  assert.equal(canQueryModels('openai-compatible-local', true), true);
  assert.equal(canQueryModels('openai-compatible', false), false);
  assert.equal(canQueryModels('openai-compatible', true), true);
});
