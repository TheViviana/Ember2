/**
 * P6-C1-C：Finder 原生拖入的路径分流与落点语义（纯逻辑，无 DOM / IPC）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extensionFromPath,
  fileNameFromPath,
  finderPathKind,
  groupFinderPaths,
  mediaKindFromLibraryPath,
} from '../../../src/app/dnd/finder-paths.ts';
import { createDropTargetRegistry } from '../../../src/app/dnd/drop-targets.ts';
import { createAddMediaNodeCommand } from '../../../src/app/canvas/canvas-interactions.ts';

void test('.md 扩展名大小写归一化后判为 doc', () => {
  assert.equal(finderPathKind('notes/a.md'), 'doc');
  assert.equal(finderPathKind('/Users/zero/Notes/README.MD'), 'doc');
  assert.equal(finderPathKind('a.Md'), 'doc');
});

void test('图片扩展名判为 image', () => {
  const paths = ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.avif', 'g.HEIC'];
  for (const path of paths) {
    assert.equal(finderPathKind(path), 'image', path);
  }
});

void test('严格四容器判为 audio / video（大小写不敏感，CR-20261119-25）', () => {
  assert.equal(finderPathKind('a.mp3'), 'audio');
  assert.equal(finderPathKind('b.M4A'), 'audio');
  assert.equal(finderPathKind('c.mp4'), 'video');
  assert.equal(finderPathKind('d.MOV'), 'video');
});

void test('PDF/HTML/HTM 判为 attachment（大小写不敏感，CR-20261120-26）', () => {
  assert.equal(finderPathKind('a.pdf'), 'attachment');
  assert.equal(finderPathKind('b.HTML'), 'attachment');
  assert.equal(finderPathKind('c.Htm'), 'attachment');
  assert.equal(mediaKindFromLibraryPath('media/doc/ab/x.pdf'), 'doc');
  assert.equal(mediaKindFromLibraryPath('media/audio/ab/x.mp3'), 'audio');
});

void test('wav / flac / ogg / m4v / webm / docx 维持 other（其他格式不新增）', () => {
  const paths = ['a.wav', 'b.flac', 'c.ogg', 'd.m4v', 'e.webm', 'f.docx', 'g', '.md', 'h.tar.gz'];
  for (const path of paths) {
    assert.equal(finderPathKind(path), 'other', path);
  }
});

void test('反斜杠路径与多点文件名取扩展名正确', () => {
  assert.equal(fileNameFromPath('C:\\Users\\zero\\a.MD'), 'a.MD');
  assert.equal(extensionFromPath('C:\\Users\\zero\\a.MD'), 'md');
  assert.equal(extensionFromPath('archive.tar.gz'), 'gz');
  assert.equal(extensionFromPath('no-ext'), '');
});

void test('groupFinderPaths 按输入顺序分组且保留全部路径（含 audios/videos）', () => {
  const groups = groupFinderPaths(['a.png', 'b.md', 'c.pdf', 'd.JPG', 'e.mp3', 'f.mov']);
  assert.deepEqual(groups.docs, ['b.md']);
  assert.deepEqual(groups.images, ['a.png', 'd.JPG']);
  assert.deepEqual(groups.audios, ['e.mp3']);
  assert.deepEqual(groups.videos, ['f.mov']);
  assert.deepEqual(groups.attachments, ['c.pdf'], 'pdf 现为 attachment（CR-20261120-26）');
  assert.deepEqual(groups.others, []);
});

void test('mediaKindFromLibraryPath 优先类型分目录，其次扩展名，未知返回 null', () => {
  assert.equal(mediaKindFromLibraryPath('media/image/ab/hash.bin'), 'image');
  assert.equal(mediaKindFromLibraryPath('media/audio/ab/hash.bin'), 'audio');
  assert.equal(mediaKindFromLibraryPath('media/video/ab/hash.bin'), 'video');
  assert.equal(mediaKindFromLibraryPath('media/ab/hash.png'), 'image');
  assert.equal(mediaKindFromLibraryPath('media/ab/hash.WAV'), 'audio');
  assert.equal(mediaKindFromLibraryPath('media/ab/hash.webm'), 'video');
  assert.equal(mediaKindFromLibraryPath('media/ab/hash.bin'), null);
});

void test('doc-list 接受 files 并给出「文档导入尚未开放」提示', () => {
  const registry = createDropTargetRegistry();
  const decision = registry.resolve('doc-list', { kind: 'files', paths: ['a.md'] });
  if (!decision.accepted) assert.fail(`期望接受，实际拒绝：${decision.reason}`);
  assert.equal(decision.notice, '文档导入尚未开放');
  assert.deepEqual(decision.payload, { kind: 'files', paths: ['a.md'] });
});

void test('doc-list 拒绝非 files payload', () => {
  const registry = createDropTargetRegistry();
  const decision = registry.resolve('doc-list', { kind: 'doc', path: 'a.md' });
  if (decision.accepted) assert.fail('期望拒绝 doc payload');
  assert.equal(decision.reason, '此处仅支持文件');
});

void test('画布落点接受 Finder 分流出生的 doc 与 media payload', () => {
  const registry = createDropTargetRegistry();
  const doc = registry.resolve('canvas', { kind: 'doc', path: '/tmp/a.md' });
  const media = registry.resolve('canvas', {
    kind: 'media',
    path: 'media/image/ab/hash.png',
  });
  assert.equal(doc.accepted, true);
  assert.equal(media.accepted, true);
});

void test('createAddMediaNodeCommand 保留媒体结构且不补 schema 默认值', () => {
  const command = createAddMediaNodeCommand(10, 20, 'media/image/ab/hash.png', 'image');
  if (command.kind !== 'addNode') assert.fail(`期望 addNode，实际 ${command.kind}`);
  assert.match(command.node.id, /^n_/);
  assert.deepEqual(
    {
      x: command.node.x,
      y: command.node.y,
      type: command.node.type,
      kind: command.node.kind,
      path: command.node.path,
    },
    { x: 10, y: 20, type: 'media', kind: 'image', path: 'media/image/ab/hash.png' },
  );
  assert.equal('docPath' in command.node, false);
  assert.equal('ports' in command.node, false);
});
