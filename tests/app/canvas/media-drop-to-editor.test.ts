import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createInteractionState,
  reduceInteraction,
  type InteractionState,
} from '../../../src/app/canvas/interaction.ts';
import type { CanvasNodeView } from '../../../src/app/canvas/node-layout.ts';

const mediaNode: CanvasNodeView = {
  type: 'media',
  id: 'm',
  label: 'cat.png',
  x: 0,
  y: 0,
  media: { kind: 'image', path: 'media/image/ab/hash.png' },
};

function dragging(node: CanvasNodeView): InteractionState {
  const started = reduceInteraction(createInteractionState(), {
    type: 'pointerDown',
    point: { x: 10, y: 10 },
    button: 0,
    shiftKey: false,
    toggleKey: false,
    altKey: false,
    pan: false,
    target: { kind: 'node', id: node.id },
    nodes: [node],
  });
  return reduceInteraction(started.state, {
    type: 'pointerMove',
    point: { x: 40, y: 50 },
    scale: 1,
  }).state;
}

void test('单个媒体节点落入编辑器：还原位置并发出媒体事件，不提交移动', () => {
  const ended = reduceInteraction(dragging(mediaNode), {
    type: 'pointerUp',
    point: { x: 40, y: 50 },
    scale: 1,
    editorDrop: { windowId: 'notes/a.md', clientPoint: { x: 400, y: 500 } },
  });

  assert.equal(ended.effects.some((effect) => effect.type === 'commit'), false);
  const preview = ended.effects.find((effect) => effect.type === 'preview');
  assert.deepEqual(preview?.positions, [mediaNode]);
  const drop = ended.effects.find((effect) => effect.type === 'mediaDropToEditor');
  assert.deepEqual(drop, {
    type: 'mediaDropToEditor',
    windowId: 'notes/a.md',
    clientPoint: { x: 400, y: 500 },
    kind: 'image',
    path: 'media/image/ab/hash.png',
    label: 'cat.png',
  });
  assert.equal(ended.state.gesture, null);
});

void test('同一媒体手势未命中编辑器时仍正常提交移动', () => {
  const ended = reduceInteraction(dragging(mediaNode), {
    type: 'pointerUp',
    point: { x: 40, y: 50 },
    scale: 1,
  });
  const commit = ended.effects.find((effect) => effect.type === 'commit');
  assert.deepEqual(commit?.command, {
    kind: 'move',
    entries: [{ id: 'm', dx: 30, dy: 40 }],
  });
  assert.equal(ended.effects.some((effect) => effect.type === 'mediaDropToEditor'), false);
});

void test('非媒体节点命中编辑器不转为插入，仍提交移动', () => {
  const textNode: CanvasNodeView = { type: 'text', id: 't', label: '文本', x: 0, y: 0 };
  const ended = reduceInteraction(dragging(textNode), {
    type: 'pointerUp',
    point: { x: 40, y: 50 },
    scale: 1,
    editorDrop: { windowId: 'notes/a.md', clientPoint: { x: 400, y: 500 } },
  });
  assert.equal(ended.effects.some((effect) => effect.type === 'mediaDropToEditor'), false);
  assert.equal(ended.effects.some((effect) => effect.type === 'commit'), true);
});

void test('文档附件节点命中编辑器不按音视频插入，仍提交移动', () => {
  const docNode: CanvasNodeView = {
    type: 'media',
    id: 'd',
    label: '参考.pdf',
    x: 0,
    y: 0,
    media: { kind: 'doc', path: 'media/doc/ab/reference.pdf' },
  };
  const ended = reduceInteraction(dragging(docNode), {
    type: 'pointerUp',
    point: { x: 40, y: 50 },
    scale: 1,
    editorDrop: { windowId: 'notes/a.md', clientPoint: { x: 400, y: 500 } },
  });
  assert.equal(ended.effects.some((effect) => effect.type === 'mediaDropToEditor'), false);
  assert.equal(ended.effects.some((effect) => effect.type === 'commit'), true);
});
