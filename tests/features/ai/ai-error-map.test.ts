import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapAiErrorCode } from '../../../src/features/ai/ai-error-map.ts';

// Rust src-tauri/src/ai/error.rs 定义的 14 个 E_AI_* 码
const RUST_CODES = [
  'E_AI_NOT_CONFIGURED',
  'E_AI_INVALID_ENDPOINT',
  'E_AI_KEY_MISSING',
  'E_AI_KEYCHAIN_DENIED',
  'E_AI_UNAUTHORIZED',
  'E_AI_RATE_LIMITED',
  'E_AI_TIMEOUT',
  'E_AI_CONNECT_TIMEOUT',
  'E_AI_NETWORK',
  'E_AI_MODEL_UNAVAILABLE',
  'E_AI_UNSUPPORTED_PROVIDER',
  'E_AI_INVALID_RESPONSE',
  'E_AI_RESPONSE_TOO_LARGE',
  'E_AI_CANCELLED',
] as const;

void test('14 个 E_AI_* 码全部有映射（无 undefined 返回）', () => {
  for (const code of RUST_CODES) {
    const result = mapAiErrorCode(code);
    assert.ok(result.text.length > 0, `${code} 映射文案不能为空`);
    assert.ok(['info', 'warning', 'error'].includes(result.tone), `${code} tone 非法: ${result.tone}`);
  }
});

void test('未知码回退 error + 包含原始码', () => {
  const r = mapAiErrorCode('E_AI_SOME_NEW_CODE', 'raw detail');
  assert.equal(r.tone, 'error');
  assert.ok(r.text.includes('E_AI_SOME_NEW_CODE'), '未知码应包含原始码');
  assert.ok(r.text.includes('raw detail'), '未知码应包含 rawMessage');
});

void test('code undefined / 空 → 通用错误', () => {
  const r1 = mapAiErrorCode(undefined, '网络断了');
  assert.equal(r1.tone, 'error');
  assert.ok(r1.text.includes('网络断了'));

  const r2 = mapAiErrorCode('');
  assert.equal(r2.tone, 'error');
  assert.ok(r2.text.includes('未知错误'));
});

void test('tone 分配合理', () => {
  // info
  assert.equal(mapAiErrorCode('E_AI_CANCELLED').tone, 'info');

  // warning（非阻塞类）
  const warningCodes = [
    'E_AI_NOT_CONFIGURED',
    'E_AI_KEYCHAIN_DENIED',
    'E_AI_RATE_LIMITED',
    'E_AI_TIMEOUT',
    'E_AI_MODEL_UNAVAILABLE',
    'E_AI_RESPONSE_TOO_LARGE',
  ];
  for (const code of warningCodes) {
    assert.equal(mapAiErrorCode(code).tone, 'warning', `${code} 应为 warning`);
  }

  // error（阻塞类）
  const errorCodes = [
    'E_AI_INVALID_ENDPOINT',
    'E_AI_KEY_MISSING',
    'E_AI_UNAUTHORIZED',
    'E_AI_CONNECT_TIMEOUT',
    'E_AI_NETWORK',
    'E_AI_UNSUPPORTED_PROVIDER',
    'E_AI_INVALID_RESPONSE',
  ];
  for (const code of errorCodes) {
    assert.equal(mapAiErrorCode(code).tone, 'error', `${code} 应为 error`);
  }
});

void test('关键码文案内容', () => {
  const r = mapAiErrorCode('E_AI_KEYCHAIN_DENIED');
  assert.ok(r.text.includes('内存'), 'KeychainDenied 应提到内存降级');

  const r2 = mapAiErrorCode('E_AI_UNAUTHORIZED');
  assert.ok(r2.text.includes('401') || r2.text.includes('403'), 'Unauthorized 应提到 HTTP 码');

  const r3 = mapAiErrorCode('E_AI_INVALID_ENDPOINT');
  assert.ok(r3.text.includes('不安全 HTTP'), 'InvalidEndpoint 应提到 allowInsecureHttp');
});
