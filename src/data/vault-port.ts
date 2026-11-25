/**
 * 生产 VaultPort：把 core 的端口契约逐条映射到契约 §III 的 vault_* 命令。
 *
 * `@tauri-apps/*` 只允许出现在 src/data/（gate:layers），core 通过注入拿到本实现。
 */
import type { VaultPort } from '../core/ports';
import { ipcClient, type IpcClient } from './ipc-client';

export function createTauriVaultPort(client: IpcClient = ipcClient): VaultPort {
  return {
    identity: () => client.invoke('vault_identity'),
    constants: () => client.invoke('vault_constants'),
    scan: () => client.invoke('vault_scan'),
    read: (path) => client.invoke('vault_read', { path }),
    write: (path, text, expectedSha = null) =>
      client.invoke('vault_write', { path, text, expectedSha }),
    stat: (path) => client.invoke('vault_stat', { path }),
    list: (path) => client.invoke('vault_list', path === undefined ? {} : { path }),
    rename: (from, to) => client.invoke('vault_rename', { from, to }),
    remove: (path) => client.invoke('vault_remove', { path }),
  };
}
