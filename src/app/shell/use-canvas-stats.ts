/**
 * 状态栏右侧统计：节点数、连线数、缩放百分比。
 *
 * 画布不在 React 状态里维护这些值，引擎也没有批量变更事件；
 * 这里用 250ms 轻量轮询换零侵入（引擎文件已到架构行数上限）。
 * 仅在画布模式、且引擎可用时运行；隐藏窗口跳过。
 */
import { useEffect, useState } from 'react';
import type { CanvasEngine } from '../canvas/engine';

export interface CanvasStats {
  readonly nodes: number;
  readonly edges: number;
  readonly zoomPercent: number;
}

export function useCanvasStats(
  active: boolean,
  getEngine: () => CanvasEngine | null,
): CanvasStats | null {
  const [stats, setStats] = useState<CanvasStats | null>(null);

  useEffect(() => {
    if (!active) {
      setStats(null);
      return;
    }
    let signature = '';
    const tick = (): void => {
      if (document.hidden) return;
      const engine = getEngine();
      if (engine === null) {
        if (signature !== 'none') {
          signature = 'none';
          setStats(null);
        }
        return;
      }
      const doc = engine.getDocument();
      const next: CanvasStats = {
        nodes: doc.nodes.length,
        edges: doc.edges.length,
        zoomPercent: Math.round(engine.getTransform().scale * 100),
      };
      const nextSignature = `${next.nodes}:${next.edges}:${next.zoomPercent}`;
      if (nextSignature === signature) return;
      signature = nextSignature;
      setStats(next);
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [active, getEngine]);

  return stats;
}
