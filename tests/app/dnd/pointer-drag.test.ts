import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  beginPointerDragSession,
  droppedPointerDrag,
  movePointerDragSession,
  POINTER_DRAG_THRESHOLD_PX,
  readPointerDragDropDetail,
} from '../../../src/app/dnd/pointer-drag.ts';

const DOC = { kind: 'doc', path: 'Notes/a.md' } as const;
const MEDIA = { kind: 'media', path: 'media/image/a.png' } as const;

void test('pointerdown 进入 pending，未达阈值不进入拖拽', () => {
  const session = beginPointerDragSession(DOC, 1, { x: 10, y: 10 });
  assert.equal(session.phase, 'pending');
  const moved = movePointerDragSession(session, 1, {
    x: 10 + POINTER_DRAG_THRESHOLD_PX - 1,
    y: 10,
  });
  assert.equal(moved?.phase, 'pending');
  assert.equal(droppedPointerDrag(moved, 1), null);
});

void test('达到阈值进入 dragging 并持续更新落点', () => {
  const session = beginPointerDragSession(DOC, 1, { x: 10, y: 10 });
  const started = movePointerDragSession(session, 1, { x: 10 + POINTER_DRAG_THRESHOLD_PX, y: 10 });
  assert.equal(started?.phase, 'dragging');
  if (started === null || started.phase !== 'dragging') return;
  assert.deepEqual(started.current, { x: 18, y: 10 });

  const moved = movePointerDragSession(started, 1, { x: 200, y: 140 });
  assert.equal(moved?.phase, 'dragging');
  assert.deepEqual(moved?.phase === 'dragging' ? moved.current : null, { x: 200, y: 140 });
  assert.deepEqual(droppedPointerDrag(moved, 1), DOC);
});

void test('斜向位移按欧氏距离判定阈值', () => {
  const session = beginPointerDragSession(DOC, 1, { x: 0, y: 0 });
  assert.equal(movePointerDragSession(session, 1, { x: 5, y: 5 })?.phase, 'pending');
  assert.equal(movePointerDragSession(session, 1, { x: 6, y: 6 })?.phase, 'dragging');
});

void test('非本会话指针的 move/up 被忽略', () => {
  const session = beginPointerDragSession(DOC, 1, { x: 0, y: 0 });
  assert.equal(movePointerDragSession(session, 2, { x: 100, y: 100 }), null);
  assert.equal(droppedPointerDrag(session, 2), null);
  assert.equal(droppedPointerDrag(null, 1), null);
});

void test('媒体卡片与文档行共用同一会话状态机，载荷原样保留', () => {
  const session = beginPointerDragSession(MEDIA, 7, { x: 0, y: 0 });
  const dragging = movePointerDragSession(session, 7, { x: 40, y: 40 });
  assert.deepEqual(droppedPointerDrag(dragging, 7), MEDIA);
});

void test('CustomEvent detail 守卫接受 doc/media/text/files，拒绝非法形状', () => {
  assert.deepEqual(readPointerDragDropDetail({ payload: DOC, clientX: 12, clientY: 34 }), {
    payload: DOC,
    clientX: 12,
    clientY: 34,
  });
  assert.deepEqual(readPointerDragDropDetail({ payload: MEDIA, clientX: 0, clientY: 0 }), {
    payload: MEDIA,
    clientX: 0,
    clientY: 0,
  });
  assert.equal(readPointerDragDropDetail(null), null);
  assert.equal(readPointerDragDropDetail('Notes/a.md'), null);
  assert.equal(readPointerDragDropDetail({ payload: DOC, clientX: '12', clientY: 34 }), null);
  assert.equal(readPointerDragDropDetail({ payload: DOC, clientX: Number.NaN, clientY: 34 }), null);
  assert.equal(readPointerDragDropDetail({ clientX: 12, clientY: 34 }), null);
  assert.deepEqual(
    readPointerDragDropDetail({ payload: { kind: 'text', text: 'x' }, clientX: 1, clientY: 2 }),
    { payload: { kind: 'text', text: 'x' }, clientX: 1, clientY: 2 },
  );
  assert.deepEqual(
    readPointerDragDropDetail({ payload: { kind: 'files', paths: ['/tmp/a.md'] }, clientX: 1, clientY: 2 }),
    { payload: { kind: 'files', paths: ['/tmp/a.md'] }, clientX: 1, clientY: 2 },
  );
  assert.equal(
    readPointerDragDropDetail({ payload: { kind: 'files', paths: [] }, clientX: 1, clientY: 2 }),
    null,
  );
  assert.equal(
    readPointerDragDropDetail({ payload: { kind: 'media', path: '' }, clientX: 1, clientY: 2 }),
    null,
  );
});
