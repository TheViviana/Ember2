import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mediaMarkdown } from '../../src/editor/drop.ts';

void test('mediaMarkdown：标签方括号与反斜杠不会破坏链接文字', () => {
  const markdown = mediaMarkdown(
    'media/image/plain.png',
    'image',
    String.raw`a[b]\c.png`,
  );
  assert.equal(markdown, String.raw`![a\[b\]\\c.png](media/image/plain.png)`);
});

void test('mediaMarkdown：目标路径括号与反斜杠不会截断链接目标', () => {
  const markdown = mediaMarkdown(
    String.raw`media/audio/a(b)\c.mp3`,
    'audio',
    'clip.mp3',
  );
  assert.equal(markdown, String.raw`[clip.mp3](media/audio/a\(b\)\\c.mp3)`);
});
