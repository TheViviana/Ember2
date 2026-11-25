/**
 * CR-R2-5：文档正文读取两语义单源（纯逻辑，依赖注入）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readDocSnapshot, readDocText, type DocTextDeps } from '../../src/app/doc-text.ts';

function makeDeps(options: {
  live?: (path: string) => string | null;
  disk?: (path: string) => Promise<string>;
}) {
  const diskCalls: string[] = [];
  const liveCalls: string[] = [];
  const deps: DocTextDeps = {
    liveText: (path) => {
      liveCalls.push(path);
      return options.live ? options.live(path) : null;
    },
    readDisk: (path) => {
      diskCalls.push(path);
      return options.disk ? options.disk(path) : Promise.resolve(`disk:${path}`);
    },
  };
  return { deps, diskCalls, liveCalls };
}

void test('readDocText：已打开文档 live 优先，不读磁盘', async () => {
  const { deps, diskCalls } = makeDeps({ live: (path) => `live:${path}` });
  assert.equal(await readDocText('notes/a.md', deps), 'live:notes/a.md');
  assert.deepEqual(diskCalls, []);
});

void test('readDocText：未打开文档回退磁盘快照', async () => {
  const { deps, diskCalls } = makeDeps({});
  assert.equal(await readDocText('notes/b.md', deps), 'disk:notes/b.md');
  assert.deepEqual(diskCalls, ['notes/b.md']);
});

void test('readDocSnapshot：live 存在时仍只读磁盘', async () => {
  const { deps, diskCalls, liveCalls } = makeDeps({ live: () => 'live-text' });
  assert.equal(await readDocSnapshot('notes/c.md', deps), 'disk:notes/c.md');
  assert.deepEqual(diskCalls, ['notes/c.md']);
  assert.deepEqual(liveCalls, []);
});
