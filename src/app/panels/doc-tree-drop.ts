/**
 * CR-20261122-67 §3：文档树内部拖拽落点的纯命中判定。
 *
 * 输入是当前可见行的几何（path/name/kind/top/bottom）与鼠标 y，输出落点类型：
 *  - into   ：落在文件夹行的中间带 → 移入该文件夹（追加到末尾）
 *  - place  ：落在某行的上半/下半 → 插到该行之前/之后（同目录内调序，跨目录即移动）
 *  - append ：列表为空或无可参照行 → 追加到根目录末尾
 *  - none   ：无有效落点
 *
 * 纯函数，无 DOM 依赖；调用方用 elementFromPoint / getBoundingClientRect 喂数据，
 * 便于在 jsdom 下测几何与边界。
 */

export interface RowHit {
  readonly path: string;
  readonly name: string;
  readonly kind: 'dir' | 'file';
  readonly top: number;
  readonly bottom: number;
}

export type TreeDropTarget =
  | { readonly kind: 'into'; readonly folder: string }
  | {
      readonly kind: 'place';
      readonly dir: string;
      readonly anchor: string;
      readonly position: 'before' | 'after';
    }
  | { readonly kind: 'append'; readonly dir: string }
  | { readonly kind: 'none' };

/** 行高的中间 50% 视为「移入文件夹」带，上下各 25% 留给「插到该行前/后」。 */
const FOLDER_INTO_BAND = 0.5;

export function parentDirOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

export function isDescendantOf(path: string, ancestor: string): boolean {
  if (ancestor === '') return path.includes('/');
  return path.startsWith(`${ancestor}/`);
}

export interface ResolvedDrop {
  readonly target: TreeDropTarget;
  /** 命中参照行（into/place 时有值，append 时为 null）。用于画插入指示线。 */
  readonly nearest: RowHit | null;
}

export function resolveTreeDrop(
  rows: readonly RowHit[],
  y: number,
  draggedPath: string,
): ResolvedDrop {
  // 排除被拖拽行自身；若拖的是目录，也排除其后代（不能移入自身子树）。
  const draggedIsDir = !draggedPath.includes('.') && draggedPath !== '';
  const candidates = rows.filter(
    (row) => row.path !== draggedPath && !(draggedIsDir && isDescendantOf(row.path, draggedPath)),
  );
  if (candidates.length === 0) {
    return { target: { kind: 'append', dir: '' }, nearest: null };
  }
  let nearest = candidates[0];
  if (nearest === undefined) {
    return { target: { kind: 'append', dir: '' }, nearest: null };
  }
  let nearestDist = Infinity;
  for (const row of candidates) {
    const center = (row.top + row.bottom) / 2;
    const dist = Math.abs(center - y);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = row;
    }
  }
  const height = nearest.bottom - nearest.top;
  const midY = (nearest.top + nearest.bottom) / 2;

  if (nearest.kind === 'dir' && height > 0) {
    const bandTop = nearest.top + (height * (1 - FOLDER_INTO_BAND)) / 2;
    const bandBottom = nearest.bottom - (height * (1 - FOLDER_INTO_BAND)) / 2;
    if (y >= bandTop && y <= bandBottom) {
      return { target: { kind: 'into', folder: nearest.path }, nearest };
    }
  }

  const dir = parentDirOf(nearest.path);
  if (y < midY) {
    return {
      target: { kind: 'place', dir, anchor: nearest.name, position: 'before' },
      nearest,
    };
  }
  return {
    target: { kind: 'place', dir, anchor: nearest.name, position: 'after' },
    nearest,
  };
}

/**
 * 给定目标目录当前的子节点名列表与 dragged 名，按落点计算新顺序。
 * 纯函数，供 DocumentList 写入 localStorage 顺序存储，也便于单元测试。
 */
export function nextChildOrder(
  current: readonly string[],
  draggedName: string,
  target: TreeDropTarget,
): readonly string[] {
  if (target.kind === 'none') return current;
  const base = current.filter((name) => name !== draggedName);
  switch (target.kind) {
    case 'into':
    case 'append':
      return [...base, draggedName];
    case 'place': {
      const idx = base.indexOf(target.anchor);
      if (idx === -1) return [...base, draggedName];
      return target.position === 'before'
        ? [...base.slice(0, idx), draggedName, ...base.slice(idx)]
        : [...base.slice(0, idx + 1), draggedName, ...base.slice(idx + 1)];
    }
  }
}
