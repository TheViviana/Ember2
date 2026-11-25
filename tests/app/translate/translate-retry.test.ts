/**
 * 2026-11-23：长文翻译的段数上限、自动重试与从失败段续译（源码不变量）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = process.cwd();
const store = readFileSync(join(ROOT, 'src/app/translate/translate-store.ts'), 'utf8');

void test('AI 翻译链：失败自动重试一次，仍失败保留 resumeRun 闭包', () => {
  assert.match(store, /for \(let attempt = 0; attempt < 2; attempt \+= 1\)/);
  assert.match(store, /globalThis\.setTimeout\(resolveDelay, 400\)/);
  assert.match(store, /resumeRun: \(\) => \{/);
  assert.match(store, /runChunks\(failedIndex\)/);
});

void test('续译从失败段开始，读取最新 AI 配置，进度基于已成功段', () => {
  assert.match(store, /const runChunks = \(startIndex: number\)/);
  assert.match(store, /let done = get\(\)\.segments\.length/);
  assert.match(store, /useAiChatStore\.getState\(\)\.config/);
  assert.match(store, /resume: \(\) => \{/);
});

void test('段数上限已提高到 1000', () => {
  const core = readFileSync(join(ROOT, 'src/core/translate-segments.ts'), 'utf8');
  assert.match(core, /MAX_TRANSLATE_SEGMENTS = 1000/);
});
