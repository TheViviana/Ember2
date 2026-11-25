/**
 * CR-20261122-67 §3：文档树自定义排序的本地持久化。
 *
 * 排序以「知识库根路径」为键隔离，值为 `{ [dirPath]: childNames[] }`——每个目录一份
 * 子节点（目录 + 文章）的期望顺序。仅当某目录登记了顺序时才覆盖默认的「目录在前、
 * 各自按名称码点排序」；未登记的目录保持默认。
 *
 * 存 localStorage（进程外持久，重启保留）；无 DOM 的测试环境注入内存 Storage。
 */

export type DocOrderMap = { readonly [dirPath: string]: readonly string[] };

const PREFIX = 'ember.doc-order.';

/** 根路径可能含斜杠等字符，转成安全的 localStorage 键片段。 */
export function docOrderKey(root: string): string {
  const safe = root.replace(/[^A-Za-z0-9]+/g, '_');
  return `${PREFIX}${safe || 'default'}`;
}

interface MinimalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const fallbackStorage: { storage: MinimalStorage | null } = { storage: null };
function resolveStorage(storage?: MinimalStorage | null): MinimalStorage {
  if (storage !== undefined && storage !== null) return storage;
  if (typeof globalThis.localStorage !== 'undefined' && globalThis.localStorage !== null) {
    return globalThis.localStorage;
  }
  if (fallbackStorage.storage === null) fallbackStorage.storage = createMemoryStorage();
  return fallbackStorage.storage;
}

function createMemoryStorage(): MinimalStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
  };
}

function parseOrder(raw: string | null): DocOrderMap {
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [dir, names] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        !Array.isArray(names) ||
        !names.every((n): n is string => typeof n === 'string' && n.length > 0)
      ) {
        continue;
      }
      out[dir] = [...names];
    }
    return out;
  } catch {
    return {};
  }
}

export function loadDocOrder(root: string, storage?: MinimalStorage): DocOrderMap {
  return parseOrder(resolveStorage(storage).getItem(docOrderKey(root)));
}

export function saveDocOrder(root: string, order: DocOrderMap, storage?: MinimalStorage): void {
  resolveStorage(storage).setItem(docOrderKey(root), JSON.stringify(order));
}

/** 取某目录的登记顺序；未登记返回 undefined（buildTree 回退默认排序）。 */
export function orderedChildren(
  root: string,
  dir: string,
  storage?: MinimalStorage,
): readonly string[] | undefined {
  return loadDocOrder(root, storage)[dir];
}

/** 覆写某目录的完整子节点顺序（写入即视为已登记）。 */
export function setChildOrder(
  root: string,
  dir: string,
  names: readonly string[],
  storage?: MinimalStorage,
): void {
  const store = resolveStorage(storage);
  const order = parseOrder(store.getItem(docOrderKey(root)));
  const next = { ...order, [dir]: [...names] };
  store.setItem(docOrderKey(root), JSON.stringify(next));
}

/** 从某目录的登记顺序里移除一个子节点；清空后删除该目录键（回退默认）。 */
export function removeChildFromOrder(
  root: string,
  dir: string,
  name: string,
  storage?: MinimalStorage,
): void {
  const store = resolveStorage(storage);
  const order = parseOrder(store.getItem(docOrderKey(root)));
  const current = order[dir];
  if (current === undefined) return;
  const next = current.filter((n) => n !== name);
  const merged = { ...order };
  if (next.length === 0) delete merged[dir];
  else merged[dir] = next;
  store.setItem(docOrderKey(root), JSON.stringify(merged));
}

/** 清空整个知识库的自定义排序（右键空白「重置排序」）。 */
export function resetDocOrder(root: string, storage?: MinimalStorage): void {
  resolveStorage(storage).removeItem(docOrderKey(root));
}
