/**
 * 后端全局事件的类型化订阅（契约 §III「全局事件」）。
 *
 * 与 `ai_chat_stream` 的 Channel 不同，这三条是应用级广播：
 * - `vault://file-changed`：库内 .md 外部变更，一次防抖冲刷一条事件；
 * - `vault://watch-error`：监听启动失败或运行期 notify 报错，负载与命令错误同形；
 * - `vault://trash-sweep`：启动时后台清扫一次的报告。
 *
 * 每个订阅都返回 `UnlistenFn`；调用方必须保存并在销毁时调用，避免重复订阅。
 */
import { listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';
import {
  IPC_EVENT_NAMES,
  type FileChangedDto,
  type SweepReportDto,
  type WatchErrorPayload,
} from '../types/ipc';

export function onFileChanged(handler: (payload: FileChangedDto) => void): Promise<UnlistenFn> {
  return listen<FileChangedDto>(IPC_EVENT_NAMES.fileChanged, (event) => handler(event.payload));
}

export function onWatchError(handler: (payload: WatchErrorPayload) => void): Promise<UnlistenFn> {
  return listen<WatchErrorPayload>(IPC_EVENT_NAMES.watchError, (event) => handler(event.payload));
}

export function onTrashSweep(handler: (payload: SweepReportDto) => void): Promise<UnlistenFn> {
  return listen<SweepReportDto>(IPC_EVENT_NAMES.trashSweep, (event) => handler(event.payload));
}
