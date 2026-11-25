/**
 * 最小状态容器：快照 + 订阅 + 整体替换。
 *
 * - UI 只拿不可变快照（每次 set 生成新对象，Object.is 去重），不暴露 setter；
 * - 不为「字段级 selector」引入额外抽象，派生视图由上层按快照计算（C2 树视图）；
 * - 不感知 React / zustand：那些只出现在 `src/app/stores/`（D12）。
 */
import type { Unsubscribe } from './ports.ts';

export type SliceListener<T> = (snapshot: T) => void;

export interface Slice<T> {
  getSnapshot(): T;
  subscribe(listener: SliceListener<T>): Unsubscribe;
  /** 引用相同则不发通知；通知按注册顺序进行。 */
  set(next: T): void;
}

export function createSlice<T>(initial: T): Slice<T> {
  let snapshot = initial;
  const listeners = new Set<SliceListener<T>>();

  function getSnapshot(): T {
    return snapshot;
  }

  function subscribe(listener: SliceListener<T>): Unsubscribe {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function set(next: T): void {
    if (Object.is(next, snapshot)) return;
    snapshot = next;
    // 迭代副本：通知期间退订 / 新订阅不会影响本轮分发。
    for (const listener of [...listeners]) listener(snapshot);
  }

  return { getSnapshot, subscribe, set };
}
