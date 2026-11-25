/**
 * doc-viewer：文档附件查看器映射（CR-20261120-27）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { docViewerFor } from '../../../src/features/media/doc-viewer.ts';

void test('pdf / html / htm → 查看器目标', () => {
  assert.deepEqual(docViewerFor('media/doc/ab/a.pdf'), { kind: 'pdf' });
  assert.deepEqual(docViewerFor('media/doc/ab/b.html'), { kind: 'html' });
  assert.deepEqual(docViewerFor('media/doc/ab/c.htm'), { kind: 'html' });
});

void test('大小写不敏感 + 反斜杠路径', () => {
  assert.deepEqual(docViewerFor('media/doc/ab/A.PDF'), { kind: 'pdf' });
  assert.deepEqual(docViewerFor('media\\doc\\ab\\B.HTML'), { kind: 'html' });
});

void test('其它扩展名 / 无扩展名 / 隐藏文件 → null', () => {
  assert.equal(docViewerFor('media/image/ab/x.png'), null);
  assert.equal(docViewerFor('media/doc/ab/x.docx'), null);
  assert.equal(docViewerFor('media/doc/ab/no-ext'), null);
  assert.equal(docViewerFor('media/doc/ab/.hidden'), null);
  assert.equal(docViewerFor(''), null);
});

void test('文档查看器容器与 iframe 均有完整尺寸样式', () => {
  const css = readFileSync(
    new URL('../../../src/app/panels/media-library.module.css', import.meta.url),
    'utf8',
  );
  const box = /\.docViewerBox\s*\{[\s\S]*?\}/.exec(css)?.[0] ?? '';
  const frame = /\.docViewerFrame\s*\{[\s\S]*?\}/.exec(css)?.[0] ?? '';
  assert.match(box, /width:\s*min\(920px, 100%\)/);
  assert.match(box, /height:\s*min\(720px, 100%\)/);
  assert.match(frame, /width:\s*100%/);
  assert.match(frame, /height:\s*100%/);
});

void test('Finder 的 PDF/HTML 附件与音视频共用入库建节点链路', () => {
  const source = readFileSync(
    new URL('../../../src/app/canvas/CanvasView.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /\[\.\.\.images, \.\.\.audios, \.\.\.videos, \.\.\.attachments\]/);
  assert.doesNotMatch(source, /附件（PDF\/HTML）入媒体库「文档」tab，不建画布节点/);
});
