import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aiPanelReducer,
  AI_PANEL_INITIAL,
  type AiPanelAction,
  type AiPanelState,
  type AiPanelError,
} from '../../../src/features/ai/ai-panel-reducer.ts';

function run(state: AiPanelState, action: AiPanelAction): AiPanelState {
  return aiPanelReducer(state, action);
}

void test('初始状态', () => {
  const s = AI_PANEL_INITIAL;
  assert.equal(s.status, 'idle');
  assert.equal(s.preset, 'ollama');
  assert.equal(s.provider, 'ollama');
  assert.equal(s.baseUrl, 'http://localhost:11434');
  assert.equal(s.key, '');
  assert.equal(s.allowInsecureHttp, true);
  assert.equal(s.configured, false);
  assert.equal(s.keychainAvailable, true);
  assert.equal(s.models.length, 0);
  assert.equal(s.selectedModel, null);
  assert.equal(s.error, null);
});

// ─── Provider / Base URL / allowInsecureHttp ────────────────────────

void test('SET_PROVIDER 切换 Ollama → OpenAI：preset/provider/baseUrl 联动', () => {
  const s1 = run(AI_PANEL_INITIAL, {
    type: 'SET_PROVIDER',
    preset: 'openai-official',
    provider: 'openai-compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
    inferAllowInsecure: false,
  });
  assert.equal(s1.preset, 'openai-official');
  assert.equal(s1.provider, 'openai-compatible');
  assert.equal(s1.baseUrl, 'https://api.openai.com/v1');
  assert.equal(s1.allowInsecureHttp, false);
});

void test('SET_PROVIDER 用 preset 区分不同生产商（provider 相同）', () => {
  const official = run(AI_PANEL_INITIAL, {
    type: 'SET_PROVIDER',
    preset: 'openai-official',
    provider: 'openai-compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
    inferAllowInsecure: false,
  });
  const deepseek = run(official, {
    type: 'SET_PROVIDER',
    preset: 'deepseek',
    provider: 'openai-compatible',
    defaultBaseUrl: 'https://api.deepseek.com',
    inferAllowInsecure: false,
  });
  assert.equal(deepseek.provider, 'openai-compatible');
  assert.equal(deepseek.preset, 'deepseek');
  assert.notEqual(deepseek.preset, official.preset);
});

void test('SET_BASE_URL 非回环 http → allowInsecureHttp 自动 false', () => {
  const s1 = run(AI_PANEL_INITIAL, {
    type: 'SET_BASE_URL',
    baseUrl: 'http://10.0.0.1:8080/v1',
    inferAllowInsecure: false,
  });
  assert.equal(s1.baseUrl, 'http://10.0.0.1:8080/v1');
  assert.equal(s1.allowInsecureHttp, false);
});

void test('SET_PROVIDER 重置旧端点的 configured / 模型 / 保存结果', () => {
  const configured = run(AI_PANEL_INITIAL, {
    type: 'SAVE_OK',
    storage: 'file',
    warningCode: null,
    configured: true,
    keychainAvailable: true,
  });
  const withModels = run(configured, { type: 'MODELS_OK', models: ['m1'] });
  const selected = run(withModels, { type: 'SELECT_MODEL', model: 'm1' });

  const next = run(selected, {
    type: 'SET_PROVIDER',
    preset: 'ollama',
    provider: 'ollama',
    defaultBaseUrl: 'http://localhost:11434',
    inferAllowInsecure: true,
  });
  assert.equal(next.status, 'idle');
  assert.equal(next.configured, false);
  assert.equal(next.saveStorage, null);
  assert.equal(next.saveWarningCode, null);
  assert.equal(next.models.length, 0);
  assert.equal(next.selectedModel, null);
});

void test('SET_BASE_URL 重置旧端点的 configured / 模型', () => {
  const configured = run(AI_PANEL_INITIAL, {
    type: 'SAVE_OK',
    storage: 'file',
    warningCode: null,
    configured: true,
    keychainAvailable: true,
  });
  const withModels = run(configured, { type: 'MODELS_OK', models: ['m1'] });

  const next = run(withModels, {
    type: 'SET_BASE_URL',
    baseUrl: 'https://api.openai.com/v1',
    inferAllowInsecure: false,
  });
  assert.equal(next.status, 'idle');
  assert.equal(next.configured, false);
  assert.equal(next.saveStorage, null);
  assert.equal(next.models.length, 0);
});

// ─── 保存流程 ────────────────────────────────────────────────────

void test('保存流程完整：SAVE_START → SAVE_OK (file)', () => {
  const s1 = run(AI_PANEL_INITIAL, { type: 'SAVE_START' });
  assert.equal(s1.status, 'saving');
  assert.equal(s1.error, null);

  const s2 = run(s1, {
    type: 'SAVE_OK',
    storage: 'file',
    warningCode: null,
    configured: true,
    keychainAvailable: true,
  });
  assert.equal(s2.status, 'save_ok');
  assert.equal(s2.saveStorage, 'file');
  assert.equal(s2.saveWarningCode, null);
  assert.equal(s2.configured, true);
});

void test('保存流程：KeychainDenied → storage=memory + warningCode', () => {
  const s1 = run(AI_PANEL_INITIAL, { type: 'SAVE_START' });
  const s2 = run(s1, {
    type: 'SAVE_OK',
    storage: 'memory',
    warningCode: 'E_AI_KEYCHAIN_DENIED',
    configured: true,
    keychainAvailable: false,
  });
  assert.equal(s2.saveStorage, 'memory');
  assert.equal(s2.saveWarningCode, 'E_AI_KEYCHAIN_DENIED');
  assert.equal(s2.keychainAvailable, false);
});

void test('保存失败：SAVE_FAIL → save_fail + error', () => {
  const err: AiPanelError = { code: 'E_AI_INVALID_ENDPOINT', message: 'bad url' };
  const s1 = run(AI_PANEL_INITIAL, { type: 'SAVE_FAIL', error: err });
  assert.equal(s1.status, 'save_fail');
  assert.equal(s1.error, err);
});

// ─── 删除流程 ────────────────────────────────────────────────────

void test('删除成功 → configured=false + 清 saveStorage', () => {
  const saved: AiPanelState = {
    ...AI_PANEL_INITIAL,
    status: 'save_ok',
    configured: true,
    saveStorage: 'file',
  };
  const s1 = run(saved, { type: 'DELETE_START' });
  assert.equal(s1.status, 'deleting');

  const s2 = run(s1, { type: 'DELETE_OK' });
  assert.equal(s2.status, 'configured');
  assert.equal(s2.configured, false);
  assert.equal(s2.saveStorage, null);
});

void test('删除失败 → 进入 save_fail + error（补 CR-10 item 6 覆盖）', () => {
  const err: AiPanelError = { code: 'E_AI_NOT_CONFIGURED', message: 'no key' };
  const s1 = run(AI_PANEL_INITIAL, { type: 'DELETE_FAIL', error: err });
  assert.equal(s1.status, 'save_fail');
  assert.equal(s1.error, err);
});

// ─── 模型列表三态 ─────────────────────────────────────────────────

void test('MODELS_OK 非空 → models_ok + 保留已选（如仍在列表）', () => {
  const withSel: AiPanelState = { ...AI_PANEL_INITIAL, selectedModel: 'gpt-4' };
  const s1 = run(withSel, {
    type: 'MODELS_OK',
    models: ['gpt-4', 'gpt-3.5-turbo'],
  });
  assert.equal(s1.status, 'models_ok');
  assert.equal(s1.models.length, 2);
  assert.equal(s1.selectedModel, 'gpt-4'); // 保留，在新列表中
});

void test('MODELS_OK 无有效选择 → 自动选中首个模型', () => {
  const s1 = run(AI_PANEL_INITIAL, {
    type: 'MODELS_OK',
    models: ['llama3:latest', 'qwen2.5:7b'],
  });
  assert.equal(s1.selectedModel, 'llama3:latest');
});

void test('MODELS_OK 空数组 → models_empty + selectedModel 清除', () => {
  const withSel: AiPanelState = { ...AI_PANEL_INITIAL, selectedModel: 'gpt-4' };
  const s1 = run(withSel, { type: 'MODELS_OK', models: [] });
  assert.equal(s1.status, 'models_empty');
  assert.equal(s1.selectedModel, null);
});

void test('MODELS_FAIL → models_fail + error', () => {
  const err: AiPanelError = { code: 'E_AI_NETWORK', message: 'no net' };
  const s1 = run(AI_PANEL_INITIAL, { type: 'MODELS_FAIL', error: err });
  assert.equal(s1.status, 'models_fail');
  assert.equal(s1.error, err);
});

void test('SELECT_MODEL null → 清除选择', () => {
  const withSel: AiPanelState = { ...AI_PANEL_INITIAL, selectedModel: 'llama3' };
  const s1 = run(withSel, { type: 'SELECT_MODEL', model: null });
  assert.equal(s1.selectedModel, null);
});

// ─── 测试连接 ──────────────────────────────────────────────────────

void test('测试连接：START → OK / FAIL', () => {
  const s1 = run(AI_PANEL_INITIAL, { type: 'TEST_START' });
  assert.equal(s1.status, 'testing');
  assert.equal(s1.error, null);

  const s2 = run(s1, { type: 'TEST_OK' });
  assert.equal(s2.status, 'test_ok');
});

void test('RESET_ERROR 清除 error', () => {
  const withErr: AiPanelState = {
    ...AI_PANEL_INITIAL,
    error: { code: 'E_AI_TIMEOUT', message: 'x' },
  };
  const s1 = run(withErr, { type: 'RESET_ERROR' });
  assert.equal(s1.error, null);
});

// ─── A4：hydrate 保留 preset（CR-18 D4 回归）───────────────────────

void test('HYDRATE 保留 preset：openai-official / custom 不退回 Ollama', () => {
  const official = run(AI_PANEL_INITIAL, {
    type: 'HYDRATE',
    preset: 'openai-official',
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    allowInsecureHttp: false,
    model: 'gpt-4o',
  });
  assert.equal(official.preset, 'openai-official');
  assert.equal(official.provider, 'openai-compatible');
  assert.equal(official.baseUrl, 'https://api.openai.com/v1');
  assert.equal(official.allowInsecureHttp, false);
  assert.equal(official.selectedModel, 'gpt-4o');
  assert.notEqual(official.preset, 'ollama');

  const custom = run(AI_PANEL_INITIAL, {
    type: 'HYDRATE',
    preset: 'custom',
    provider: 'openai-compatible',
    baseUrl: 'http://10.0.0.1:8080/v1',
    allowInsecureHttp: true,
    model: 'local-model',
  });
  assert.equal(custom.preset, 'custom');
  assert.equal(custom.provider, 'openai-compatible');
  assert.equal(custom.selectedModel, 'local-model');
  assert.notEqual(custom.preset, 'ollama');
  assert.notEqual(custom.preset, 'openai-official');
});
