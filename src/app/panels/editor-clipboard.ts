/**
 * 粘贴截图的 app 侧桥接：读取 File 字节 → base64 → 媒体库，返回库内引用。
 * 编辑器层只依赖 EditorHost 端口，不直接触碰 IPC。
 */
import { mediaApi } from '../../data/app-api.ts';
import { bytesToBase64 } from '../../editor/paste.ts';
import type { EditorFileReference } from '../../editor/host.ts';

export async function saveClipboardImage(file: File): Promise<EditorFileReference | null> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0) return null;
  const saved = await mediaApi.saveBytes(bytesToBase64(bytes));
  return saved.kind === 'image' ? { kind: 'media', path: saved.path } : null;
}
