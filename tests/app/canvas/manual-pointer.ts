/**
 * C4 R2 真实指针 capture 手工验证页（不进 CI）。
 *
 * 与 browser-harness.ts 的关键区别：
 * 1. 不调用 allowSyntheticPointers，保留真实 setPointerCapture；
 * 2. 引擎常驻，供真实鼠标拖拽三个场景：
 *    ① 拖节点到画布边缘外再拖回；
 *    ② 拖拽中切窗口再切回；
 *    ③ 拖拽中按 Esc。
 * 3. 顶部 debug 面板实时显示节点位置、活动指针、capture 状态、手势。
 */
import { CanvasEngine, type CanvasDocumentStore } from '../../../src/app/canvas/engine.ts';

interface OpenResult {
  readonly exists: boolean;
  readonly text: string | null;
  readonly sha256: string;
  readonly modifiedMs: number | null;
}

function createStore(text: string): CanvasDocumentStore {
  return {
    open(): Promise<OpenResult> {
      return Promise.resolve({ exists: true, text, sha256: '', modifiedMs: null });
    },
    save(_id: string, _next: string): Promise<{ ok: boolean }> {
      return Promise.resolve({ ok: true });
    },
    flush(): Promise<{ ok: boolean; timedOut: boolean; error: null }> {
      return Promise.resolve({ ok: true, timedOut: false, error: null });
    },
    beginClosing(): void {
      /* noop */
    },
  };
}

// host 720×360；节点 A 放在 host 中心，便于 browser_drag 从 host 中心按下命中节点。
const DOC = JSON.stringify({
  schemaVersion: 2,
  lastOrigin: { x: 24, y: 48 },
  nodes: [
    { id: 'a', label: 'A', x: 304, y: 180 },
    { id: 'b', label: 'B', x: 24, y: 48 },
  ],
  edges: [],
});

const host = document.getElementById('host') as HTMLDivElement;
const debug = document.getElementById('debug') as HTMLElement;

const engine = new CanvasEngine({ host, store: createStore(DOC), canvasId: 'manual-pointer' });

let activePointerId: number | null = null;

host.addEventListener('pointerdown', (event) => {
  activePointerId = event.pointerId;
});
host.addEventListener('pointerup', () => {
  activePointerId = null;
});
host.addEventListener('pointercancel', () => {
  activePointerId = null;
});

function positions(): Record<string, { x: number; y: number }> {
  const parsed = JSON.parse(engine.serialize()) as {
    nodes: Array<{ id: string; x: number; y: number }>;
  };
  const out: Record<string, { x: number; y: number }> = {};
  for (const node of parsed.nodes) out[node.id] = { x: node.x, y: node.y };
  return out;
}

function render(): void {
  const pos = positions();
  const sel = engine.getSelection();
  const hasCapture = activePointerId === null ? false : host.hasPointerCapture(activePointerId);
  debug.textContent = [
    `节点 A: (${pos.a?.x ?? '?'}, ${pos.a?.y ?? '?'})`,
    `节点 B: (${pos.b?.x ?? '?'}, ${pos.b?.y ?? '?'})`,
    `活动指针: ${activePointerId ?? '无'}`,
    `setPointerCapture 生效: ${hasCapture}`,
    `选中节点: ${[...sel.nodes].join(',') || '无'}`,
    `readOnly: ${engine.isReadOnly()}`,
    '',
    '场景说明：拖节点 A；拖出画布右边缘再拖回；拖拽中按 Esc 应还原。',
  ].join('\n');
  requestAnimationFrame(render);
}

await engine.mount();
(window as unknown as { engine: CanvasEngine }).engine = engine;
requestAnimationFrame(render);
