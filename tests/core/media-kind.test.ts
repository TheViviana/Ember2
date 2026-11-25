/**
 * CR-R1-6：core 媒体判型单一实现——库内宽表与 Finder 严格四容器两套语义并存。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FINDER_CONTAINER_EXTENSIONS, libraryMediaKind } from '../../src/core/media-kind.ts';
import type { LibraryMediaKind } from '../../src/core/media-kind.ts';
import { finderPathKind } from '../../src/app/dnd/finder-paths.ts';

void test('libraryMediaKind 宽表：7 个图片扩展、4 个容器扩展、doc 前缀、大小写、无扩展名', () => {
  const cases: ReadonlyArray<readonly [string, LibraryMediaKind | null]> = [
    ['a.jpg', 'image'],
    ['a.jpeg', 'image'],
    ['a.png', 'image'],
    ['a.gif', 'image'],
    ['a.webp', 'image'],
    ['a.avif', 'image'],
    ['a.heic', 'image'],
    ['a.mp3', 'audio'],
    ['a.m4a', 'audio'],
    ['a.mp4', 'video'],
    ['a.mov', 'video'],
    ['media/doc/x.pdf', 'doc'],
    ['media/image/a.PNG', 'image'],
    ['no-extension', null],
  ];
  for (const [path, expected] of cases) {
    assert.equal(libraryMediaKind(path), expected, path);
  }
});

void test('Finder 严格四容器与库内宽表是两套规则，不得统一', () => {
  assert.deepEqual(FINDER_CONTAINER_EXTENSIONS, ['mp3', 'm4a', 'mp4', 'mov']);
  assert.equal(finderPathKind('a.wav'), 'other');
  assert.equal(libraryMediaKind('media/audio/a.wav'), 'audio');
});
