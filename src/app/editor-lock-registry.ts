/**
 * 关窗期间的编辑器锁注册表（app 层）。
 *
 * 与 `src/editor/media-insert-registry.ts` 同构：按窗口 id 登记一把锁
 * （实际能力是 `EditorControl.setLocked`）。关窗守卫在 flush 前统一锁定
 * 所有已就绪的编辑器，阻止新输入落进“已经保存、马上关闭”的窗口；
 * flush 失败或关闭取消时统一解锁。
 *
 * 不引 React / Tauri / core：纯登记表，Node 环境可直接单测。
 */

export type EditorLocker = (locked: boolean) => void;

const lockers = new Map<string, EditorLocker>();
/** 守卫锁定过的回调；解锁只恢复自己锁过的，避免误伤后来登记的编辑器。 */
const locked: EditorLocker[] = [];

/** EditorWindow 在编辑器句柄就绪后登记；注销只移除本次登记的回调。 */
export function registerEditorLocker(windowId: string, locker: EditorLocker): () => void {
  lockers.set(windowId, locker);
  return () => {
    if (lockers.get(windowId) === locker) lockers.delete(windowId);
    const index = locked.indexOf(locker);
    if (index !== -1) locked.splice(index, 1);
  };
}

/** 锁定所有已登记编辑器。单个锁抛错不阻塞其他编辑器，也不阻塞关窗流程。 */
export function lockAllEditors(): void {
  for (const locker of lockers.values()) {
    if (locked.includes(locker)) continue;
    try {
      locker(true);
    } catch {
      // 单个编辑器锁失败不阻塞关窗；store.flush 的多轮收集是兜底。
    }
    locked.push(locker);
  }
}

/** 解除本模块锁定过的编辑器；恢复失败同样不影响取消关闭。 */
export function resumeAllEditors(): void {
  const pending = locked.splice(0, locked.length);
  for (const locker of pending) {
    try {
      locker(false);
    } catch {
      // 恢复失败没有补救手段，吞掉以免阻断其余编辑器的恢复。
    }
  }
}
