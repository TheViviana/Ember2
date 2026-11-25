/**
 * doc-viewer：文档附件查看器映射（CR-20261120-27）。
 */
import assert from 'node:assert/strict';
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
