import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMacPlatform, isWindowsPlatform } from '../../src/core/platform.ts';
import { mediaUrlForPath } from '../../src/core/media-url.ts';

void test('Windows 用 http://media.localhost，macOS/Linux 保持 media://', () => {
  assert.equal(
    mediaUrlForPath('media/image/ab/cat.png', true),
    'http://media.localhost/media/image/ab/cat.png',
  );
  assert.equal(
    mediaUrlForPath('media/image/ab/cat.png', false),
    'media://localhost/media/image/ab/cat.png',
  );
});

void test('媒体 URL 在两种协议下都逐段编码并保留分层', () => {
  const path = 'media/image/ab/旧 图.png';
  assert.equal(
    mediaUrlForPath(path, true),
    'http://media.localhost/media/image/ab/%E6%97%A7%20%E5%9B%BE.png',
  );
  assert.equal(
    mediaUrlForPath(path, false),
    'media://localhost/media/image/ab/%E6%97%A7%20%E5%9B%BE.png',
  );
});

void test('平台判定识别 Windows 与 macOS，Node 环境默认按 macOS', () => {
  assert.equal(isWindowsPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), true);
  assert.equal(isWindowsPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), false);
  assert.equal(isMacPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), false);
  assert.equal(isMacPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), true);
  assert.equal(isWindowsPlatform(), false);
  assert.equal(isMacPlatform(), true);
});
