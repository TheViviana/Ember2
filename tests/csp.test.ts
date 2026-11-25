import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { EDITOR_STYLE_NONCE } from '../src/editor/csp-nonce.ts';

/**
 * PLAN.md §8：CSP 与 index.html 内联样式哈希的一致性必须由测试保证，
 * 不允许「声明一个哈希、实际内容是另一个」的静默漂移。
 */
function inlineStyleSource(): string {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const m = html.match(/<style>([\s\S]*?)<\/style>/);
  const source = m?.[1];
  assert.ok(source, 'index.html 必须包含首帧内联样式块');
  return source;
}

function declaredHash(): string {
  const m = cspParts('csp').match(/'sha256-([^']+)'/);
  const hash = m?.[1];
  assert.ok(hash, '生产 CSP 必须登记内联样式 sha256');
  return hash;
}

function cspParts(kind: 'csp' | 'devCsp'): string {
  const conf = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8')) as {
    app: { security: { csp: string; devCsp: string } };
  };
  return conf.app.security[kind];
}

void test('生产 CSP 登记的内联样式哈希 === index.html 实际样式内容', () => {
  const actual = createHash('sha256').update(inlineStyleSource()).digest('base64');
  assert.equal(actual, declaredHash(), '哈希漂移：改 index.html 内联样式后必须同步 tauri.conf.json 的 sha256');
});

void test('生产 CSP：script-src 必须恰好是 self（无 unsafe-inline/eval，防可预测 nonce/哈希旁路）', () => {
  const scriptSrc = cspParts('csp').match(/script-src\s+([^;]+);/)?.[1];
  assert.equal(scriptSrc?.trim(), "'self'", 'script-src 只允许 self');
});

void test('生产 CSP：style-src-elem 登记固定 nonce（CodeMirror style-mod，已接线）与哈希', () => {
  const styleElem = cspParts('csp').match(/style-src-elem\s+([^;]+);/)?.[1];
  assert.ok(styleElem, '必须声明 style-src-elem');
  // 固定 nonce 是 PLAN §8 写死的有意折衷（CodeMirror style-mod 注入 <style> 需要，script-src 'self' 不受影响）；
  // 2026-11-23 起 EditorView 通过 EditorView.cspNonce facet 真正把 nonce 交给 style-mod（下方接线测试钉死）。
  assert.ok(styleElem.includes('nonce-'), '必须含固定 nonce（CodeMirror style-mod 注入 <style> 使用）');
  assert.ok(styleElem.includes("'sha256-"), '必须含内联样式哈希');
});

void test('生产 CSP 的 style nonce 与 CodeMirror 接线完全一致（打包版回归钉）', () => {
  const declared = cspParts('csp').match(/'nonce-([^']+)'/)?.[1];
  assert.ok(declared, '生产 CSP 必须声明 style-src-elem 固定 nonce');
  assert.equal(
    EDITOR_STYLE_NONCE,
    declared,
    'editor/csp-nonce.ts 必须与 tauri.conf.json 的 nonce 字节一致，否则 style-mod 注入被拦截',
  );

  const source = readFileSync(new URL('../src/editor/EditorView.tsx', import.meta.url), 'utf8');
  assert.match(
    source,
    /CodeMirrorView\.cspNonce\.of\(EDITOR_STYLE_NONCE\)/,
    '编辑器扩展必须把 nonce 交给 style-mod（CodeMirrorView.cspNonce facet）',
  );
});

void test('devCsp 媒体两指令与生产对齐（样式策略 dev 有意用 unsafe-inline 供 HMR，生产差异在 P5 复检单列实测）', () => {
  const dev = cspParts('devCsp');
  const imgSrc = dev.match(/img-src\s+([^;]+);/)?.[1];
  const mediaSrc = dev.match(/media-src\s+([^;]+);/)?.[1];
  assert.ok(imgSrc?.includes('blob:') && imgSrc.includes('media:'), 'devCsp img-src 需要 blob: 与 media:');
  assert.ok(mediaSrc?.includes('media:') && mediaSrc.includes('blob:'), 'devCsp media-src 需要 media: 与 blob:');
});

void test('CSP 为 P1 媒体协议预留 media:/blob:（img-src 与 media-src）', () => {
  const csp = cspParts('csp');
  const imgSrc = csp.match(/img-src\s+([^;]+);/)?.[1];
  const mediaSrc = csp.match(/media-src\s+([^;]+);/)?.[1];
  assert.ok(imgSrc, '必须声明 img-src');
  assert.ok(mediaSrc, '必须声明 media-src（音频/视频 P1 起走 media:// 协议）');
  assert.ok(imgSrc.includes('blob:'), 'img-src 需要 blob:（缩略图）');
  assert.ok(imgSrc.includes('media:'), 'img-src 需要 media:（图片走自定义协议）');
  assert.ok(mediaSrc.includes('media:') && mediaSrc.includes('blob:'), 'media-src 需要 media: 与 blob:');
});
