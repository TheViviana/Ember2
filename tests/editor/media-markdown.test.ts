/**
 * C1-D D-b/D-c：编辑器 Markdown 引用生成、载荷读取与六类拖放裁决。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EDITOR_DND_MIME,
  mediaKindFromLibraryPath,
  mediaLabelFromPath,
  mediaMarkdown,
  planEditorDrop,
  readMediaDropPayload,
} from '../../src/editor/drop.ts';

function reader(custom: string, fallback = ''): (format: string) => string {
  return (format: string): string => {
    if (format === EDITOR_DND_MIME) return custom;
    return fallback;
  };
}

const imageJson = JSON.stringify({ kind: 'media', path: 'media/image/abc.png' });
const audioJson = JSON.stringify({ kind: 'media', path: 'media/audio/song.mp3' });
const unknownJson = JSON.stringify({ kind: 'media', path: 'media/other/blob' });

void test('文件名作标签；空路径回退原文', () => {
  assert.equal(mediaLabelFromPath('media/image/abc.png'), 'abc.png');
  assert.equal(mediaLabelFromPath(''), '');
});

void test('图片用 ![]()，音频与无法判型用普通链接', () => {
  assert.equal(mediaMarkdown('media/image/abc.png', 'image'), '![abc.png](media/image/abc.png)');
  assert.equal(mediaMarkdown('media/audio/song.mp3', 'audio'), '[song.mp3](media/audio/song.mp3)');
  assert.equal(mediaMarkdown('media/other/blob', null), '[blob](media/other/blob)');
});

void test('媒体类型先按目录前缀、再按扩展名兜底', () => {
  assert.equal(mediaKindFromLibraryPath('media/image/a.png'), 'image');
  assert.equal(mediaKindFromLibraryPath('media/audio/a.dat'), 'audio');
  assert.equal(mediaKindFromLibraryPath('media/video/a.dat'), 'video');
  assert.equal(mediaKindFromLibraryPath('media/other/song.mp3'), 'audio');
  assert.equal(mediaKindFromLibraryPath('media/other/blob'), null);
});

void test('读取：自定义 MIME 优先，非 media 类型与空数据显式拒绝', () => {
  const media = readMediaDropPayload(reader(imageJson));
  assert.deepEqual(media, { ok: true, path: 'media/image/abc.png', kind: 'image' });

  const empty = readMediaDropPayload(reader(''));
  assert.deepEqual(empty, { ok: false, reason: '拖拽数据为空', tone: 'error' });

  const plain = readMediaDropPayload(reader('', 'just text'));
  assert.deepEqual(plain, { ok: false, reason: '此处仅支持媒体插入', tone: 'warning' });

  const otherKind = readMediaDropPayload(
    reader(JSON.stringify({ kind: 'canvas-node', nodeId: 'n1', canvasId: 'c1' })),
  );
  assert.deepEqual(otherKind, { ok: false, reason: '此处仅支持媒体插入', tone: 'warning' });

  const missingPath = readMediaDropPayload(reader(JSON.stringify({ kind: 'media' })));
  assert.deepEqual(missingPath, { ok: false, reason: '媒体路径缺失', tone: 'error' });
});

void test('只读态优先拦截，且不产生插入内容', () => {
  const outcome = planEditorDrop(true, readMediaDropPayload(reader(imageJson)));
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.message, '编辑器只读，无法插入');
  assert.equal(outcome.tone, 'warning');
});

void test('读取失败按原 tone 透出提示', () => {
  const outcome = planEditorDrop(false, readMediaDropPayload(reader('')));
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.message, '拖拽数据为空');
  assert.equal(outcome.tone, 'error');
});

void test('图片/音频按库内相对路径插入，不转 media://', () => {
  const imageOutcome = planEditorDrop(false, readMediaDropPayload(reader(imageJson)));
  assert.equal(imageOutcome.ok, true);
  if (!imageOutcome.ok) return;
  assert.equal(imageOutcome.plan.insert, '![abc.png](media/image/abc.png)');
  assert.equal(imageOutcome.plan.mediaKind, 'image');
  assert.equal(imageOutcome.plan.notice, undefined);

  const audioOutcome = planEditorDrop(false, readMediaDropPayload(reader(audioJson)));
  assert.equal(audioOutcome.ok, true);
  if (!audioOutcome.ok) return;
  assert.equal(audioOutcome.plan.insert, '[song.mp3](media/audio/song.mp3)');
  assert.equal(audioOutcome.plan.mediaKind, 'audio');
});

void test('无法判型仍插入普通链接，并附带一次提示', () => {
  const outcome = planEditorDrop(false, readMediaDropPayload(reader(unknownJson)));
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.plan.mediaKind, null);
  assert.equal(outcome.plan.insert, '[blob](media/other/blob)');
  assert.deepEqual(outcome.plan.notice, {
    message: '无法判定媒体类型，已按普通链接插入',
    tone: 'warning',
  });
});
