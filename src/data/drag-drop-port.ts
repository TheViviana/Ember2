/**
 * 生产拖放端口：把 Tauri 原生窗口拖放事件收敛在 data 层。
 *
 * `@tauri-apps/*` 只允许出现在 src/data/（gate:layers）。Finder 拖入走 Tauri
 * 原生通道，不进入 WebView 的 DOM `dataTransfer`，因此与 C1-B 的 DOM drop
 * 链路完全分开接线。这里只转发 `drop` 事件（enter/over/leave 无业务语义），
 * 并把物理像素坐标换算成 CSS 像素后交给上层。
 */
import { getCurrentWindow } from '@tauri-apps/api/window';

export interface DragDropPoint {
  readonly x: number;
  readonly y: number;
}

export interface DragDropDropEvent {
  readonly paths: readonly string[];
  /** 相对窗口左上角的 CSS 像素坐标。 */
  readonly position: DragDropPoint;
}

export interface DragDropPort {
  /** 返回退订函数；调用方必须在 cleanup 中成对调用。 */
  onDrop(handler: (event: DragDropDropEvent) => void): Promise<() => void>;
}

export function createTauriDragDropPort(): DragDropPort {
  return {
    onDrop(handler) {
      return getCurrentWindow().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type !== 'drop') return;
        const ratio = globalThis.devicePixelRatio;
        const scale = typeof ratio === 'number' && ratio > 0 ? ratio : 1;
        const logical = payload.position.toLogical(scale);
        handler({ paths: payload.paths, position: { x: logical.x, y: logical.y } });
      });
    },
  };
}
