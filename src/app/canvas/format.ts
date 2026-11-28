/**
 * 画布格式层：只负责 `.canvas.json` 信封的解析与序列化。
 *
 * 版本 `CANVAS_SCHEMA_VERSION`（CR-20261117-02 §1）：v1 文件只报
 * `E_UNSUPPORTED_VERSION`，不静默升级、不改写字节。v2 画布可读入并在内存中
 * 归一为 v3，首次保存写回 v3（单向升级，旧版 Ember 将拒开）。
 *
 * 信封类型与版本常量统一取自 `#canvas-format` 单源；不定义节点/连线 schema：
 * `nodes` / `edges` 只校验为数组，内部字段原样保留；未知顶层键同样保留，
 * 避免旧版本读入后写回丢字段。
 */
import { CANVAS_SCHEMA_VERSION } from '#canvas-format';
import type { CanvasDocument } from '#canvas-format';

/** 保留本模块既有导出面；类型定义来源仍是 `#canvas-format` 单源。 */
export type { CanvasDocument };

export type CanvasFormatErrorCode = 'E_FORMAT' | 'E_UNSUPPORTED_VERSION';

export class CanvasFormatError extends Error {
  readonly code: CanvasFormatErrorCode;

  constructor(code: CanvasFormatErrorCode, message: string) {
    super(message);
    this.name = 'CanvasFormatError';
    this.code = code;
  }
}

export function createEmptyCanvasDocument(): CanvasDocument {
  return { schemaVersion: CANVAS_SCHEMA_VERSION, nodes: [], edges: [] };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 解析信封；结构不合法一律抛 CanvasFormatError，绝不静默降级。 */
export function parseCanvasDocument(text: string): CanvasDocument {
  if (text.trim() === '') {
    throw new CanvasFormatError('E_FORMAT', '画布文件为空');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new CanvasFormatError('E_FORMAT', '画布文件不是合法 JSON');
  }

  if (!isRecord(raw)) {
    throw new CanvasFormatError('E_FORMAT', '画布文件顶层必须是对象');
  }
  const version = raw.schemaVersion;
  const supported = version === 2 || version === CANVAS_SCHEMA_VERSION;
  if (!supported) {
    throw new CanvasFormatError(
      'E_UNSUPPORTED_VERSION',
      `不支持的画布版本：${String(raw.schemaVersion ?? raw.version)}`,
    );
  }
  if (!Array.isArray(raw.nodes)) {
    throw new CanvasFormatError('E_FORMAT', '画布文件缺少 nodes 数组');
  }
  if (!Array.isArray(raw.edges)) {
    throw new CanvasFormatError('E_FORMAT', '画布文件缺少 edges 数组');
  }

  return { ...raw, schemaVersion: CANVAS_SCHEMA_VERSION, nodes: raw.nodes, edges: raw.edges };
}

/** 读入 v2 旧文件：用于提示「保存后将单向升级为 v3」。 */
export function isLegacyCanvasText(text: string): boolean {
  try {
    const raw: unknown = JSON.parse(text);
    return isRecord(raw) && raw.schemaVersion === 2;
  } catch {
    return false;
  }
}

/** 序列化：2 空格缩进 + 末尾换行，保证 diff 稳定。 */
export function serializeCanvasDocument(document: CanvasDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
