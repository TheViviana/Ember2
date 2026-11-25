import type { InboxItem } from './model.ts';

export const INBOX_STORAGE_PREFIX = 'ember2:inbox:v1:';

export interface InboxStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface InboxLoadResult {
  readonly items: readonly InboxItem[];
  readonly warning: string | null;
}

export function inboxStorageKey(vaultId: string): string {
  return `${INBOX_STORAGE_PREFIX}${vaultId}`;
}

function validBase(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['id'] === 'string' &&
    record['id'].length > 0 &&
    typeof record['createdAt'] === 'number' &&
    Number.isFinite(record['createdAt']) &&
    record['createdAt'] >= 0
  );
}

function validItem(value: unknown): value is InboxItem {
  if (!validBase(value)) return false;
  if (value['kind'] === 'text') {
    return typeof value['text'] === 'string' && value['text'].length > 0;
  }
  if (value['kind'] === 'link') {
    return (
      typeof value['url'] === 'string' &&
      value['url'].length > 0 &&
      typeof value['label'] === 'string' &&
      value['label'].length > 0
    );
  }
  if (value['kind'] === 'file') {
    return (
      typeof value['path'] === 'string' &&
      value['path'].length > 0 &&
      typeof value['name'] === 'string' &&
      value['name'].length > 0
    );
  }
  return false;
}

export function loadInboxItems(storage: InboxStorage, vaultId: string): InboxLoadResult {
  let raw: string | null;
  try {
    raw = storage.getItem(inboxStorageKey(vaultId));
  } catch {
    return { items: [], warning: '收集箱读取失败，本次会话将使用空列表' };
  }
  if (raw === null) return { items: [], warning: null };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    const record = parsed as Record<string, unknown>;
    if (record['version'] !== 1 || !Array.isArray(record['items'])) throw new Error();
    if (!record['items'].every((item: unknown) => validItem(item))) throw new Error();
    return { items: record['items'], warning: null };
  } catch {
    return { items: [], warning: '收集箱数据已损坏，已回退为空列表' };
  }
}

/** 返回 null 表示持久化成功；任何存储异常都必须由 UI 显示。 */
export function saveInboxItems(
  storage: InboxStorage,
  vaultId: string,
  items: readonly InboxItem[],
): string | null {
  try {
    storage.setItem(inboxStorageKey(vaultId), JSON.stringify({ version: 1, items }));
    return null;
  } catch (error: unknown) {
    const detail = error instanceof Error && error.message !== '' ? `：${error.message}` : '';
    return `本次更改未持久化${detail}`;
  }
}
