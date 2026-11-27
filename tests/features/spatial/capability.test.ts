/**
 * 空间工作区能力检测：工厂注入、渲染器读取与软件渲染识别。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  detectSpatialCapability,
  isSoftwareRenderer,
  type SpatialGlContext,
} from '../../../src/features/spatial/capability.ts';

const UNMASKED_RENDERER = 37446;

function contextWith(extension: unknown, renderer: unknown): SpatialGlContext {
  return {
    getExtension(): unknown {
      return extension;
    },
    getParameter(parameter: number): unknown {
      assert.equal(parameter, UNMASKED_RENDERER);
      return renderer;
    },
  };
}

void test('无法创建 WebGL2 上下文时判定不可用', () => {
  const capability = detectSpatialCapability(() => null);
  assert.deepEqual(capability, { webgl2: false, renderer: null, software: false });
});

void test('缺少调试扩展时只报告 WebGL2 可用', () => {
  const capability = detectSpatialCapability(() => contextWith(null, null));
  assert.deepEqual(capability, { webgl2: true, renderer: null, software: false });
});

void test('读取 UNMASKED_RENDERER 字符串', () => {
  const capability = detectSpatialCapability(() =>
    contextWith({ UNMASKED_RENDERER_WEBGL: UNMASKED_RENDERER }, 'Apple M2'),
  );
  assert.deepEqual(capability, { webgl2: true, renderer: 'Apple M2', software: false });
});

void test('渲染器不是字符串时按未知处理', () => {
  const capability = detectSpatialCapability(() =>
    contextWith({ UNMASKED_RENDERER_WEBGL: UNMASKED_RENDERER }, 42),
  );
  assert.equal(capability.renderer, null);
});

void test('检测过程抛错时按不可用降级', () => {
  const capability = detectSpatialCapability((): SpatialGlContext | null => {
    throw new Error('context denied');
  });
  assert.deepEqual(capability, { webgl2: false, renderer: null, software: false });
});

void test('软件渲染标记不区分大小写', () => {
  assert.equal(isSoftwareRenderer('Google SwiftShader'), true);
  assert.equal(isSoftwareRenderer('llvmpipe (LLVM 17.0)'), true);
  assert.equal(isSoftwareRenderer('ANGLE (Apple, Apple M2)'), false);
  assert.equal(isSoftwareRenderer(null), false);
});

void test('检测结果把软件渲染标记为 software', () => {
  const capability = detectSpatialCapability(() =>
    contextWith({ UNMASKED_RENDERER_WEBGL: UNMASKED_RENDERER }, 'Software Rasterizer'),
  );
  assert.equal(capability.webgl2, true);
  assert.equal(capability.software, true);
});