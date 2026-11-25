import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScreenEdge } from '../../../src/app/canvas/edge-layout.ts';
import {
  createEdgePulseLoop,
  EDGE_PULSE_SEGMENT_PX,
  EDGE_PULSE_SPEED_PX_PER_SECOND,
  edgePulseDistance,
  edgePulseSegment,
  sampleScreenEdge,
  sliceEdgeSample,
  type EdgePulseEnvironment,
} from '../../../src/app/canvas/edge-pulse.ts';

function lineEdge(id = 'edge'): ScreenEdge {
  return {
    id,
    straight: true,
    p0: { x: 0, y: 10 },
    c1: { x: 30, y: 10 },
    c2: { x: 70, y: 10 },
    p3: { x: 100, y: 10 },
    aabb: { left: 0, top: 10, right: 100, bottom: 10 },
  };
}

function close(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 0.000001, `${actual} != ${expected}`);
}

void test('采样保持 p0 → p3，弧长截段插值且不改变方向', () => {
  const sample = sampleScreenEdge(lineEdge());
  assert.equal(sample.length, 100);
  assert.deepEqual(sample.points[0], { x: 0, y: 10 });
  assert.deepEqual(sample.points.at(-1), { x: 100, y: 10 });
  const points = sliceEdgeSample(sample, 20, 60);
  assert.deepEqual(points.map((point) => point.x), [20, 60]);
  assert.deepEqual(sliceEdgeSample(sample, -10, 0), []);
  assert.deepEqual(sliceEdgeSample(sample, 100, 120), []);
});

void test('光段相位由稳定 id 决定，并始终沿源到目标前进', () => {
  const sample = sampleScreenEdge(lineEdge());
  const cycle = sample.length + EDGE_PULSE_SEGMENT_PX;
  const initial = edgePulseDistance('edge', 0, sample.length);
  const elapsed = (((70 - initial + cycle) % cycle) / EDGE_PULSE_SPEED_PX_PER_SECOND) * 1000;
  const first = edgePulseSegment(sample, 'edge', elapsed);
  const later = edgePulseSegment(sample, 'edge', elapsed + 100);
  close(first[0]?.x ?? -1, 70 - EDGE_PULSE_SEGMENT_PX);
  close(first.at(-1)?.x ?? -1, 70);
  close((later.at(-1)?.x ?? -1) - (first.at(-1)?.x ?? -1), EDGE_PULSE_SPEED_PX_PER_SECOND / 10);
  assert.notEqual(edgePulseDistance('edge-a', 0, 200), edgePulseDistance('edge-b', 0, 200));
  assert.deepEqual(edgePulseSegment(sampleScreenEdge(lineEdge('same')), 'same', 500), edgePulseSegment(sampleScreenEdge(lineEdge('same')), 'same', 500));
});

void test('暂停、失焦、减少动态效果与销毁都停帧；恢复不补时间', () => {
  const callbacks = new Map<number, FrameRequestCallback>();
  const draws: number[] = [];
  const environment: { current: EdgePulseEnvironment } = {
    current: { hidden: false, focused: true, reducedMotion: false },
  };
  let sequence = 0;
  let clears = 0;
  const loop = createEdgePulseLoop({
    requestFrame(callback): number {
      sequence += 1;
      callbacks.set(sequence, callback);
      return sequence;
    },
    cancelFrame(id): void {
      callbacks.delete(id);
    },
    readEnvironment: () => environment.current,
    clear: () => { clears += 1; },
    draw: (elapsed) => { draws.push(elapsed); },
  });
  const fire = (timestamp: number): void => {
    const first = callbacks.entries().next().value;
    assert.ok(first !== undefined);
    callbacks.delete(first[0]);
    first[1](timestamp);
  };

  loop.setActive(true);
  assert.equal(callbacks.size, 1);
  fire(100);
  fire(116);
  assert.deepEqual(draws, [0, 16]);

  environment.current = { ...environment.current, hidden: true };
  loop.sync();
  assert.equal(callbacks.size, 0);
  environment.current = { ...environment.current, hidden: false };
  loop.sync();
  fire(9000);
  assert.deepEqual(draws, [0, 16, 16], '隐藏恢复首帧不补 8884ms');

  environment.current = { ...environment.current, focused: false };
  loop.sync();
  assert.equal(callbacks.size, 0);
  environment.current = { ...environment.current, focused: true };
  loop.sync();
  fire(12000);
  fire(12016);
  assert.deepEqual(draws, [0, 16, 16, 16, 32]);

  environment.current = { ...environment.current, reducedMotion: true };
  loop.sync();
  assert.equal(callbacks.size, 0);
  environment.current = { ...environment.current, reducedMotion: false };
  loop.sync();
  fire(20000);
  assert.equal(draws.at(-1), 32);
  assert.ok(clears >= 3);

  loop.dispose();
  assert.equal(callbacks.size, 0);
  loop.sync();
  loop.setActive(true);
  assert.equal(callbacks.size, 0);
});

void test('空可见边集合不启动 RAF，并清除旧光斑', () => {
  let scheduled = 0;
  let clears = 0;
  const loop = createEdgePulseLoop({
    requestFrame: () => { scheduled += 1; return 1; },
    cancelFrame: () => undefined,
    readEnvironment: () => ({ hidden: false, focused: true, reducedMotion: false }),
    clear: () => { clears += 1; },
    draw: () => undefined,
  });
  loop.setActive(false);
  assert.equal(scheduled, 0);
  assert.equal(clears, 1);
  loop.dispose();
});
