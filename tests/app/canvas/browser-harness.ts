/**
 * C2/C3 浏览器验收页（手动或自动化打开，不进 CI）：真实 DOM 证四件事——
 * 1. 「viewport 内唯一挂载点」：world 是 viewport 的直接子元素、节点层是 world 的唯一子元素；
 * 2. 节点 local 坐标的屏幕落点等于三式 `absolute * s + tx`（origin 折入容器）；
 * 3. C3 四层 z 序：grid → edges → world 节点 → highlight，选中高亮不被节点截断；
 * 4. C3 命中测试入口（CSS px）：连线中点命中、远处不命中。
 *
 * 性能采样改为三档：C2 无连线（500 节点）、C3 有连线（500 节点 500 边）、
 * C3 1000 边；每档 10 s 脚本化平移缩放，输出 rAF 间隔分位数、掉帧数与 edge 绘制耗时。
 *
 * 结果回传方式见 CR-20261117-02 §13.2：先启动
 *   node tests/app/canvas/serve-harness.mjs --out /tmp/ember-harness.json
 * 再 `pnpm vite --port 5199`，打开本页；脚本零依赖，不进 CI。
 */
import { CanvasEngine, type CanvasDocumentStore } from '../../../src/app/canvas/engine.ts';

/** 结果回传地址；可用 `?result=http://127.0.0.1:5202/result` 覆盖，避免多个窗口互相覆盖同一份结果。 */
const RESULT_ENDPOINT =
  new URL(window.location.href).searchParams.get('result') ?? 'http://127.0.0.1:5200/result';
const DURATION_MS = 10_000;
/** 纯 rAF 基线时长：只跑空帧，用于区分「引擎/画布负载」与「窗口/引擎节流」。 */
const RAW_RAF_MS = 3_000;
/** 掉帧判据：超过 1.5 个刷新间隔才算掉一帧，避免把 120 Hz 正常抖动算成掉帧。 */
const DROP_FACTOR = 1.5;

/** 窗口状态快照：Q1 判定「30 Hz 是环境节流还是产品限制」的唯一依据。 */
function snapshotEnv(): Record<string, unknown> {
  return {
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    dpr: window.devicePixelRatio,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
  };
}

/**
 * 纯 rAF 基线：不建引擎、不画任何东西，只量空帧间隔。
 * 若这里也是 30 Hz，则 30 Hz 与画布、与 C3 无关（窗口/WebKit 节流）。
 */
async function measureRawRaf(): Promise<Record<string, number | boolean | string>> {
  const env = snapshotEnv();
  const intervals: number[] = [];
  let last = performance.now();
  const start = last;
  await new Promise<void>((resolve) => {
    const tick = (now: number): void => {
      intervals.push(now - last);
      last = now;
      if (now - start >= RAW_RAF_MS) {
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const frames = intervals.slice(1).sort((a, b) => a - b);
  const p50 = percentile(frames, 0.5);
  return {
    frames: frames.length,
    p50,
    p95: percentile(frames, 0.95),
    refreshHz: p50 === 0 ? 0 : round(1000 / p50),
    focusedAtStart: env.focused === true,
    visibilityAtStart: String(env.visibility),
  };
}

interface OpenResult {
  readonly exists: boolean;
  readonly text: string | null;
  readonly sha256: string;
  readonly modifiedMs: number | null;
}

interface HarnessStore extends CanvasDocumentStore {
  readonly savedTexts: readonly string[];
}

function createStore(text: string | null): HarnessStore {
  const savedTexts: string[] = [];
  return {
    savedTexts,
    open(): Promise<OpenResult> {
      return Promise.resolve({
        exists: text !== null,
        text,
        sha256: '',
        modifiedMs: null,
      });
    },
    save(_id: string, next: string): Promise<{ ok: boolean }> {
      savedTexts.push(next);
      return Promise.resolve({ ok: true });
    },
    flush(): Promise<{ ok: boolean; timedOut: boolean; error: null }> {
      return Promise.resolve({ ok: true, timedOut: false, error: null });
    },
    beginClosing(): void {
      /* 验收页不触发关闭 */
    },
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function makeHost(width: number, height: number): HTMLDivElement {
  const host = document.createElement('div');
  host.style.width = `${width}px`;
  host.style.height = `${height}px`;
  document.body.append(host);
  return host;
}

const STRUCTURE_DOC = JSON.stringify({
  schemaVersion: 3,
  lastOrigin: { x: 24, y: 48 },
  nodes: [
    { id: 'a', label: 'A', x: 124, y: 148 },
    { id: 'b', label: 'B', x: 24, y: 48 },
  ],
  edges: [],
});

/** 结构验收：唯一挂载点 + local 坐标的屏幕落点。 */
async function checkMount(): Promise<Record<string, unknown>> {
  const host = makeHost(800, 600);
  const engine = new CanvasEngine({ host, store: createStore(STRUCTURE_DOC), canvasId: 'structure' });
  await engine.mount();
  await nextFrame();

  const world = engine.getWorldElement();
  const nodeLayer = world.children.item(0);
  const nodes = nodeLayer === null ? [] : [...nodeLayer.children];
  const first = nodes[0];
  const hostRect = host.getBoundingClientRect();
  const firstRect = first?.getBoundingClientRect() ?? null;

  const result = {
    worldParentIsHost: world.parentElement === host,
    hostChildCount: host.children.length,
    worldChildCount: world.children.length,
    nodeCount: nodes.length,
    nodeIds: [...(nodeLayer?.children ?? [])].map((node) => (node as HTMLElement).dataset.nodeId ?? ''),
    nodeLeft: first instanceof HTMLElement ? first.style.left : null,
    nodeTop: first instanceof HTMLElement ? first.style.top : null,
    nodeScreenLeft: firstRect === null ? null : round(firstRect.left - hostRect.left),
    nodeScreenTop: firstRect === null ? null : round(firstRect.top - hostRect.top),
  };

  await engine.dispose();
  host.remove();
  return result;
}

function makeNodes(
  count: number,
  stepX: number,
  stepY: number,
): readonly Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  for (let index = 0; index < count; index += 1) {
    nodes.push({
      id: `n${index}`,
      label: `N${index}`,
      x: (index % 25) * stepX,
      y: Math.floor(index / 25) * stepY,
    });
  }
  return nodes;
}

/** 确定性边集：`i → 7i+1` 模节点数，跨行分布，避免全落到同一条水平线。 */
function makeEdges(edgeCount: number, nodeCount: number): readonly Record<string, unknown>[] {
  const edges: Record<string, unknown>[] = [];
  for (let index = 0; index < edgeCount; index += 1) {
    const from = index % nodeCount;
    let to = (index * 7 + 1) % nodeCount;
    if (to === from) to = (to + 1) % nodeCount;
    edges.push({
      id: `e${index}`,
      from: { nodeId: `n${from}`, portId: 'out' },
      to: { nodeId: `n${to}`, portId: 'in' },
    });
  }
  return edges;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/** 读 canvas 单点 alpha（入参 CSS px，内部换算设备 px）。 */
function alphaAt(canvas: HTMLCanvasElement, cssX: number, cssY: number): number {
  const context = canvas.getContext('2d');
  if (context === null) return -1;
  const rect = canvas.getBoundingClientRect();
  const ratioX = canvas.width / Math.max(1, rect.width);
  const ratioY = canvas.height / Math.max(1, rect.height);
  return context.getImageData(
    Math.round(cssX * ratioX),
    Math.round(cssY * ratioY),
    1,
    1,
  ).data[3] ?? 0;
}

const EDGE_DOC = JSON.stringify({
  schemaVersion: 3,
  nodes: [
    { id: 'a', label: 'A', x: 100, y: 200 },
    { id: 'b', label: 'B', x: 400, y: 200 },
  ],
  edges: [
    { id: 'e1', from: { nodeId: 'a', portId: 'out' }, to: { nodeId: 'b', portId: 'in' } },
  ],
});

/** C3 验收：四层 z 序、高亮画在世界层之上、命中测试入口。 */
async function checkEdgeLayers(): Promise<Record<string, unknown>> {
  const host = makeHost(800, 600);
  const engine = new CanvasEngine({ host, store: createStore(EDGE_DOC), canvasId: 'edges' });
  await engine.mount();
  await nextFrame();

  const layers = [...host.children].map((child) => (child as HTMLElement).dataset.layer ?? '');
  const edgeCanvas = host.querySelector<HTMLCanvasElement>('[data-layer="edges"]');
  const highlightCanvas = host.querySelector<HTMLCanvasElement>('[data-layer="highlight"]');
  const edgeAlpha = edgeCanvas === null ? -1 : alphaAt(edgeCanvas, 330, 248);

  engine.setSelectedEdges(['e1']);
  await nextFrame();
  const highlightAlpha = highlightCanvas === null ? -1 : alphaAt(highlightCanvas, 330, 248);

  const hit = engine.hitTestEdge({ x: 330, y: 248 });
  const miss = engine.hitTestEdge({ x: 330, y: 400 });
  const result = {
    layers,
    edgeBelowWorld: layers.indexOf('edges') < layers.indexOf('world'),
    highlightAboveWorld: layers.indexOf('highlight') > layers.indexOf('world'),
    edgeAlpha,
    highlightAlpha,
    hitEdgeId: hit?.edgeId ?? null,
    missIsNull: miss === null,
    warning: engine.getEdgeWarning(),
  };

  await engine.dispose();
  host.remove();
  return result;
}

const INTERACTION_DOC = JSON.stringify({
  schemaVersion: 3,
  nodes: [
    { id: 'a', label: 'A', x: 100, y: 200 },
    { id: 'b', label: 'B', x: 400, y: 200 },
    { id: 'c', label: 'C', x: 400, y: 400 },
  ],
  edges: [
    { id: 'e1', from: { nodeId: 'a', portId: 'out' }, to: { nodeId: 'b', portId: 'in' } },
    { id: 'e2', from: { nodeId: 'a', portId: 'out' }, to: { nodeId: 'c', portId: 'in' } },
  ],
});

/** 合成 PointerEvent 没有活动指针；仅 harness 禁用 capture，事件仍走 viewport 的真实监听器。 */
function allowSyntheticPointers(host: HTMLDivElement): void {
  host.setPointerCapture = () => undefined;
  host.releasePointerCapture = () => undefined;
  host.hasPointerCapture = () => false;
}

function sendPointer(
  host: HTMLDivElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  x: number,
  y: number,
): void {
  const rect = host.getBoundingClientRect();
  host.dispatchEvent(new PointerEvent(type, {
    pointerId: 7,
    pointerType: 'mouse',
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    clientX: rect.left + x,
    clientY: rect.top + y,
    bubbles: true,
    cancelable: true,
  }));
}

function savedNodePosition(text: string, id: string): { x: number; y: number } | null {
  const document = JSON.parse(text) as {
    nodes: readonly { id: string; x: number; y: number }[];
  };
  const node = document.nodes.find((candidate) => candidate.id === id);
  return node === undefined ? null : { x: node.x, y: node.y };
}

/** C4 DOM 验收：多选、拖拽历史、Esc、框选、保存 drain 与 Q2-B 的 gridDraws。 */
async function checkInteractions(): Promise<Record<string, unknown>> {
  const host = makeHost(800, 600);
  allowSyntheticPointers(host);
  const store = createStore(INTERACTION_DOC);
  const engine = new CanvasEngine({ host, store, canvasId: 'interactions' });
  await engine.mount();
  await nextFrame();
  const initialGridDraws = engine.getFrameStats().gridDraws;

  engine.setSelectedEdges(['e1', 'e2']);
  await nextFrame();
  const multiEdgeSelection = [...engine.getSelection().edges].sort();

  sendPointer(host, 'pointerdown', 110, 210);
  sendPointer(host, 'pointermove', 150, 240);
  sendPointer(host, 'pointerup', 150, 240);
  await nextFrame();
  const afterMove = savedNodePosition(engine.serialize(), 'a');
  const selectedNode = host.querySelector<HTMLElement>('[data-node-id="a"]');
  const selectedOutline = selectedNode?.dataset.selected === 'true';
  const selectionBoxUnchanged = selectedNode?.style.width === '' && selectedNode.style.height === '';

  const undoAccepted = engine.undo();
  const afterUndo = savedNodePosition(engine.serialize(), 'a');
  const redoAccepted = engine.redo();
  const afterRedo = savedNodePosition(engine.serialize(), 'a');

  sendPointer(host, 'pointerdown', 150, 240);
  sendPointer(host, 'pointermove', 190, 270);
  host.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  }));
  await nextFrame();
  const afterEscape = savedNodePosition(engine.serialize(), 'a');

  sendPointer(host, 'pointerdown', 20, 20);
  sendPointer(host, 'pointermove', 500, 330);
  sendPointer(host, 'pointerup', 500, 330);
  await nextFrame();
  const marqueeNodes = [...engine.getSelection().nodes].sort();
  const marqueeEdges = [...engine.getSelection().edges];
  const marqueeRemoved = host.querySelector('[data-layer="marquee"]') === null;
  const finalGridDraws = engine.getFrameStats().gridDraws;
  const readOnly = engine.isReadOnly();

  await engine.dispose();
  const savedPosition = savedNodePosition(store.savedTexts.at(-1) ?? engine.serialize(), 'a');
  host.remove();
  return {
    multiEdgeSelection,
    afterMove,
    selectedOutline,
    selectionBoxUnchanged,
    undoAccepted,
    afterUndo,
    redoAccepted,
    afterRedo,
    afterEscape,
    marqueeNodes,
    marqueeEdges,
    marqueeRemoved,
    gridDrawsDuringInteractions: finalGridDraws - initialGridDraws,
    saveCalls: store.savedTexts.length,
    savedPosition,
    readOnly,
    pass: {
      multiEdgeSelection: multiEdgeSelection.join(',') === 'e1,e2',
      moveCommit: afterMove?.x === 140 && afterMove.y === 230,
      undoRedo:
        undoAccepted && redoAccepted &&
        afterUndo?.x === 100 && afterUndo.y === 200 &&
        afterRedo?.x === 140 && afterRedo.y === 230,
      escape: afterEscape?.x === 140 && afterEscape.y === 230,
      marquee:
        marqueeNodes.join(',') === 'a,b' && marqueeEdges.length === 0 && marqueeRemoved,
      gridSkip: finalGridDraws === initialGridDraws,
      save: savedPosition?.x === 140 && savedPosition.y === 230,
    },
  };
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return round(sorted[index] ?? 0);
}

/**
 * 10 s 脚本化平移 + 缩放。
 *
 * 口径：
 * - `refresh` = 帧间隔中位数（本机刷新率实测），`budget` = refresh * 1.5；
 * - `dropped` = 间隔超过 budget 的帧数，`dropRate` 用百分比保留两位；
 * - 长任务走 PerformanceObserver `longtask`（浏览器只上报 ≥ 50 ms 的任务），
 *   因此 `longTaskCount = 0` 表示「没有 ≥ 50 ms 的任务」，不是「任务耗时 0」；
 * - `edgeMs*` 取 `engine.getFrameStats().edges`（连线 + 高亮绘制耗时，ms）；
 * - 有连线时节点间距收紧到 56×48，保证视口内确实有大量可见边（裁剪不是白跑）。
 */
async function measure(
  count: number,
  edgeCount: number,
): Promise<Record<string, number | boolean | string>> {
  const dense = edgeCount > 0;
  const env = snapshotEnv();
  const host = makeHost(1280, 720);
  const engine = new CanvasEngine({
    host,
    store: createStore(
      JSON.stringify({
        schemaVersion: 3,
        nodes: makeNodes(count, dense ? 56 : 192, dense ? 48 : 120),
        edges: makeEdges(edgeCount, count),
      }),
    ),
    canvasId: `perf-${count}-${edgeCount}`,
  });
  await engine.mount();

  const intervals: number[] = [];
  const gridCosts: number[] = [];
  const worldCosts: number[] = [];
  const edgeCosts: number[] = [];
  const nodeCosts: number[] = [];
  const longTasks: number[] = [];
  const supported = PerformanceObserver.supportedEntryTypes.includes('longtask');
  const observer = supported ? new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push(entry.duration);
  }) : null;
  observer?.observe({ entryTypes: ['longtask'] });

  let last = performance.now();
  const start = last;
  await new Promise<void>((resolve) => {
    const tick = (now: number): void => {
      intervals.push(now - last);
      const frame = engine.getFrameStats();
      gridCosts.push(frame.grid);
      worldCosts.push(frame.world);
      edgeCosts.push(frame.edges);
      nodeCosts.push(frame.nodes);
      last = now;
      const elapsed = now - start;
      host.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: Math.sin(elapsed / 250) * 120,
          clientX: 640 + Math.sin(elapsed / 300) * 200,
          clientY: 360,
          bubbles: true,
          cancelable: true,
        }),
      );
      host.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: Math.sin(elapsed / 400) > 0 ? 'ArrowRight' : 'ArrowLeft',
          bubbles: true,
          cancelable: true,
        }),
      );
      if (elapsed >= DURATION_MS) {
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  observer?.disconnect();
  const warned = engine.getEdgeWarning() === null ? 0 : 1;
  const finalFrameStats = engine.getFrameStats();
  await engine.dispose();
  host.remove();

  const frames = intervals.slice(1).sort((a, b) => a - b);
  const grids = gridCosts.slice(1).sort((a, b) => a - b);
  const worlds = worldCosts.slice(1).sort((a, b) => a - b);
  const costs = edgeCosts.slice(1).sort((a, b) => a - b);
  const nodes = nodeCosts.slice(1).sort((a, b) => a - b);
  const refresh = percentile(frames, 0.5);
  const budget = refresh * DROP_FACTOR;
  const dropped = frames.filter((value) => value > budget).length;
  return {
    nodes: count,
    edges: edgeCount,
    frames: frames.length,
    gridMsP50: percentile(grids, 0.5),
    gridMsP95: percentile(grids, 0.95),
    worldMsP50: percentile(worlds, 0.5),
    worldMsP95: percentile(worlds, 0.95),
    edgeMsP50: percentile(costs, 0.5),
    edgeMsP95: percentile(costs, 0.95),
    edgeMsMax: costs.length === 0 ? 0 : round(costs[costs.length - 1] ?? 0),
    nodesMsP50: percentile(nodes, 0.5),
    nodesMsP95: percentile(nodes, 0.95),
    gridDraws: finalFrameStats.gridDraws,
    degenerateFrames: finalFrameStats.degenerateFrames,
    budgetWarnings: warned,
    refreshHz: refresh === 0 ? 0 : round(1000 / refresh),
    p50: refresh,
    p95: percentile(frames, 0.95),
    p99: percentile(frames, 0.99),
    budget: round(budget),
    dropped,
    dropRate: round((dropped / Math.max(1, frames.length)) * 10000) / 100,
    longTaskCount: longTasks.length,
    maxLongTask: longTasks.length === 0 ? 0 : round(Math.max(...longTasks)),
    focusedAtStart: env.focused === true,
    visibilityAtStart: String(env.visibility),
  };
}

/** C4 拖拽档：固定相机，确保 gridDraws 不增长；JS 口径包含输入回调与对应 draw。 */
async function measureDrag(): Promise<Record<string, number | boolean | string>> {
  const env = snapshotEnv();
  const host = makeHost(1280, 720);
  allowSyntheticPointers(host);
  const engine = new CanvasEngine({
    host,
    store: createStore(JSON.stringify({
      schemaVersion: 3,
      nodes: makeNodes(500, 56, 48),
      edges: makeEdges(500, 500),
    })),
    canvasId: 'c4-drag-500-500',
  });
  await engine.mount();
  await nextFrame();

  const initialStats = engine.getFrameStats();
  const gridCosts: number[] = [];
  const worldCosts: number[] = [];
  const edgeCosts: number[] = [];
  const nodeCosts: number[] = [];
  let point = { x: 20, y: 20 };
  sendPointer(host, 'pointerdown', point.x, point.y);
  const start = performance.now();

  await new Promise<void>((resolve) => {
    const tick = (now: number): void => {
      const frame = engine.getFrameStats();
      gridCosts.push(frame.grid);
      worldCosts.push(frame.world);
      edgeCosts.push(frame.edges);
      nodeCosts.push(frame.nodes);
      const elapsed = now - start;
      point = {
        x: 20 + (Math.sin(elapsed / 700) * 0.5 + 0.5) * 300,
        y: 20 + (Math.cos(elapsed / 900) * 0.5 + 0.5) * 200,
      };
      sendPointer(host, 'pointermove', point.x, point.y);
      if (elapsed >= DURATION_MS) {
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  sendPointer(host, 'pointerup', point.x, point.y);
  await nextFrame();
  const telemetry = engine.getDragTelemetry();
  const finalStats = engine.getFrameStats();
  await engine.dispose();
  host.remove();

  const dragJs = [...telemetry.dragJsSamples].sort((a, b) => a - b);
  const hitTests = [...telemetry.hitTestSamples].sort((a, b) => a - b);
  const grids = gridCosts.slice(1).sort((a, b) => a - b);
  const worlds = worldCosts.slice(1).sort((a, b) => a - b);
  const edges = edgeCosts.slice(1).sort((a, b) => a - b);
  const nodes = nodeCosts.slice(1).sort((a, b) => a - b);
  const dragJsP95 = percentile(dragJs, 0.95);
  const dragEdgeP95 = percentile(edges, 0.95);
  return {
    nodes: 500,
    edges: 500,
    dragJsP50: percentile(dragJs, 0.5),
    dragJsP95,
    dragEdgeP50: percentile(edges, 0.5),
    dragEdgeP95,
    gridMsP95: percentile(grids, 0.95),
    worldMsP95: percentile(worlds, 0.95),
    nodesMsP95: percentile(nodes, 0.95),
    hitTestP95: percentile(hitTests, 0.95),
    dragFrames: telemetry.dragFrames,
    degenerateFrames: finalStats.degenerateFrames - initialStats.degenerateFrames,
    gridDraws: finalStats.gridDraws,
    gridDrawsDuringDrag: finalStats.gridDraws - initialStats.gridDraws,
    pass6ms: dragJsP95 <= 6,
    edgeWithin3ms: dragEdgeP95 <= 3,
    focusedAtStart: env.focused === true,
    visibilityAtStart: String(env.visibility),
  };
}

function show(text: string): void {
  const result = document.querySelector('#result');
  if (result !== null) result.textContent = text;
}

async function main(): Promise<void> {
  const structure = await checkMount();
  const edgeLayers = await checkEdgeLayers();
  const interactions = await checkInteractions();
  const rawRaf = await measureRawRaf();
  const perf = {
    c2_500_0: await measure(500, 0),
    c3_500_500: await measure(500, 500),
    c3_500_1000: await measure(500, 1000),
    c4_drag_500_500: await measureDrag(),
  };
  const payload = {
    structure,
    edgeLayers,
    interactions,
    env: snapshotEnv(),
    rawRaf,
    perf,
    userAgent: navigator.userAgent,
  };
  show(`DONE\n${JSON.stringify(payload, null, 2)}`);
  try {
    await fetch(RESULT_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    show(`DONE（结果服务未启动，仅页面可读）\n${JSON.stringify(payload, null, 2)}`);
  }
}

void main();
