/**
 * 空间工作区实验开关（默认关闭）。
 *
 * 只决定设置页是否显示「打开空间工作区」入口，不参与打包：
 * 无论开关如何，3D 场景都只在点击入口后动态 import。
 * 存储不可用（隐私模式等）一律按关闭处理。
 */

export const SPATIAL_FLAG_KEY = 'ember.spatial.enabled.v1';

export interface SpatialFlagStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readSpatialEnabled(storage: SpatialFlagStorage): boolean {
  try {
    return storage.getItem(SPATIAL_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeSpatialEnabled(storage: SpatialFlagStorage, enabled: boolean): void {
  try {
    storage.setItem(SPATIAL_FLAG_KEY, enabled ? '1' : '0');
  } catch {
    /* 存储不可用：仅本次会话生效 */
  }
}