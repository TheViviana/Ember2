/**
 * P5-C2：WindowManager 的 React 绑定 + 视口持有者 + 内容注册表。
 *
 * 职责拆分（W2 文件级约束）：
 * - 纯逻辑在 manager.ts（不引 React）；本文件是渲染层与 manager 之间的薄绑定，
 *   引 bare react 仅用于 useSyncExternalStore（src/windows/ 经 gate:layers 允许）。
 * - 单例 WindowManager 模块私有：命令式调用走本模块导出的函数，渲染层不直持引用。
 * - 视口由 WindowLayer 测量 #window-layer 尺寸后写入；open/setGeometry 读取，
 *   manager 本身不读 DOM（C1 契约）。
 * - 内容注册表：app 层注册 contentType → 渲染器，WindowLayer 取数渲染；
 *   Map 模块私有，仅导出函数，不导出可变容器（gate:mutable-exports）。
 */
import { useSyncExternalStore } from 'react';
import type { ComponentType } from 'react';
import {
  WindowManager,
  type Geometry,
  type Viewport,
  type WindowManagerSnapshot,
  type WindowRecord,
} from './manager.ts';

/** 窗口内容渲染器 props：拿到整条记录，由各内容类型自行决定如何绑定数据。 */
export interface WindowContentProps {
  readonly record: WindowRecord;
}

/** contentType → 渲染组件；未注册时 WindowLayer 走 W7 兜底提示。 */
export type WindowContentRenderer = ComponentType<WindowContentProps>;

const windowManager = new WindowManager();

/**
 * 当前视口（#window-layer 的内容区尺寸，已扣除顶栏）。初始 0×0，WindowLayer 挂载后写入。
 * 外层冻结避免模块级可变绑定（gate:mutable-exports 禁 top-level let/var），
 * 内层对象字段可写，供 setViewport 更新。
 */
const viewportHolder = Object.freeze({ value: { width: 0, height: 0 } });

export function getViewport(): Viewport {
  return { width: viewportHolder.value.width, height: viewportHolder.value.height };
}

export function setViewport(viewport: Viewport): void {
  viewportHolder.value.width = viewport.width;
  viewportHolder.value.height = viewport.height;
}

const contentRegistry = new Map<string, WindowContentRenderer>();

/** 注册某内容类型的渲染器；重复注册覆盖（app 层启动时调用一次）。 */
export function registerWindowContent(
  contentType: string,
  renderer: WindowContentRenderer,
): void {
  contentRegistry.set(contentType, renderer);
}

/** 取内容类型渲染器；未注册返回 undefined，由调用方渲染兜底。 */
export function getWindowContent(contentType: string): WindowContentRenderer | undefined {
  return contentRegistry.get(contentType);
}

/** 订阅 manager 快照的 React hook；快照在 manager 内部缓存，变更才换引用。 */
export function useWindowManager(): WindowManagerSnapshot {
  return useSyncExternalStore(
    (onStoreChange) => windowManager.subscribe(onStoreChange),
    () => windowManager.snapshot(),
  );
}

/** 命令式读快照（非 React 上下文，如按钮回调），不触发订阅。 */
export function getWindowSnapshot(): WindowManagerSnapshot {
  return windowManager.snapshot();
}

/** 打开（或激活/还原）一个窗口；最小化窗会被自动还原。返回记录。 */
export function openWindow(
  id: string,
  contentType: string,
  viewport: Viewport = getViewport(),
): WindowRecord {
  return windowManager.open(id, contentType, viewport);
}

export function closeWindow(id: string): boolean {
  return windowManager.close(id);
}

export function activateWindow(id: string): boolean {
  return windowManager.activate(id);
}

export function minimizeWindow(id: string): boolean {
  return windowManager.minimize(id);
}

export function restoreWindow(id: string): boolean {
  return windowManager.restore(id);
}

/** 提交几何（拖拽/缩放结束）：用当前视口钳制后写入并记记忆。 */
export function setWindowGeometry(id: string, geometry: Geometry): boolean {
  return windowManager.setGeometry(id, geometry, getViewport());
}

export function tileWindows(ids: ReadonlyArray<string>): boolean {
  return windowManager.tile(ids, getViewport());
}

export function cascadeWindows(ids: ReadonlyArray<string>): boolean {
  return windowManager.cascade(ids, getViewport());
}

/** 派生 z-index：Z_WINDOW + 在记录数组中的索引；不存在返回 -1。 */
export function getWindowZIndex(id: string): number {
  return windowManager.getZIndex(id);
}
