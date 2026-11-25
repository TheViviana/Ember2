/**
 * 启动时的画布引导：清单为空时创建并打开默认画布「Zero」；
 * 已有画布时默认打开 Zero（不存在则第一个有效画布），避免停在空工作区。
 */
import { useEffect, useRef, type MutableRefObject } from 'react';
import type { CanvasEntryDto } from '../../types/ipc';
import type {
  CanvasOpenResult,
  CanvasSaveOptions,
  CanvasSaveSuccess,
} from '../../core/canvas/ports';
import { createCanvasSession } from '../canvas/canvas-open.ts';
import type { WorkspaceMode } from '../stores/canvas-session-store';

export const DEFAULT_CANVAS_ID = 'Zero';

interface StartupCanvasOptions {
  readonly canvases: readonly CanvasEntryDto[];
  readonly canvasesLoadedRef: MutableRefObject<boolean>;
  /** 保险库已打开（identity 非空）。未就绪时画布清单请求会失败，引导必须等它变成 true。 */
  readonly ready: boolean;
  readonly activeCanvasId: string | null;
  readonly openCanvas: (id: string) => Promise<CanvasOpenResult>;
  readonly saveCanvas: (
    id: string,
    text: string,
    options?: CanvasSaveOptions,
  ) => Promise<CanvasSaveSuccess>;
  readonly refreshCanvases: () => Promise<void>;
  readonly setActiveCanvasId: (id: string | null) => void;
  readonly setMode: (mode: WorkspaceMode) => void;
}

export function useStartupCanvas(options: StartupCanvasOptions): void {
  const {
    canvases,
    canvasesLoadedRef,
    ready,
    activeCanvasId,
    openCanvas,
    saveCanvas,
    refreshCanvases,
    setActiveCanvasId,
    setMode,
  } = options;
  const zeroAttemptedRef = useRef(false);
  const defaultOpenAttemptedRef = useRef(false);

  // 首次启动且画布清单为空 → 自动创建默认画布「Zero」并打开。
  useEffect(() => {
    if (!ready) return;
    if (zeroAttemptedRef.current) return;
    if (!canvasesLoadedRef.current) return;
    zeroAttemptedRef.current = true;
    if (canvases.length > 0) return;
    void (async () => {
      const result = await createCanvasSession(DEFAULT_CANVAS_ID, {
        open: openCanvas,
        save: saveCanvas,
      });
      if (result.kind === 'created' || result.kind === 'exists') {
        await refreshCanvases();
        setActiveCanvasId(DEFAULT_CANVAS_ID);
        setMode('canvas');
      }
    })();
  }, [canvases, canvasesLoadedRef, openCanvas, ready, refreshCanvases, saveCanvas, setActiveCanvasId, setMode]);

  // 启动后默认打开画布：优先「Zero」，否则第一个有效画布。
  useEffect(() => {
    if (!ready) return;
    if (defaultOpenAttemptedRef.current || !canvasesLoadedRef.current) return;
    if (canvases.length === 0) return;
    defaultOpenAttemptedRef.current = true;
    if (activeCanvasId !== null) return;
    const preferred =
      canvases.find((entry) => entry.valid && entry.id === DEFAULT_CANVAS_ID) ??
      canvases.find((entry) => entry.valid);
    if (preferred === undefined) return;
    setActiveCanvasId(preferred.id);
    setMode('canvas');
  }, [activeCanvasId, canvases, canvasesLoadedRef, ready, setActiveCanvasId, setMode]);
}
