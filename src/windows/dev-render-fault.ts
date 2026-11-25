/**
 * CR-28 B6：DEV-only 窗口渲染异常注入。
 *
 * 目的：验证某个窗口内容渲染抛错时，只有该窗口的 ErrorBoundary 降级，
 * 其他窗口与应用外壳继续工作。生产构建中 `dev` 为 false，永不注入。
 *
 * 存储值为目标窗口 id，或 `next` 表示下一个挂载的窗口；命中后由
 * `clearRenderFault` 删除，保证一次性。
 */
export const RENDER_FAULT_KEY = 'ember.dev.renderFault';
export const NEXT_WINDOW_TARGET = 'next';

export interface RenderFaultStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function read(storage: RenderFaultStorage): string | null {
  try {
    return storage.getItem(RENDER_FAULT_KEY);
  } catch {
    return null;
  }
}

/** 布置一次性渲染异常；空目标视为无效。 */
export function armRenderFault(target: string, storage: RenderFaultStorage): boolean {
  if (target.trim() === '') return false;
  try {
    storage.setItem(RENDER_FAULT_KEY, target);
    return true;
  } catch {
    return false;
  }
}

/** 该窗口是否命中注入目标；非 DEV 构建恒为 false。 */
export function isRenderFaultArmed(
  windowId: string,
  storage: RenderFaultStorage,
  dev: boolean,
): boolean {
  if (!dev) return false;
  const target = read(storage);
  if (target === null) return false;
  return target === NEXT_WINDOW_TARGET || target === windowId;
}

/** 命中后清除 flag；非 DEV 构建不触碰存储。 */
export function clearRenderFault(
  storage: RenderFaultStorage,
  dev: boolean,
): void {
  if (!dev) return;
  try {
    storage.removeItem(RENDER_FAULT_KEY);
  } catch {
    // 存储不可用时不阻断注入；下一次布置会覆盖旧值。
  }
}
