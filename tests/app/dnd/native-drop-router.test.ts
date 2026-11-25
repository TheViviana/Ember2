import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveNativeDropRoute, routeNativeDrop } from '../../../src/app/dnd/native-drop-router.ts';

const event = { paths: ['/tmp/a.md'], position: { x: 10, y: 20 } } as const;

void test('按真实落点区分文档列表、编辑器、画布与不支持区域', () => {
  const zone = (...matched: string[]) => ({
    closest: (selector: string) => (matched.includes(selector) ? {} : null),
  });
  assert.equal(resolveNativeDropRoute(event.paths, zone('[data-drop-zone="doc-list"]')), 'doc-list');
  assert.equal(resolveNativeDropRoute(event.paths, zone('[data-drop-zone="editor"]')), 'editor');
  assert.equal(resolveNativeDropRoute(event.paths, zone('[data-editor-drop-host]')), 'editor');
  assert.equal(resolveNativeDropRoute(event.paths, zone('[data-canvas-drop-host]')), 'canvas');
  assert.equal(resolveNativeDropRoute(event.paths, zone()), 'unsupported');
  assert.equal(resolveNativeDropRoute([], zone('[data-canvas-drop-host]')), 'empty');
});

void test('每条路由只调用一个处理器，空 paths 不产生动作', () => {
  const calls: string[] = [];
  const handlers = {
    onDocList: (paths: readonly string[]) => calls.push(`docs:${paths.length}`),
    onEditor: (paths: readonly string[]) => calls.push(`editor:${paths.length}`),
    onCanvas: () => calls.push('canvas'),
    onUnsupported: () => calls.push('unsupported'),
  };
  const docList = { closest: () => ({}) };
  assert.equal(routeNativeDrop(event, docList, handlers), 'doc-list');
  assert.equal(routeNativeDrop({ ...event, paths: [] }, docList, handlers), 'empty');
  assert.deepEqual(calls, ['docs:1']);

  const editor = { closest: (selector: string) => (selector === '[data-editor-drop-host]' ? {} : null) };
  assert.equal(routeNativeDrop(event, editor, handlers), 'editor');
  assert.deepEqual(calls, ['docs:1', 'editor:1']);
});
