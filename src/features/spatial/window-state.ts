/**
 * 空间工作区窗口状态（纯函数，node 下可测）。
 *
 * 所有操作返回新数组，不修改入参；3D 渲染层只读这里的数据。
 * 坐标与尺寸使用世界单位（约等于米），M2 接入渲染层时按同一单位换算。
 * MVP 不持久化：默认布局只存在于内存，关闭覆盖层即丢弃。
 */

export type SpatialContentType = 'markdown' | 'ai-summary';

export interface SpatialWindowState {
  readonly id: string;
  readonly title: string;
  readonly position: readonly [number, number, number];
  readonly size: readonly [number, number];
  readonly contentType: SpatialContentType;
  readonly zIndex: number;
}

export const SPATIAL_MIN_SIZE = Object.freeze([0.9, 0.6] as const);
export const SPATIAL_MAX_SIZE = Object.freeze([3.2, 2.2] as const);

/** 默认双窗口布局；每次调用返回新数组，打开覆盖层时重置到这一份。 */
export function defaultSpatialWindows(): readonly SpatialWindowState[] {
  return [
    {
      id: 'markdown',
      title: '只读文档',
      position: [-0.95, 0.15, 0],
      size: [1.6, 1.05],
      contentType: 'markdown',
      zIndex: 1,
    },
    {
      id: 'ai-summary',
      title: 'AI 对话摘要',
      position: [0.95, 0.05, -0.15],
      size: [1.5, 0.95],
      contentType: 'ai-summary',
      zIndex: 2,
    },
  ];
}

export function clampSpatialSize(
  size: readonly [number, number],
): readonly [number, number] {
  return [
    Math.min(SPATIAL_MAX_SIZE[0], Math.max(SPATIAL_MIN_SIZE[0], size[0])),
    Math.min(SPATIAL_MAX_SIZE[1], Math.max(SPATIAL_MIN_SIZE[1], size[1])),
  ];
}

export function moveSpatialWindow(
  windows: readonly SpatialWindowState[],
  id: string,
  position: readonly [number, number, number],
): readonly SpatialWindowState[] {
  return windows.map((item) =>
    item.id === id
      ? { ...item, position: [position[0], position[1], position[2]] as const }
      : item,
  );
}

export function resizeSpatialWindow(
  windows: readonly SpatialWindowState[],
  id: string,
  size: readonly [number, number],
): readonly SpatialWindowState[] {
  const clamped = clampSpatialSize(size);
  return windows.map((item) => (item.id === id ? { ...item, size: clamped } : item));
}

/** 聚焦后把 zIndex 重排为 1..n，被聚焦窗口置顶；未知 id 原样返回。 */
export function focusSpatialWindow(
  windows: readonly SpatialWindowState[],
  id: string,
): readonly SpatialWindowState[] {
  const ordered = [...windows].sort((left, right) => left.zIndex - right.zIndex);
  const index = ordered.findIndex((item) => item.id === id);
  if (index < 0) return windows;
  const target = ordered[index];
  if (target === undefined) return windows;
  ordered.splice(index, 1);
  ordered.push(target);
  return ordered.map((item, position) => ({ ...item, zIndex: position + 1 }));
}