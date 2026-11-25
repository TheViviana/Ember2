/**
 * C4 分档计时与 grid 失效状态（纯逻辑，可在 node 下测试）。
 * world/nodes 的 DOM 写入发生在输入回调，耗时归入下一次 draw；grid 只在输入失效时重绘。
 */

export interface CanvasFrameStats {
  readonly grid: number;
  readonly world: number;
  readonly edges: number;
  readonly nodes: number;
  /** 累计真实 drawGrid 次数；输入未变的帧不增长。 */
  readonly gridDraws: number;
  /** 累计 incident-edge 增量退化为全量的帧数。 */
  readonly degenerateFrames: number;
}

export interface FrameState {
  measureWorld<T>(operation: () => T): T;
  measureNodes<T>(operation: () => T): T;
  completeFrame(grid: number, edges: number, gridDrawn: boolean, degenerated?: boolean): void;
  getStats(): CanvasFrameStats;
}

export function createFrameState(now: () => number = () => performance.now()): FrameState {
  let pendingWorld = 0;
  let pendingNodes = 0;
  let stats: CanvasFrameStats = {
    grid: 0,
    world: 0,
    edges: 0,
    nodes: 0,
    gridDraws: 0,
    degenerateFrames: 0,
  };

  const measure = <T>(operation: () => T, add: (duration: number) => void): T => {
    const start = now();
    try {
      return operation();
    } finally {
      add(now() - start);
    }
  };

  return {
    measureWorld<T>(operation: () => T): T {
      return measure(operation, (duration) => {
        pendingWorld += duration;
      });
    },
    measureNodes<T>(operation: () => T): T {
      return measure(operation, (duration) => {
        pendingNodes += duration;
      });
    },
    completeFrame(grid: number, edges: number, gridDrawn: boolean, degenerated = false): void {
      stats = {
        grid,
        world: pendingWorld,
        edges,
        nodes: pendingNodes,
        gridDraws: stats.gridDraws + (gridDrawn ? 1 : 0),
        degenerateFrames: stats.degenerateFrames + (degenerated ? 1 : 0),
      };
      pendingWorld = 0;
      pendingNodes = 0;
    },
    getStats(): CanvasFrameStats {
      return { ...stats };
    },
  };
}

export interface GridInvalidation {
  invalidate(): void;
  /** 返回本帧是否需要绘制，并消费 dirty 标记。 */
  consume(): boolean;
}

export function createGridInvalidation(): GridInvalidation {
  let dirty = true;
  return {
    invalidate(): void {
      dirty = true;
    },
    consume(): boolean {
      const needed = dirty;
      dirty = false;
      return needed;
    },
  };
}
