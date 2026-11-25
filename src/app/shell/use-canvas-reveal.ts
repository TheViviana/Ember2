/**
 * S4：看板「在画布中定位」的挂起与消费。
 *
 * 切换画布是异步的：先挂起请求并切回画布，待画布控制器就绪后按
 * 「当前画布 → 最近编辑画布 → 提示未放入任何画布」执行。
 * 从 AppShell 抽出，避免装配文件继续膨胀。
 */
import { useCallback, useEffect, useState, type RefObject } from 'react';
import type { CanvasEntryDto } from '../../types/ipc';
import { pushNotice } from '../stores/notice-store';
import type { WorkspaceMode } from '../stores/canvas-session-store';
import type { CanvasViewController } from '../canvas/CanvasView';

export interface CanvasRevealOptions {
  readonly mode: WorkspaceMode;
  readonly activeCanvasId: string | null;
  readonly canvasRef: RefObject<CanvasViewController | null>;
  readonly listCanvases: () => Promise<readonly CanvasEntryDto[]>;
  readonly setActiveCanvasId: (id: string | null) => void;
  readonly backToCanvas: () => void;
}

interface PendingReveal {
  readonly docPath: string;
  readonly fallbackTried: boolean;
}

export function useCanvasReveal(options: CanvasRevealOptions): (docPath: string) => void {
  const { mode, activeCanvasId, canvasRef, listCanvases, setActiveCanvasId, backToCanvas } = options;
  const [pendingReveal, setPendingReveal] = useState<PendingReveal | null>(null);

  const requestReveal = useCallback(
    (docPath: string): void => {
      setPendingReveal({ docPath, fallbackTried: false });
      backToCanvas();
    },
    [backToCanvas],
  );

  useEffect(() => {
    if (mode !== 'canvas' || pendingReveal === null) return;
    let disposed = false;
    let timer: number | null = null;
    let attempts = 0;
    let listing = false;

    const settle = (): void => {
      if (!disposed) setPendingReveal(null);
    };

    const fail = (): void => {
      if (disposed) return;
      setPendingReveal(null);
      pushNotice('该文档未放入任何画布', 'warning');
    };

    const retry = (): void => {
      attempts += 1;
      if (attempts > 25) {
        fail();
        return;
      }
      timer = window.setTimeout(attempt, 80);
    };

    const attemptFallback = (): void => {
      if (listing || disposed) return;
      listing = true;
      void listCanvases()
        .then((entries) => {
          if (disposed) return;
          const target = entries
            .filter((entry) => entry.valid && entry.id !== activeCanvasId)
            .sort((a, b) => (b.modifiedMs ?? 0) - (a.modifiedMs ?? 0))[0];
          if (target === undefined) {
            fail();
            return;
          }
          setPendingReveal({ docPath: pendingReveal.docPath, fallbackTried: true });
          setActiveCanvasId(target.id);
        })
        .catch(() => {
          if (!disposed) fail();
        });
    };

    const attempt = (): void => {
      if (disposed) return;
      const controller = canvasRef.current;
      if (controller !== null && controller.revealDoc(pendingReveal.docPath)) {
        settle();
        return;
      }
      if (!pendingReveal.fallbackTried) {
        if (controller === null) {
          retry();
          return;
        }
        attemptFallback();
        return;
      }
      retry();
    };

    attempt();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [activeCanvasId, canvasRef, listCanvases, mode, pendingReveal, setActiveCanvasId]);

  return requestReveal;
}
