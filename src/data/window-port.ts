/**
 * 生产窗口端口：把关窗拦截与关闭收敛在 data 层。
 * `@tauri-apps/*` 只允许出现在 src/data/（gate:layers）。
 */
import { getCurrentWindow } from '@tauri-apps/api/window';

export interface CloseRequestLike {
  preventDefault(): void;
}

export interface WindowPort {
  /** 返回退订函数；非 Tauri 环境下由调用方忽略订阅失败。 */
  onCloseRequested(
    handler: (event: CloseRequestLike) => void | Promise<void>,
  ): Promise<() => void>;
  /** 请求关闭窗口；会再次触发 closeRequested，调用方需自行放行。 */
  close(): Promise<void>;
  /** 最小化窗口（自绘交通灯用）。 */
  minimize(): Promise<void>;
  /** 最大化 / 还原切换（自绘交通灯用）。 */
  toggleMaximize(): Promise<void>;
}

export function createTauriWindowPort(): WindowPort {
  const current = getCurrentWindow();
  return {
    onCloseRequested: (handler) => current.onCloseRequested(handler),
    close: () => current.close(),
    minimize: () => current.minimize(),
    toggleMaximize: () => current.toggleMaximize(),
  };
}
