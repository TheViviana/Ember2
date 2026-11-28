import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clampChunkChars,
  charBudgetFor,
  estimateChunkCount,
  LOCAL_CHAR_BUDGET,
  MAX_CHUNK_CHARS,
  MIN_CHUNK_CHARS,
  PUBLIC_CHAR_BUDGET,
} from '../../../src/features/ai/model-budget.ts';

void test('本地 provider 用保守预算，公网用较大预算', () => {
  assert.equal(charBudgetFor('ollama'), LOCAL_CHAR_BUDGET);
  assert.equal(charBudgetFor('openai-compatible-local'), LOCAL_CHAR_BUDGET);
  assert.equal(charBudgetFor('openai-compatible'), PUBLIC_CHAR_BUDGET);
});

void test('chunkChars 收进合法区间，非法值回退预算', () => {
  assert.equal(clampChunkChars(undefined, 'ollama'), LOCAL_CHAR_BUDGET);
  assert.equal(clampChunkChars(Number.NaN, 'openai-compatible'), PUBLIC_CHAR_BUDGET);
  assert.equal(clampChunkChars(100, 'ollama'), MIN_CHUNK_CHARS);
  assert.equal(clampChunkChars(1_000_000, 'ollama'), MAX_CHUNK_CHARS);
  assert.equal(clampChunkChars(8_000.9, 'ollama'), 8_000);
});

void test('块数预估覆盖空文本与边界值', () => {
  assert.equal(estimateChunkCount('', 8_000), 0);
  assert.equal(estimateChunkCount('a'.repeat(8_000), 8_000), 1);
  assert.equal(estimateChunkCount('a'.repeat(8_001), 8_000), 2);
});