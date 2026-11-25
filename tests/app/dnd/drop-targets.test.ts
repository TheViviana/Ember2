import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDropTargetRegistry,
  DEFAULT_DROP_TARGETS,
} from '../../../src/app/dnd/drop-targets.ts';
import type { DndPayload } from '../../../src/app/dnd/protocol.ts';

const registry = createDropTargetRegistry();

const DOC: DndPayload = { kind: 'doc', path: 'a.md' };
const MEDIA: DndPayload = { kind: 'media', path: 'm.png' };
const NODE: DndPayload = { kind: 'canvas-node', nodeId: 'n1', canvasId: 'c1' };
const TEXT: DndPayload = { kind: 'text', text: 'hi' };
const FILES: DndPayload = { kind: 'files', paths: ['a.md'] };

void test('画布空白接受 doc / media / text / files', () => {
  for (const payload of [DOC, MEDIA, TEXT, FILES]) {
    const decision = registry.resolve('canvas', payload);
    assert.equal(decision.accepted, true);
    if (decision.accepted) assert.deepEqual(decision.payload, payload);
  }
});

void test('画布空白拒绝 canvas-node 并给出原因', () => {
  const decision = registry.resolve('canvas', NODE);
  assert.equal(decision.accepted, false);
  if (!decision.accepted) assert.equal(decision.reason, '不支持的类型');
});

void test('画布节点接受 doc / media / text / files（D11）', () => {
  for (const payload of [DOC, MEDIA, TEXT, FILES]) {
    const decision = registry.resolve('canvas-node', payload);
    assert.equal(decision.accepted, true);
    if (decision.accepted) assert.deepEqual(decision.payload, payload);
  }
});

void test('画布节点拒绝 canvas-node 并给出原因', () => {
  const decision = registry.resolve('canvas-node', NODE);
  assert.equal(decision.accepted, false);
  if (!decision.accepted) assert.equal(decision.reason, '该内容不能放到节点上');
});

void test('文档列表仅接受 files，并附带「文档导入尚未开放」提示', () => {
  const accepted = registry.resolve('doc-list', FILES);
  assert.equal(accepted.accepted, true);
  if (accepted.accepted) assert.equal(accepted.notice, '文档导入尚未开放');

  for (const payload of [DOC, MEDIA, NODE, TEXT]) {
    const rejected = registry.resolve('doc-list', payload);
    assert.equal(rejected.accepted, false);
    if (!rejected.accepted) assert.equal(rejected.reason, '此处仅支持文件');
  }
});

void test('编辑器仅接受 media，其余给出插入提示', () => {
  const accepted = registry.resolve('editor', MEDIA);
  assert.equal(accepted.accepted, true);
  if (accepted.accepted) assert.equal(accepted.notice, undefined);

  for (const payload of [DOC, NODE, TEXT, FILES]) {
    const rejected = registry.resolve('editor', payload);
    assert.equal(rejected.accepted, false);
    if (!rejected.accepted) assert.equal(rejected.reason, '此处仅支持媒体插入');
  }
});

void test('未注册的落点显式拒绝', () => {
  const empty = createDropTargetRegistry([]);
  const decision = empty.resolve('canvas', DOC);
  assert.equal(decision.accepted, false);
  if (!decision.accepted) assert.match(decision.reason, /未知的落点/);
});

void test('注册表可按自定义 specs 覆盖默认语义', () => {
  const custom = createDropTargetRegistry([
    { id: 'editor', accepts: ['text'], rejectReason: '仅文本' },
  ]);
  const accepted = custom.resolve('editor', TEXT);
  assert.equal(accepted.accepted, true);
  const rejected = custom.resolve('editor', MEDIA);
  assert.equal(rejected.accepted, false);
});

void test('get 与 list 返回注册内容', () => {
  assert.equal(registry.get('canvas')?.id, 'canvas');
  assert.equal(registry.get('canvas-node')?.id, 'canvas-node');
  assert.equal(registry.list().length, DEFAULT_DROP_TARGETS.length);
});
