/**
 * 设置首页「最近使用」：只记录真正打开过的页面，按库无关的全局偏好持久化。
 * 读取时校验字符串、去重并截断，坏数据直接回退空列表。
 */

export const SETTINGS_RECENT_KEY = 'ember.settings.recent.v1';
export const SETTINGS_RECENT_LIMIT = 3;

export interface SettingsRecentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function normalize(ids: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || id === '') continue;
    if (out.includes(id)) continue;
    out.push(id);
    if (out.length >= SETTINGS_RECENT_LIMIT) break;
  }
  return out;
}

export function loadRecentSettings(storage: SettingsRecentStorage): string[] {
  try {
    const raw = storage.getItem(SETTINGS_RECENT_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? normalize(parsed) : [];
  } catch {
    return [];
  }
}

export function recordRecentSetting(storage: SettingsRecentStorage, id: string): string[] {
  const next = normalize([id, ...loadRecentSettings(storage)]);
  try {
    storage.setItem(SETTINGS_RECENT_KEY, JSON.stringify(next));
  } catch {
    // 配额/隐私模式失败只影响最近列表，不阻断设置导航。
  }
  return next;
}
