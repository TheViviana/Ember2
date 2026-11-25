/**
 * 生产 CanvasPort：把 core 的画布端口契约逐条映射到契约 §III 的三条命令。
 *
 * - `list` → `list_canvases`（P1 既有命令，原样透传，含 `valid:false` 条目）；
 * - `read` → `canvas_read`；
 * - `write` → `canvas_write`（条件写，`expectedSha` 原样透传）。
 *
 * `@tauri-apps/*` 只允许出现在 src/data/（gate:layers）；本文件不直接 invoke，
 * 复用 P2 既有 `IpcClient`。错误归一化（Rust 码 → `EmberIpcError`，`currentSha` /
 * `cause` 按存在才透传）由 `createIpcClient` 内的 `toIpcError` 统一完成，适配层
 * 不做二次包装，避免丢失 `rawCode`。
 *
 * `client` 由装配层注入（C4 传 `ipcClient`）：本文件只保留 `import type`，
 * 不引入任何运行期模块解析，避免生产代码携带 `.ts` 扩展名导入（H1）。
 */
import type { CanvasPort, CanvasSaveOptions } from '../core/canvas/ports';
import type { IpcClient } from './ipc-client';

export function createTauriCanvasPort(client: IpcClient): CanvasPort {
  return {
    list: () => client.invoke('list_canvases'),
    read: (id) => client.invoke('canvas_read', { id }),
    write: (id, text, expectedSha, options: CanvasSaveOptions = {}) =>
      client.invoke('canvas_write', {
        id,
        text,
        expectedSha,
        backupV1: options.backupV1 === true,
      }),
  };
}
