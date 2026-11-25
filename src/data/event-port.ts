/**
 * 生产 EventPort：把契约 §III 的全局事件订阅适配成 core 的端口契约。
 *
 * 订阅是异步的（Tauri `listen` 返回 Promise）；退订函数原样返回，由 core 统一保存。
 */
import type { EventPort } from '../core/ports';
import { onFileChanged, onWatchError } from './ipc-events';

export function createTauriEventPort(): EventPort {
  return {
    onFileChanged: (handler) => onFileChanged(handler),
    onWatchError: (handler) => onWatchError(handler),
  };
}
