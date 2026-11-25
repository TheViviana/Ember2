/**
 * P5-C5：恢复检测演示的 React 绑定。
 *
 * 与 `use-window-manager.ts` 同构：纯逻辑在 `recovery-demo.ts`，本文件只做
 * `useSyncExternalStore` 订阅；命令由面板直接调用单例，不额外包一层动作表。
 */
import { useSyncExternalStore } from 'react';
import { recoveryDemo, type RecoveryDemoSnapshot } from './recovery-demo.ts';

export function useRecoveryDemo(): RecoveryDemoSnapshot {
  return useSyncExternalStore(
    (onStoreChange) => recoveryDemo.subscribe(onStoreChange),
    () => recoveryDemo.snapshot(),
  );
}
