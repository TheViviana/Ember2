/**
 * CR-20261119-07 S4 浏览器复现页（不进 CI）。
 * 启动 `pnpm vite --port 5199` 后打开 browser-dnd-harness.html；
 * 页面用真实 TreeRow 发起指针拖拽会话（pointerdown → move → up），
 * 落点由 elementFromPoint 命中画布宿主后建文档节点。
 * 也可在页面上方手动拖动文档行到画布，复核真实指针链路。
 */
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { TreeRow } from '../../../src/app/panels/TreeRow.tsx';
import { CanvasEngine, type CanvasDocumentStore } from '../../../src/app/canvas/engine.ts';
import {
  createAddDocumentNodeCommand,
  isSafeLibraryDocPath,
} from '../../../src/app/canvas/canvas-interactions.ts';
import {
  POINTER_DRAG_DROP_EVENT,
  readPointerDragDropDetail,
} from '../../../src/app/dnd/pointer-drag.ts';

function createStore(): CanvasDocumentStore {
  return {
    open(): Promise<{
      exists: boolean;
      text: null;
      sha256: string;
      modifiedMs: null;
    }> {
      return Promise.resolve({ exists: false, text: null, sha256: '', modifiedMs: null });
    },
    save(): Promise<{ ok: boolean }> {
      return Promise.resolve({ ok: true });
    },
    flush(): Promise<{ ok: boolean; timedOut: boolean; error: null }> {
      return Promise.resolve({ ok: true, timedOut: false, error: null });
    },
    beginClosing(): void {
      // 复现页不触发应用退出。
    },
  };
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function show(text: string): void {
  const result = document.querySelector('#result');
  if (result !== null) result.textContent = text;
}

function pointer(
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  point: { readonly x: number; readonly y: number },
): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    clientX: point.x,
    clientY: point.y,
  });
}

async function main(): Promise<void> {
  const source = document.querySelector<HTMLDivElement>('#source');
  const host = document.querySelector<HTMLDivElement>('#canvas');
  if (source === null || host === null) throw new Error('复现页挂载点缺失');

  host.setAttribute('data-canvas-drop-host', '');
  const engine = new CanvasEngine({ host, store: createStore(), canvasId: 'dnd-repro' });
  await engine.mount();
  const root = createRoot(source);
  flushSync(() => {
    root.render(
      createElement(TreeRow, {
        path: 'Notes/a.md',
        name: 'a.md',
        depth: 0,
        kind: 'file',
        hasChildren: false,
        onRefreshDirs: () => undefined,
      }),
    );
  });
  const row = source.querySelector<HTMLButtonElement>('button[role="treeitem"]');
  if (row === null) throw new Error('未找到 TreeRow');

  // 合成 PointerEvent 没有活跃指针，setPointerCapture 会抛 NotFoundError；复现页显式打桩。
  row.setPointerCapture = () => undefined;
  row.releasePointerCapture = () => undefined;
  row.hasPointerCapture = () => false;

  let dragStarted = false;
  row.addEventListener('pointermove', () => {
    dragStarted = true;
  });

  const rect = host.getBoundingClientRect();
  const dropPoint = { x: rect.left + 120, y: rect.top + 160 };
  let createdPath: string | null = null;
  document.addEventListener(POINTER_DRAG_DROP_EVENT, (event) => {
    if (!(event instanceof CustomEvent)) return;
    const detail = readPointerDragDropDetail(event.detail);
    if (detail === null || detail.payload.kind !== 'doc') return;
    const inside =
      detail.clientX >= rect.left &&
      detail.clientX <= rect.right &&
      detail.clientY >= rect.top &&
      detail.clientY <= rect.bottom;
    if (!inside || !isSafeLibraryDocPath(detail.payload.path, () => true)) return;
    const world = engine.screenToWorld({
      x: detail.clientX - rect.left,
      y: detail.clientY - rect.top,
    });
    if (
      !engine.executeCommands([
        createAddDocumentNodeCommand(world.x, world.y, detail.payload.path),
      ])
    ) {
      throw new Error('文档节点命令被拒绝');
    }
    createdPath = detail.payload.path;
  });

  const rowRect = row.getBoundingClientRect();
  const start = { x: rowRect.left + 20, y: rowRect.top + 10 };
  row.dispatchEvent(pointer('pointerdown', start));
  row.dispatchEvent(pointer('pointermove', { x: start.x + 24, y: start.y + 12 }));
  row.dispatchEvent(pointer('pointerup', dropPoint));
  await nextFrame();

  const created = engine.getDocument().nodes.at(-1);
  const createdNode =
    created !== null && typeof created === 'object'
      ? (created as { readonly x?: unknown; readonly y?: unknown; readonly docPath?: unknown })
      : undefined;
  const createdX = typeof createdNode?.x === 'number' ? createdNode.x : null;
  const createdY = typeof createdNode?.y === 'number' ? createdNode.y : null;
  const createdDocPath =
    typeof createdNode?.docPath === 'string' ? createdNode.docPath : null;
  const result = {
    dragStarted,
    dropEventSeen: createdPath !== null,
    created: createdNode === undefined ? null : { x: createdX, y: createdY, docPath: createdDocPath },
    pass:
      dragStarted &&
      createdPath === 'Notes/a.md' &&
      createdX === 120 &&
      createdY === 160 &&
      createdDocPath === 'Notes/a.md',
  };
  show(`DONE\n${JSON.stringify(result, null, 2)}`);
}

void main().catch((error: unknown) => {
  show(`FAILED\n${error instanceof Error ? error.stack ?? error.message : String(error)}`);
});
