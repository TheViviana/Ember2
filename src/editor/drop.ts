/**
 * CR-20261118-04 C1-D：编辑器拖放纯逻辑（不碰 CodeMirror 装配）。
 *
 * gate:layers 禁止非 app 层 import `src/app/**`，因此这里只镜像拖拽协议的
 * MIME 常量与媒体载荷形状，不复制落点注册表或其它 app 逻辑；协议定义本身不改。
 */

import { fileNameFromPath, libraryMediaKind } from '../core/media-kind.ts';
import type { EditorFileReference } from './host.ts';

export type EditorNoticeTone = 'info' | 'warning' | 'error';

export const EDITOR_DND_MIME = 'application/x-ember-dnd';
export const EDITOR_DND_FALLBACK_MIME = 'text/plain';

/** 与 core 同口径：先按目录前缀，再按扩展名兜底；编辑器不接受 `doc`，映射为 `null`。 */
export function mediaKindFromLibraryPath(path: string): 'image' | 'audio' | 'video' | null {
  const kind = libraryMediaKind(path);
  return kind === 'doc' ? null : kind;
}

/** 文件名作 Markdown 链接文字；路径异常为空时回退原文。 */
export function mediaLabelFromPath(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name === '' ? path : name;
}

function escapeMarkdownLabel(label: string): string {
  return label.replace(/[\\[\]]/g, '\\$&');
}

function escapeMarkdownDestination(path: string): string {
  return path.replace(/[\\()]/g, '\\$&');
}

/** 图片用 `![]()`，音频/视频/无法判型用普通链接 `[]()`。 */
export function mediaMarkdown(
  path: string,
  kind: 'image' | 'audio' | 'video' | null,
  label = mediaLabelFromPath(path),
): string {
  const text = escapeMarkdownLabel(label);
  const destination = escapeMarkdownDestination(path);
  return kind === 'image' ? `![${text}](${destination})` : `[${text}](${destination})`;
}

export type EditorMediaReadResult =
  | {
      readonly ok: true;
      readonly path: string;
      readonly kind: 'image' | 'audio' | 'video' | null;
      readonly label?: string;
    }
  | { readonly ok: false; readonly reason: string; readonly tone: EditorNoticeTone };

type DropRecord = Readonly<Record<string, unknown>>;

function parseDropRecord(raw: string): DropRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as DropRecord;
}

function readMediaRecord(record: DropRecord): EditorMediaReadResult {
  if (record['kind'] !== 'media') {
    return { ok: false, reason: '此处仅支持媒体插入', tone: 'warning' };
  }
  const path = record['path'];
  if (typeof path !== 'string' || path === '') {
    return { ok: false, reason: '媒体路径缺失', tone: 'error' };
  }
  return { ok: true, path, kind: mediaKindFromLibraryPath(path) };
}

/**
 * 读取 `media` 载荷：自定义 MIME 优先，`text/plain` 降级。
 * editor 落点只接受 media，其余类型按注册表语义显式拒绝。
 */
export function readMediaDropPayload(
  getData: (format: string) => string,
): EditorMediaReadResult {
  const custom = getData(EDITOR_DND_MIME);
  const raw = custom.length > 0 ? custom : getData(EDITOR_DND_FALLBACK_MIME);
  if (raw.length === 0) {
    return { ok: false, reason: '拖拽数据为空', tone: 'error' };
  }

  const record = parseDropRecord(raw);
  if (record === null) {
    return { ok: false, reason: '此处仅支持媒体插入', tone: 'warning' };
  }
  return readMediaRecord(record);
}

export type EditorDropCoordination =
  | { readonly kind: 'native' }
  | { readonly kind: 'intercept'; readonly read: EditorMediaReadResult };

/**
 * drop capture 协调：纯文本与编辑器选区的 text 载荷交 CodeMirror 原生处理；
 * 自定义 media 载荷进入插入流程，doc 等其它自定义载荷显式拒绝并阻止下落。
 */
export function coordinateEditorDrop(
  getData: (format: string) => string,
): EditorDropCoordination {
  const custom = getData(EDITOR_DND_MIME);
  if (custom.length === 0) return { kind: 'native' };

  const record = parseDropRecord(custom);
  if (record?.['kind'] === 'text') return { kind: 'native' };
  return {
    kind: 'intercept',
    read: record === null
      ? { ok: false, reason: '此处仅支持媒体插入', tone: 'warning' }
      : readMediaRecord(record),
  };
}

export interface EditorDropPlan {
  readonly insert: string;
  readonly mediaKind: 'image' | 'audio' | 'video' | null;
  readonly notice?: { readonly message: string; readonly tone: EditorNoticeTone };
}

export type EditorDropOutcome =
  | { readonly ok: true; readonly plan: EditorDropPlan }
  | { readonly ok: false; readonly message: string; readonly tone: EditorNoticeTone };

/**
 * 失败与只读的统一裁决：只读、读取失败、类型不支持均返回显式提示；
 * 媒体无法判型时仍插入通用链接并附提示。
 */
export function planEditorDrop(
  readOnly: boolean,
  read: EditorMediaReadResult,
): EditorDropOutcome {
  if (readOnly) {
    return { ok: false, message: '编辑器只读，无法插入', tone: 'warning' };
  }
  if (!read.ok) {
    return { ok: false, message: read.reason, tone: read.tone };
  }
  return {
    ok: true,
    plan: {
      insert: mediaMarkdown(read.path, read.kind, read.label),
      mediaKind: read.kind,
      ...(read.kind === null
        ? { notice: { message: '无法判定媒体类型，已按普通链接插入', tone: 'warning' as const } }
        : {}),
    },
  };
}

/** 拖拽选区时写入的 text 载荷（与协议序列化同为 JSON.stringify）。 */
export function serializeTextPayload(text: string): string {
  return JSON.stringify({ kind: 'text', text });
}

export type EditorInboxPayload =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'files'; readonly paths: readonly string[] };

export interface EditorInboxDropDetail {
  readonly payload: EditorInboxPayload;
  readonly clientX: number;
  readonly clientY: number;
}

/** editor 层镜像应用内 CustomEvent 的结构校验，避免跨层导入 app。 */
export function readEditorInboxDropDetail(value: unknown): EditorInboxDropDetail | null {
  if (typeof value !== 'object' || value === null) return null;
  const detail = value as Record<string, unknown>;
  const payload = detail['payload'];
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const validText = record['kind'] === 'text' && typeof record['text'] === 'string';
  const paths = record['paths'];
  const validFiles = record['kind'] === 'files' &&
    Array.isArray(paths) &&
    paths.length > 0 &&
    paths.every((path: unknown) => typeof path === 'string' && path.length > 0);
  if (
    (!validText && !validFiles) ||
    typeof detail['clientX'] !== 'number' ||
    !Number.isFinite(detail['clientX']) ||
    typeof detail['clientY'] !== 'number' ||
    !Number.isFinite(detail['clientY'])
  ) {
    return null;
  }
  return {
    payload: payload as EditorInboxPayload,
    clientX: detail['clientX'],
    clientY: detail['clientY'],
  };
}

/** 任意外部文件不会生成 file:// 链接；仅插入 app 适配器解析出的库内引用。 */
export async function planEditorInboxDrop(
  readOnly: boolean,
  payload: EditorInboxPayload,
  resolve: (sourcePath: string) => Promise<EditorFileReference | null>,
): Promise<EditorDropOutcome> {
  if (readOnly) return { ok: false, message: '编辑器只读，无法插入', tone: 'warning' };
  if (payload.kind === 'text') {
    return { ok: true, plan: { insert: payload.text, mediaKind: null } };
  }
  const inserts: string[] = [];
  for (const sourcePath of payload.paths) {
    let reference: EditorFileReference | null;
    try {
      reference = await resolve(sourcePath);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `源文件校验失败：${detail}`, tone: 'error' };
    }
    if (reference === null) {
      return {
        ok: false,
        message: `源文件缺失或不在当前知识库：${fileNameFromPath(sourcePath)}`,
        tone: 'warning',
      };
    }
    const kind = reference.kind === 'media' ? mediaKindFromLibraryPath(reference.path) : null;
    inserts.push(mediaMarkdown(reference.path, kind));
  }
  return { ok: true, plan: { insert: inserts.join('\n'), mediaKind: null } };
}
