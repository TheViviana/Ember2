import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  insertMediaIntoEditor,
  registerEditorMediaInserter,
} from '../../src/editor/media-insert-registry.ts';
import { planEditorDrop } from '../../src/editor/drop.ts';

const media = { kind: 'image' as const, path: 'media/image/ab/hash.png', label: 'cat.png' };
const point = { x: 20, y: 30 };

void test('按浮窗 id 路由媒体插入；旧注销函数不会误删新回调', () => {
  const received: string[] = [];
  const unregisterOld = registerEditorMediaInserter('registry-test.md', () => {
    received.push('old');
  });
  const unregisterCurrent = registerEditorMediaInserter('registry-test.md', (inserted, at) => {
    received.push(`${inserted.label}@${at.x},${at.y}`);
  });
  unregisterOld();

  assert.equal(insertMediaIntoEditor('registry-test.md', media, point), true);
  assert.deepEqual(received, ['cat.png@20,30']);
  unregisterCurrent();
  assert.equal(insertMediaIntoEditor('missing.md', media, point), false);
  assert.equal(insertMediaIntoEditor('registry-test.md', media, point), false);
});

void test('画布事件携带的节点标签用于 Markdown 引用', () => {
  const outcome = planEditorDrop(false, { ok: true, ...media });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.plan.insert, '![cat.png](media/image/ab/hash.png)');
});
