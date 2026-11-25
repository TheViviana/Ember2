/**
 * P6-C1 拖拽协议层：payload 定义与序列化 / 反序列化。
 *
 * 单一规则源：所有落点都必须经 `parsePayload` / `readPayload` 得到判别联合，
 * 不允许各组件自行解析 `dataTransfer`。
 * 反序列化对非法 JSON、未知 kind、缺字段、字段类型错误一律返回显式原因，不抛未捕获异常。
 */

/** 自定义拖拽 MIME。 */
export const DND_MIME = 'application/x-ember-dnd';

/** 纯文本兜底 MIME（外部纯文本拖拽，如拖选文字）。 */
export const DND_FALLBACK_MIME = 'text/plain';

export interface DocPayload {
  readonly kind: 'doc';
  readonly path: string;
}

export interface MediaPayload {
  readonly kind: 'media';
  readonly path: string;
}

export interface CanvasNodePayload {
  readonly kind: 'canvas-node';
  readonly nodeId: string;
  readonly canvasId: string;
}

export interface TextPayload {
  readonly kind: 'text';
  readonly text: string;
}

export interface FilesPayload {
  readonly kind: 'files';
  readonly paths: readonly string[];
}

/** 拖拽载荷判别联合。字段全部只读。 */
export type DndPayload = DocPayload | MediaPayload | CanvasNodePayload | TextPayload | FilesPayload;

export type DndKind = DndPayload['kind'];

export type ParseResult =
  | { readonly ok: true; readonly payload: DndPayload }
  | { readonly ok: false; readonly reason: string };

/** 读取拖拽数据的最小抽象，避免协议层依赖 DOM。 */
export interface DndDataSource {
  getData(format: string): string;
}

const KINDS: readonly DndKind[] = ['doc', 'media', 'canvas-node', 'text', 'files'];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(reason: string): ParseResult {
  return { ok: false, reason };
}

function parseKindObject(kind: DndKind, raw: Record<string, unknown>): ParseResult {
  switch (kind) {
    case 'doc':
    case 'media': {
      const path = raw['path'];
      if (!isNonEmptyString(path)) return invalid(`payload 的 ${kind}.path 缺失或不是非空字符串`);
      return { ok: true, payload: kind === 'doc' ? { kind: 'doc', path } : { kind: 'media', path } };
    }
    case 'canvas-node': {
      const nodeId = raw['nodeId'];
      const canvasId = raw['canvasId'];
      if (!isNonEmptyString(nodeId)) return invalid('payload 的 canvas-node.nodeId 缺失或不是非空字符串');
      if (!isNonEmptyString(canvasId)) return invalid('payload 的 canvas-node.canvasId 缺失或不是非空字符串');
      return { ok: true, payload: { kind: 'canvas-node', nodeId, canvasId } };
    }
    case 'text': {
      const text = raw['text'];
      if (typeof text !== 'string') return invalid('payload 的 text.text 缺失或不是字符串');
      return { ok: true, payload: { kind: 'text', text } };
    }
    case 'files': {
      const paths = raw['paths'];
      if (!Array.isArray(paths)) return invalid('payload 的 files.paths 缺失或不是数组');
      if (paths.length === 0) return invalid('payload 的 files.paths 为空数组');
      if (!paths.every((item: unknown) => isNonEmptyString(item))) {
        return invalid('payload 的 files.paths 含非字符串或空字符串项');
      }
      const items = paths.filter((item: unknown): item is string => isNonEmptyString(item));
      return { ok: true, payload: { kind: 'files', paths: items } };
    }
    default:
      return invalid('未知的 payload 类型');
  }
}

/** 序列化为可写入 dataTransfer 的字符串。调用方传入的载荷本身已由类型保证合法。 */
export function serializePayload(payload: DndPayload): string {
  return JSON.stringify(payload);
}

/** 反序列化并做完整结构校验。任何非法输入都返回显式原因。 */
export function parsePayload(raw: string): ParseResult {
  if (raw.length === 0) return invalid('payload 为空');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalid('payload 不是合法 JSON');
  }

  if (!isPlainObject(parsed)) return invalid('payload 不是对象');

  const kind = parsed['kind'];
  if (typeof kind !== 'string') return invalid('payload 缺少 kind');
  if (!KINDS.includes(kind as DndKind)) return invalid(`未知的 payload 类型：${kind}`);

  return parseKindObject(kind as DndKind, parsed);
}

/** 判断一段文本是否形如 JSON 对象，用于区分「非法载荷」与「普通纯文本」。 */
function looksLikeJsonObject(raw: string): boolean {
  return raw.trimStart().startsWith('{');
}

/**
 * 从拖拽数据源读取载荷。
 *
 * 1. 优先读自定义 MIME；
 * 2. 自定义 MIME 为空时读纯文本：可解析为 JSON 的按 JSON 校验，
 *    形如 JSON 但校验失败时保留失败原因（不降级为纯文本），
 *    其余纯文本按 `{ kind: 'text' }` 处理；
 * 3. 两者皆空时返回显式无效原因。
 */
export function readPayload(source: DndDataSource): ParseResult {
  const custom = source.getData(DND_MIME);
  if (custom.length > 0) return parsePayload(custom);

  const plain = source.getData(DND_FALLBACK_MIME);
  if (plain.length === 0) return invalid('拖拽数据为空');

  const parsed = parsePayload(plain);
  if (parsed.ok) return parsed;
  if (looksLikeJsonObject(plain)) return parsed;
  return { ok: true, payload: { kind: 'text', text: plain } };
}
