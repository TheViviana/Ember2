import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bytesToBase64,
  clipboardImageFiles,
  pastedImageMarkdown,
  type ClipboardDataLike,
} from '../../src/editor/paste.ts';

function fakeFile(type: string): File {
  return { type } as File;
}

void test('优先读取剪贴板 files 中的图片，过滤非图片', () => {
  const image = fakeFile('image/png');
  const audio = fakeFile('audio/mpeg');
  const data: ClipboardDataLike = { files: [image, audio] };
  assert.deepEqual(clipboardImageFiles(data), [image]);
});

void test('files 为空时回退到 items，仅接受 file 类型', () => {
  const image = fakeFile('image/jpeg');
  const data: ClipboardDataLike = {
    files: [],
    items: [
      { kind: 'string', type: 'text/plain', getAsFile: () => null },
      { kind: 'file', type: 'image/jpeg', getAsFile: () => image },
      { kind: 'file', type: 'image/gif', getAsFile: () => null },
    ],
  };
  assert.deepEqual(clipboardImageFiles(data), [image]);
  assert.deepEqual(clipboardImageFiles(null), []);
});

void test('大图分块编码不丢字节', () => {
  const bytes = new Uint8Array(100_000);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
  const encoded = bytesToBase64(bytes);
  assert.equal(encoded.length, Math.ceil(bytes.length / 3) * 4);
  assert.equal(encoded.endsWith('=') || encoded.endsWith('==') || encoded.endsWith('0'), true);
  assert.equal(new TextDecoder().decode(Uint8Array.from(Buffer.from(encoded, 'base64'))), new TextDecoder().decode(bytes));
});

void test('多图按行拼接为图片引用', () => {
  assert.equal(
    pastedImageMarkdown(['media/ab/cd.png', 'media/ef/gh.jpg']),
    '![cd.png](media/ab/cd.png)\n![gh.jpg](media/ef/gh.jpg)',
  );
});
