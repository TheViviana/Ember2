/**
 * 粘贴截图：只接管剪贴板里的图片文件，文本粘贴仍交 CodeMirror 原生处理。
 * 图片先经宿主写入媒体库，再在光标处插入 Markdown 图片引用。
 */
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import type { EditorFileReference, EditorHost } from './host.ts';
import { mediaMarkdown, type EditorNoticeTone } from './drop.ts';

export interface ClipboardItemLike {
  readonly kind: string;
  readonly type: string;
  getAsFile(): File | null;
}

export interface ClipboardDataLike {
  readonly files?: ArrayLike<File>;
  readonly items?: ArrayLike<ClipboardItemLike>;
}

/** 剪贴板中的图片文件；优先 `files`，兼容只提供 `items` 的 WebKit。 */
export function clipboardImageFiles(data: ClipboardDataLike | null): File[] {
  if (data === null) return [];
  const direct = Array.from(data.files ?? []).filter((file) => file.type.startsWith('image/'));
  if (direct.length > 0) return direct;
  const out: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file !== null) out.push(file);
  }
  return out;
}

/** 浏览器与 Node 都可用的分块 base64，避免大图触发参数栈溢出。 */
export function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/** 多张粘贴图按行拼接，保持一次粘贴的时间顺序。 */
export function pastedImageMarkdown(paths: readonly string[]): string {
  return paths.map((path) => mediaMarkdown(path, 'image')).join('\n');
}

export interface PasteImageDeps {
  /** 宿主写入媒体库；失败抛错或返回 null，由本扩展统一提示。 */
  readonly save: (file: File) => Promise<EditorFileReference | null>;
  readonly notice: (message: string, tone: EditorNoticeTone) => void;
}

async function insertImages(
  view: EditorView,
  files: readonly File[],
  deps: PasteImageDeps,
): Promise<void> {
  deps.notice(`正在保存 ${files.length} 张图片…`, 'info');
  const paths: string[] = [];
  for (const file of files) {
    let reference: EditorFileReference | null;
    try {
      reference = await deps.save(file);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : '未知错误';
      deps.notice(`图片入库失败：${detail}`, 'error');
      return;
    }
    if (reference === null) {
      deps.notice('图片入库失败：当前库不可写', 'error');
      return;
    }
    paths.push(reference.path);
  }
  if (paths.length === 0) return;
  const insert = pastedImageMarkdown(paths);
  const position = view.state.selection.main.head;
  view.dispatch({
    changes: { from: position, insert },
    selection: { anchor: position + insert.length },
  });
}

/** EditorView 用 ref 取最新宿主：扩展只在实例创建时装配一次。 */
export function hostPasteExtension(
  host: () => EditorHost,
  notice: () => ((message: string, tone: EditorNoticeTone) => void) | undefined,
): Extension {
  return pasteImageExtension({
    save: (file) => host().saveClipboardImage?.(file) ?? Promise.resolve(null),
    notice: (message, tone) => notice()?.(message, tone),
  });
}

export function pasteImageExtension(deps: PasteImageDeps): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const files = clipboardImageFiles(event.clipboardData);
      if (files.length === 0) return false;
      event.preventDefault();
      if (view.state.readOnly) {
        deps.notice('编辑器只读，无法插入图片', 'warning');
        return true;
      }
      void insertImages(view, files, deps);
      return true;
    },
  });
}
