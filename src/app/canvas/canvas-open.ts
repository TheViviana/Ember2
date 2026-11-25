/**
 * C0-C：画布打开/新建的纯逻辑（不碰 React/DOM，可在 node 下测试）。
 *
 * - 新建严格走 Core：open 登记 → 已存在不 save → 不存在才 save(空文档)；
 *   并发创建由 Rust 条件写返回 E_CONFLICT，UI 只提示并刷新，不改名重试。
 * - 打开结果三分支：不存在 / 致命信封（v1、非法 JSON、非 v2）/ 可挂载
 *   （无 issues 或含 issues 的 R8=A 只读）。
 */
import type { CanvasSchemaIssue } from '#canvas-format';
import type { CanvasEntryReason } from '../../types/ipc';
import type {
  CanvasOpenResult,
  CanvasSaveOptions,
  CanvasSaveSuccess,
} from '../../core/canvas/ports';
import {
  createEmptyCanvasDocument,
  parseCanvasDocument,
  serializeCanvasDocument,
  type CanvasDocument,
} from './format.ts';
import { inspectCanvasDocument } from './schema-adapter.ts';
import { formatUnknownError } from '../../core/errors.ts';

/** Rust 条件创建的期望 sha：空串表示目标不存在（与 Core 已登记值一致）。 */
export const EXPECTED_MISSING_SHA = '';

/** 新建画布写入的最小合法 v2 文档（2 空格缩进 + 末尾换行由 serializer 固定）。 */
export const EMPTY_CANVAS_TEXT = serializeCanvasDocument(createEmptyCanvasDocument());

export type CanvasOpenClassification =
  | { readonly kind: 'missing' }
  | { readonly kind: 'fatal'; readonly code: string; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly document: CanvasDocument;
      readonly issues: readonly CanvasSchemaIssue[];
      readonly readOnly: boolean;
    };

export type CanvasCreateResult =
  | { readonly kind: 'created' }
  | { readonly kind: 'exists' }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string };

export interface CanvasCreateStore {
  open(id: string): Promise<CanvasOpenResult>;
  save(id: string, text: string, options?: CanvasSaveOptions): Promise<CanvasSaveSuccess>;
}

const REASON_LABELS: Readonly<Record<CanvasEntryReason, string>> = {
  bad_id: '画布 id 不合法',
  symlink: '画布文件是符号链接',
  not_regular_file: '画布路径不是普通文件',
  io_error: '读取画布信息失败',
};

export function canvasEntryReasonLabel(reason: CanvasEntryReason | undefined): string {
  return reason === undefined ? '读取画布信息失败' : REASON_LABELS[reason];
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'E_FORMAT';
}

/** 解析并检查信封；致命错误不外抛，交给调用方通知并 abortMount。 */
export function classifyCanvasOpen(opened: CanvasOpenResult): CanvasOpenClassification {
  if (!opened.exists || opened.text === null) return { kind: 'missing' };
  try {
    const document = parseCanvasDocument(opened.text);
    const schema = inspectCanvasDocument(document);
    return {
      kind: 'ready',
      document,
      issues: schema.issues,
      readOnly: schema.readOnly,
    };
  } catch (error: unknown) {
    return { kind: 'fatal', code: errorCode(error), message: formatUnknownError(error, '未知画布错误') };
  }
}

/**
 * 打开即登记（Core 记录 sha）；不存在才用 EXPECTED_MISSING_SHA 条件创建。
 * 已存在返回 `exists` 且不写盘，外部并发创建同样按 `exists` 处理。
 */
export async function createCanvasSession(
  rawId: string,
  store: CanvasCreateStore,
): Promise<CanvasCreateResult> {
  const id = rawId.trim();
  if (id === '') {
    return { kind: 'failed', code: 'bad_id', message: REASON_LABELS.bad_id };
  }
  try {
    const opened = await store.open(id);
    if (opened.exists) return { kind: 'exists' };
    try {
      await store.save(id, EMPTY_CANVAS_TEXT);
      return { kind: 'created' };
    } catch (error: unknown) {
      // 外部并发创建：条件写冲突，提示已存在并刷新，不自动改名重试。
      if (errorCode(error) === 'E_CONFLICT') return { kind: 'exists' };
      throw error;
    }
  } catch (error: unknown) {
    return { kind: 'failed', code: errorCode(error), message: formatUnknownError(error, '未知画布错误') };
  }
}
