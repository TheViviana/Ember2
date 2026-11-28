/** 可见连线的短光段：独立 Canvas/RAF，不驱动网格、节点或静态边刷新。 */
import type { ScreenEdge } from './edge-layout.ts';
import { themeColors } from './canvas-palette.ts';
import type { Point, ViewportSize } from './viewport.ts';

export const EDGE_PULSE_SEGMENT_PX = 56;
export const EDGE_PULSE_SPEED_PX_PER_SECOND = 96;
const SAMPLE_STEPS = 32;

export interface EdgeSample {
  readonly points: readonly Point[];
  readonly cumulative: readonly number[];
  readonly length: number;
}

function cubic(a: number, b: number, c: number, d: number, t: number): number {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
}

/** 屏幕几何不可变；调用方可用 WeakMap<ScreenEdge, EdgeSample> 按对象身份缓存。 */
export function sampleScreenEdge(edge: ScreenEdge): EdgeSample {
  const points: Point[] = [];
  if (!edge.straight && edge.points !== undefined && edge.points.length >= 2) {
    /* 直角折线：顶点即采样点，按折线累计弧长跑光段。 */
    points.push(...edge.points);
  } else {
    const steps = edge.straight ? 1 : SAMPLE_STEPS;
    for (let index = 0; index <= steps; index += 1) {
      const t = index / steps;
      points.push({
        x: cubic(edge.p0.x, edge.c1.x, edge.c2.x, edge.p3.x, t),
        y: cubic(edge.p0.y, edge.c1.y, edge.c2.y, edge.p3.y, t),
      });
    }
  }
  const cumulative: number[] = [0];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous === undefined || current === undefined) continue;
    cumulative.push((cumulative[index - 1] ?? 0) + Math.hypot(current.x - previous.x, current.y - previous.y));
  }
  return { points, cumulative, length: cumulative.at(-1) ?? 0 };
}

function pointAt(sample: EdgeSample, distance: number): Point {
  const fallback = sample.points[0] ?? { x: 0, y: 0 };
  if (sample.length <= 0) return fallback;
  const target = Math.max(0, Math.min(sample.length, distance));
  let low = 0;
  let high = sample.cumulative.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((sample.cumulative[middle] ?? 0) < target) low = middle;
    else high = middle - 1;
  }
  const index = Math.min(sample.points.length - 2, Math.max(0, low));
  const start = sample.points[index] ?? fallback;
  const end = sample.points[index + 1] ?? start;
  const from = sample.cumulative[index] ?? 0;
  const to = sample.cumulative[index + 1] ?? from;
  const ratio = to === from ? 0 : (target - from) / (to - from);
  return { x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio };
}

/** 截取一段弧长；光段进入/离开视口时裁在 p0/p3，不绕回形成逆向跳段。 */
export function sliceEdgeSample(sample: EdgeSample, from: number, to: number): readonly Point[] {
  const start = Math.max(0, Math.min(sample.length, from));
  const end = Math.max(0, Math.min(sample.length, to));
  if (sample.length <= 0 || end <= start) return [];
  const points: Point[] = [pointAt(sample, start)];
  for (let index = 1; index < sample.points.length - 1; index += 1) {
    const distance = sample.cumulative[index] ?? 0;
    const point = sample.points[index];
    if (point !== undefined && distance > start && distance < end) points.push(point);
  }
  points.push(pointAt(sample, end));
  return points;
}

function stablePhase(id: string, cycle: number): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  }
  return ((hash >>> 0) / 4294967296) * cycle;
}

/** 光段头部位置；取值范围 [-segment, total]，完整离开 p3 后才重新进入 p0。 */
export function edgePulseDistance(id: string, elapsedMs: number, totalLength: number): number {
  if (totalLength <= 0) return 0;
  const cycle = totalLength + EDGE_PULSE_SEGMENT_PX;
  const travelled = stablePhase(id, cycle) + Math.max(0, elapsedMs) * EDGE_PULSE_SPEED_PX_PER_SECOND / 1000;
  return (travelled % cycle) - EDGE_PULSE_SEGMENT_PX;
}

export function edgePulseSegment(sample: EdgeSample, id: string, elapsedMs: number): readonly Point[] {
  const head = edgePulseDistance(id, elapsedMs, sample.length);
  return sliceEdgeSample(sample, head - EDGE_PULSE_SEGMENT_PX, head);
}

export interface EdgePulseEnvironment {
  readonly hidden: boolean;
  readonly focused: boolean;
  readonly reducedMotion: boolean;
}

export interface EdgePulseLoopOptions {
  readonly requestFrame: (callback: FrameRequestCallback) => number;
  readonly cancelFrame: (id: number) => void;
  readonly readEnvironment: () => EdgePulseEnvironment;
  readonly clear: () => void;
  readonly draw: (elapsedMs: number) => void;
}

/** 生命周期单独可测：恢复首帧 delta=0，不补算隐藏/失焦期间的时间。 */
export function createEdgePulseLoop(options: EdgePulseLoopOptions) {
  let active = false;
  let disposed = false;
  let frame: number | null = null;
  let previousTimestamp: number | null = null;
  let elapsed = 0;

  const canRun = (): boolean => {
    const environment = options.readEnvironment();
    return active && !environment.hidden && environment.focused && !environment.reducedMotion;
  };
  const stop = (): void => {
    if (frame !== null) options.cancelFrame(frame);
    frame = null;
    previousTimestamp = null;
    options.clear();
  };
  const schedule = (): void => {
    if (frame === null && !disposed && canRun()) frame = options.requestFrame(step);
  };
  const sync = (): void => {
    if (disposed) return;
    if (!canRun()) {
      stop();
      return;
    }
    if (frame === null) previousTimestamp = null;
    schedule();
  };
  const step: FrameRequestCallback = (timestamp) => {
    frame = null;
    if (disposed || !canRun()) {
      stop();
      return;
    }
    if (previousTimestamp !== null) elapsed += Math.max(0, Math.min(64, timestamp - previousTimestamp));
    previousTimestamp = timestamp;
    options.draw(elapsed);
    schedule();
  };

  return {
    setActive(next: boolean): void {
      active = next;
      sync();
    },
    sync,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      active = false;
      stop();
    },
  };
}

export type EdgePulseLoop = ReturnType<typeof createEdgePulseLoop>;

export interface EdgePulseLayer {
  readonly element: HTMLCanvasElement;
  resize(size: ViewportSize, dpr: number): void;
  setEdges(edges: readonly ScreenEdge[]): void;
  dispose(): void;
}

export function createEdgePulseLayer(className: string): EdgePulseLayer {
  const element = document.createElement('canvas');
  element.className = className;
  element.dataset.layer = 'edge-pulse';
  element.setAttribute('aria-hidden', 'true');
  const context = element.getContext('2d');
  if (context === null) throw new Error('无法创建连线动效 Canvas 2D 上下文');
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const samples = new WeakMap<ScreenEdge, EdgeSample>();
  let edges: readonly ScreenEdge[] = [];
  let size: ViewportSize = { width: 1, height: 1 };
  let dpr = 1;

  const clear = (): void => {
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, size.width, size.height);
  };
  const draw = (elapsedMs: number): void => {
    clear();
    const colors = themeColors();
    context.lineCap = 'round';
    context.lineJoin = 'round';
    for (const edge of edges) {
      let sample = samples.get(edge);
      if (sample === undefined) {
        sample = sampleScreenEdge(edge);
        samples.set(edge, sample);
      }
      const points = edgePulseSegment(sample, edge.id, elapsedMs);
      if (points.length < 2) continue;
      context.beginPath();
      const first = points[0];
      if (first === undefined) continue;
      context.moveTo(first.x, first.y);
      for (let index = 1; index < points.length; index += 1) {
        const point = points[index];
        if (point !== undefined) context.lineTo(point.x, point.y);
      }
      context.strokeStyle = colors.edgePulseGlow;
      context.lineWidth = 8;
      context.stroke();
      context.strokeStyle = colors.edgePulse;
      context.lineWidth = 2;
      context.stroke();
    }
  };
  const loop = createEdgePulseLoop({
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (id) => cancelAnimationFrame(id),
    readEnvironment: () => ({ hidden: document.hidden, focused: document.hasFocus(), reducedMotion: motion.matches }),
    clear,
    draw,
  });
  const sync = (): void => loop.sync();
  window.addEventListener('focus', sync);
  window.addEventListener('blur', sync);
  document.addEventListener('visibilitychange', sync);
  motion.addEventListener('change', sync);

  return {
    element,
    resize(next, nextDpr): void {
      size = next;
      dpr = Math.max(1, nextDpr);
      const width = Math.max(1, Math.round(next.width * dpr));
      const height = Math.max(1, Math.round(next.height * dpr));
      if (element.width !== width) element.width = width;
      if (element.height !== height) element.height = height;
      clear();
      loop.sync();
    },
    setEdges(next): void {
      edges = next;
      loop.setActive(next.length > 0);
    },
    dispose(): void {
      loop.dispose();
      window.removeEventListener('focus', sync);
      window.removeEventListener('blur', sync);
      document.removeEventListener('visibilitychange', sync);
      motion.removeEventListener('change', sync);
      element.remove();
    },
  };
}
