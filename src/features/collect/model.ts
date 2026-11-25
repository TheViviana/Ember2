export type InboxItem =
  | { readonly id: string; readonly kind: 'text'; readonly text: string; readonly createdAt: number }
  | {
      readonly id: string;
      readonly kind: 'link';
      readonly url: string;
      readonly label: string;
      readonly createdAt: number;
    }
  | {
      readonly id: string;
      readonly kind: 'file';
      readonly path: string;
      readonly name: string;
      readonly createdAt: number;
    };

export type InboxDragPayload =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'files'; readonly paths: readonly string[] };

export interface InboxItemFactory {
  id(): string;
  now(): number;
}

export function fileNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized;
}

export function createTextItem(
  text: string,
  factory: InboxItemFactory,
): InboxItem | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return { id: factory.id(), kind: 'text', text: trimmed, createdAt: factory.now() };
}

export function createLinkItem(
  url: string,
  label: string,
  factory: InboxItemFactory,
): InboxItem | null {
  const trimmedUrl = url.trim();
  try {
    const parsed = new URL(trimmedUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  } catch {
    return null;
  }
  return {
    id: factory.id(),
    kind: 'link',
    url: trimmedUrl,
    label: label.trim() || trimmedUrl,
    createdAt: factory.now(),
  };
}

/** 文件引用按原始路径去重；不会复制或读取源文件。 */
export function addFileItems(
  current: readonly InboxItem[],
  paths: readonly string[],
  factory: InboxItemFactory,
): { readonly items: readonly InboxItem[]; readonly added: number } {
  const known = new Set(
    current.filter((item) => item.kind === 'file').map((item) => item.path),
  );
  const added: InboxItem[] = [];
  for (const path of paths) {
    if (path === '' || known.has(path)) continue;
    known.add(path);
    added.push({
      id: factory.id(),
      kind: 'file',
      path,
      name: fileNameFromPath(path),
      createdAt: factory.now(),
    });
  }
  return added.length === 0
    ? { items: current, added: 0 }
    : { items: [...added.reverse(), ...current], added: added.length };
}

function escapeLabel(label: string): string {
  return label.replace(/[\\[\]]/g, '\\$&');
}

function escapeDestination(url: string): string {
  return url.replace(/[\\()]/g, '\\$&');
}

/** 文本和链接统一走 TextPayload；文件引用统一走 FilesPayload。 */
export function inboxItemDragPayload(item: InboxItem): InboxDragPayload {
  if (item.kind === 'file') return { kind: 'files', paths: [item.path] };
  if (item.kind === 'link') {
    return {
      kind: 'text',
      text: `[${escapeLabel(item.label)}](${escapeDestination(item.url)})`,
    };
  }
  return { kind: 'text', text: item.text };
}
