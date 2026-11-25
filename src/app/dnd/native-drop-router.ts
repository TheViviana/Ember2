import type { DragDropDropEvent } from '../../data/drag-drop-port.ts';

export type NativeDropRoute = 'empty' | 'doc-list' | 'editor' | 'canvas' | 'unsupported';

interface DropZoneShape {
  closest?(selector: string): unknown;
}

export function resolveNativeDropRoute(
  paths: readonly string[],
  zone: DropZoneShape | null,
): NativeDropRoute {
  if (paths.length === 0) return 'empty';
  if (zone?.closest?.('[data-drop-zone="doc-list"]') != null) return 'doc-list';
  if (
    zone?.closest?.('[data-drop-zone="editor"]') != null ||
    zone?.closest?.('[data-editor-drop-host]') != null
  ) {
    return 'editor';
  }
  if (zone?.closest?.('[data-canvas-drop-host]') != null) return 'canvas';
  return 'unsupported';
}

export interface NativeDropHandlers {
  readonly onDocList: (paths: readonly string[]) => void;
  readonly onEditor: (paths: readonly string[]) => void;
  readonly onCanvas: (event: DragDropDropEvent) => void;
  readonly onUnsupported: () => void;
}

export function routeNativeDrop(
  event: DragDropDropEvent,
  zone: DropZoneShape | null,
  handlers: NativeDropHandlers,
): NativeDropRoute {
  const route = resolveNativeDropRoute(event.paths, zone);
  if (route === 'doc-list') handlers.onDocList(event.paths);
  if (route === 'editor') handlers.onEditor(event.paths);
  if (route === 'canvas') handlers.onCanvas(event);
  if (route === 'unsupported') handlers.onUnsupported();
  return route;
}
