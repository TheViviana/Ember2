/**
 * P7 自动更新端口：`@tauri-apps/*` 只允许出现在 `src/data/`（gate:layers）。
 *
 * endpoint 与 pubkey 目前是占位值（tauri.conf.json → plugins.updater）；
 * 真实发布前必须按 docs/updater.md 替换，否则 check 只会失败或被拒绝。
 */
import { getVersion } from '@tauri-apps/api/app';
import { check } from '@tauri-apps/plugin-updater';

export interface UpdateProgress {
  readonly downloaded: number;
  readonly total: number | null;
}

/** 已发现但尚未安装的更新；由 data 层持有 Tauri Update 资源。 */
export interface PendingUpdate {
  readonly version: string;
  readonly currentVersion: string;
  readonly body: string | null;
  readonly date: string | null;
  downloadAndInstall(onProgress: (progress: UpdateProgress) => void): Promise<void>;
}

export interface UpdaterPort {
  currentVersion(): Promise<string>;
  /** 无更新返回 null；网络/签名/配置错误直接抛给调用方。 */
  check(): Promise<PendingUpdate | null>;
}

export const updaterPort: UpdaterPort = Object.freeze({
  currentVersion: (): Promise<string> => getVersion(),

  async check(): Promise<PendingUpdate | null> {
    const update = await check();
    if (update === null) return null;
    return {
      version: update.version,
      currentVersion: update.currentVersion,
      body: update.body ?? null,
      date: update.date ?? null,
      async downloadAndInstall(onProgress: (progress: UpdateProgress) => void): Promise<void> {
        let downloaded = 0;
        let total: number | null = null;
        await update.downloadAndInstall((event) => {
          if (event.event === 'Started') {
            total = event.data.contentLength ?? null;
            onProgress({ downloaded, total });
            return;
          }
          if (event.event === 'Progress') {
            downloaded += event.data.chunkLength;
            onProgress({ downloaded, total });
            return;
          }
          onProgress({ downloaded, total });
        });
      },
    };
  },
});
