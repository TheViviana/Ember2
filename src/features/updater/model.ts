/**
 * P7 自动更新的机器本地偏好（localStorage），纯逻辑便于 node:test。
 */
export const UPDATER_AUTO_CHECK_KEY = 'ember.updater.autoCheck';

export interface UpdaterStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 缺省开启静默检查；只有显式写入 '0' 才关闭。 */
export function loadAutoCheck(storage: UpdaterStorage | null): boolean {
  if (storage === null) return true;
  try {
    return storage.getItem(UPDATER_AUTO_CHECK_KEY) !== '0';
  } catch {
    return true;
  }
}

/** 返回 null 表示已持久化；否则为可直接展示的失败原因。 */
export function saveAutoCheck(storage: UpdaterStorage | null, enabled: boolean): string | null {
  if (storage === null) return '当前环境不支持本地存储，自动检查设置不会保留';
  try {
    storage.setItem(UPDATER_AUTO_CHECK_KEY, enabled ? '1' : '0');
    return null;
  } catch {
    return '自动检查设置保存失败，本次更改不会保留';
  }
}

/** 下载进度文案；总量未知时只显示已下载量。 */
export function formatProgress(downloaded: number, total: number | null): string {
  const done = formatBytes(downloaded);
  if (total === null || total <= 0) return `已下载 ${done}`;
  const percent = Math.min(100, Math.floor((downloaded / total) * 100));
  return `已下载 ${done} / ${formatBytes(total)}（${percent}%）`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** 更新日志按纯文本展示，避免把外部内容当 HTML 注入。 */
export function normalizeReleaseNotes(body: string | null): string | null {
  if (body === null) return null;
  const trimmed = body.trim();
  return trimmed === '' ? null : trimmed;
}
