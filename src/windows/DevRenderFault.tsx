/**
 * CR-28 B6：DEV-only 渲染异常闸门。放在窗口 ErrorBoundary 内部，
 * effect 命中后置 state 抛错，交给上层 scope="window" 的错误边界。
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { clearRenderFault, isRenderFaultArmed } from './dev-render-fault.ts';

export interface DevRenderFaultProps {
  readonly windowId: string;
  readonly children: ReactNode;
}

export function DevRenderFault({ windowId, children }: DevRenderFaultProps) {
  const [fault, setFault] = useState(false);

  useEffect(() => {
    const dev = import.meta.env.DEV;
    if (!isRenderFaultArmed(windowId, window.localStorage, dev)) return;
    clearRenderFault(window.localStorage, dev);
    setFault(true);
  }, [windowId]);

  if (fault) {
    throw new Error(`DEV：窗口 ${windowId} 渲染异常注入（仅用于验证错误边界）`);
  }
  return <>{children}</>;
}
