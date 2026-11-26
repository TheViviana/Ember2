/**
 * CR-20261119-05：文档节点预览访问器（纯逻辑，不碰 DOM，可在 node 下测试）。
 *
 * - 正文来源优先级：已打开文档的 live text → 否则 `vault_read` 一次性只读快照；
 * - 五层护栏中的三层在这里落地：正文 LRU ≤ 8 篇、单篇 ≤ 20000 字符、
 *   元数据 LRU ≤ 32 篇；视口裁剪与懒加载由 node-layer / engine 负责；
 * - frontmatter 解析统一走 core 的 parseFrontmatter 单源；只取 `summary`（string）
 *   与 `tags`（string[]）；无 frontmatter、解析报错或类型不符一律降级为空元数据，
 *   不抛错、不报错。
 */
import { parseFrontmatter } from '../../core/markdown.ts';

/** 单篇正文快照的字符上限；超出即截断并附提示。 */
export const PREVIEW_TEXT_MAX_CHARS = 20000;

/** 正文快照同时驻留的篇数上限。 */
export const PREVIEW_TEXT_CACHE_SIZE = 8;

/** 卡片元数据同时驻留的篇数上限。 */
export const PREVIEW_META_CACHE_SIZE = 32;

/** CR-20261121-56：卡片标签最多展示的 chips 数（用户裁定 3 个）；多余显示 `+n`。 */
export const CARD_TAG_LIMIT = 3;

/**
 * CR-20261121-56：卡片字数展示（第 2 行右侧）。≥1000 折算 k（2.4k 字），
 * <1000 原数；无正文/0 返回空串（不占行）。
 */
export function formatWordCount(words: number): string {
  if (!Number.isFinite(words) || words <= 0) return '';
  if (words >= 1000) {
    const k = words / 1000;
    const text = k >= 100 ? String(Math.round(k)) : k.toFixed(1);
    return `${text}k 字`;
  }
  return `${words} 字`;
}

/** 卡片无简介时的降级文案。 */
export const EMPTY_SUMMARY_TEXT = '暂无简介';

/** 正文截断后的尾部提示。 */
export const PREVIEW_TRUNCATED_HINT = '内容过长已截断，双击节点打开编辑查看全文';

/** 快照来源（非编辑器 live text）的次要提示。 */
export const PREVIEW_SNAPSHOT_HINT = '预览快照';

/** 读取失败时的降级提示（显式失败态，不吞错误）。 */
export const PREVIEW_UNAVAILABLE_HINT = '预览不可用，双击节点打开编辑查看';

export interface CardMetadata {
  readonly summary: string | null;
  readonly tags: readonly string[];
}

export interface PreviewText {
  readonly text: string;
  readonly truncated: boolean;
  /** true = 来自已打开编辑器的 live text；false = vault_read 只读快照。 */
  readonly fromLive: boolean;
  /** true = 读取失败；UI 显示降级提示而非空正文。 */
  readonly failed: boolean;
}

export interface DocPreviewDeps {
  readonly readLiveText: (path: string) => string | null;
  readonly readSnapshot: (path: string) => Promise<string>;
  /** 正文/元数据到达后通知引擎重绘（不得在此抛错）。 */
  readonly onUpdate?: (path: string) => void;
}

export interface DocPreviewService {
  /** 已缓存的元数据；live 文档即时解析，不走缓存。 */
  getMeta(path: string): CardMetadata | null;
  /** 已缓存的正文；live 文档即时截断，不走缓存。 */
  getText(path: string): PreviewText | null;
  requestMeta(path: string): Promise<void>;
  requestText(path: string): Promise<void>;
  /** CR-20261122-62：外部写入后失效指定路径；在途旧读取不得回填新快照。 */
  invalidate(path: string): void;
  /** 测试与观测：当前缓存条目数及在途读取数。 */
  readonly textCacheSize: number;
  readonly metaCacheSize: number;
  readonly pendingRequests: number;
  clear(): void;
  dispose(): void;
}

interface LruCache<K, V> {
  get(key: K): V | undefined;
  has(key: K): boolean;
  set(key: K, value: V): void;
  delete(key: K): void;
  clear(): void;
  readonly size: number;
}

/** 简单 LRU：Map 插入序即新旧序，get 命中后移到尾部。 */
export function createLruCache<K, V>(capacity: number): LruCache<K, V> {
  const store = new Map<K, V>();
  const limit = Math.max(1, Math.floor(capacity));
  return {
    get(key: K): V | undefined {
      if (!store.has(key)) return undefined;
      const value = store.get(key) as V;
      store.delete(key);
      store.set(key, value);
      return value;
    },
    has(key: K): boolean {
      return store.has(key);
    },
    set(key: K, value: V): void {
      if (store.has(key)) store.delete(key);
      store.set(key, value);
      while (store.size > limit) {
        const oldest = store.keys().next();
        if (oldest.done === true) break;
        store.delete(oldest.value);
      }
    },
    delete(key: K): void {
      store.delete(key);
    },
    clear(): void {
      store.clear();
    },
    get size(): number {
      return store.size;
    },
  };
}

const EMPTY_METADATA: CardMetadata = Object.freeze({ summary: null, tags: [] });

/** CR-20261121-45：frontmatter 无 summary 时的摘要回退——取正文第一条散文行。
 * 剥 frontmatter；跳过代码围栏/标题/列表/引用/表格/图片/链接定义行；剥行内标记；超长截断加省略号。
 * 纯函数：行级启发式，不做完整 Markdown 解析。 */
const SUMMARY_FALLBACK_MAX_CHARS = 120;

export function deriveSummaryFallback(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let index = 0;
  if ((lines[0] ?? '').trim() === '---') {
    index = 1;
    while (index < lines.length && (lines[index] ?? '').trim() !== '---') index += 1;
    index += 1;
  }
  let inFence = false;
  for (; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line === '' || line === '---') continue;
    if (/^(#|>|\||[-*+]\s|!\[|\[.+]:)/.test(line)) continue;
    const plain = line
      .replace(/\*\*|__|~~|`/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .trim();
    if (plain !== '') {
      return plain.length > SUMMARY_FALLBACK_MAX_CHARS
        ? `${plain.slice(0, SUMMARY_FALLBACK_MAX_CHARS)}…`
        : plain;
    }
  }
  return '';
}

/** frontmatter 单源解析：只读取 summary（string）与 tags（string[]）。 */
export function parseCardMetadata(text: string): CardMetadata {
  const frontmatter = parseFrontmatter(text).frontmatter;
  if (frontmatter === null) return EMPTY_METADATA;
  const summary = typeof frontmatter.summary === 'string' ? frontmatter.summary : null;
  const tags = Array.isArray(frontmatter.tags)
    ? frontmatter.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  return { summary, tags };
}

function clampText(raw: string, fromLive: boolean): PreviewText {
  const body = parseFrontmatter(raw).body;
  if (body.length <= PREVIEW_TEXT_MAX_CHARS) {
    return { text: body, truncated: false, fromLive, failed: false };
  }
  return {
    text: body.slice(0, PREVIEW_TEXT_MAX_CHARS),
    truncated: true,
    fromLive,
    failed: false,
  };
}

const FAILED_TEXT: PreviewText = Object.freeze({
  text: '',
  truncated: false,
  fromLive: false,
  failed: true,
});

/**
 * 预览访问器：正文与元数据两条独立 LRU；in-flight 去重；live text 优先。
 * 读取失败记录为显式 failed 条目（不重试风暴、不吞错），UI 显示降级提示。
 */
export function createDocPreviewService(deps: DocPreviewDeps): DocPreviewService {
  const textCache = createLruCache<string, PreviewText>(PREVIEW_TEXT_CACHE_SIZE);
  const metaCache = createLruCache<string, CardMetadata>(PREVIEW_META_CACHE_SIZE);
  const textInFlight = new Map<string, Promise<void>>();
  const metaInFlight = new Map<string, Promise<void>>();
  const livePaths = new Set<string>();
  let disposed = false;

  const invalidate = (path: string): void => {
    textCache.delete(path);
    metaCache.delete(path);
    textInFlight.delete(path);
    metaInFlight.delete(path);
  };

  const readLive = (path: string): string | null => {
    const live = deps.readLiveText(path);
    if (live !== null) {
      livePaths.add(path);
      return live;
    }
    if (livePaths.delete(path)) invalidate(path);
    return null;
  };

  const notify = (path: string): void => {
    if (disposed) return;
    deps.onUpdate?.(path);
  };

  const requestText = (path: string): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (readLive(path) !== null) return Promise.resolve();
    if (textCache.has(path)) return Promise.resolve();
    const inFlight = textInFlight.get(path);
    if (inFlight !== undefined) return inFlight;
    const task: Promise<void> = deps
      .readSnapshot(path)
      .then((text) => {
        if (textInFlight.get(path) === task) textCache.set(path, clampText(text, false));
      })
      .catch(() => {
        if (textInFlight.get(path) === task) textCache.set(path, FAILED_TEXT);
      })
      .then(() => {
        if (textInFlight.get(path) !== task) return;
        textInFlight.delete(path);
        notify(path);
      });
    textInFlight.set(path, task);
    return task;
  };

  const requestMeta = (path: string): Promise<void> => {
    if (disposed) return Promise.resolve();
    const live = readLive(path);
    if (live !== null) {
      metaCache.set(path, parseCardMetadata(live));
      return Promise.resolve();
    }
    if (metaCache.has(path)) return Promise.resolve();
    const inFlight = metaInFlight.get(path);
    if (inFlight !== undefined) return inFlight;
    const task: Promise<void> = deps
      .readSnapshot(path)
      .then((text) => {
        if (metaInFlight.get(path) === task) metaCache.set(path, parseCardMetadata(text));
      })
      .catch(() => {
        if (metaInFlight.get(path) === task) metaCache.set(path, EMPTY_METADATA);
      })
      .then(() => {
        if (metaInFlight.get(path) !== task) return;
        metaInFlight.delete(path);
        notify(path);
      });
    metaInFlight.set(path, task);
    return task;
  };

  return {
    getMeta(path: string): CardMetadata | null {
      const live = readLive(path);
      if (live !== null) return parseCardMetadata(live);
      return metaCache.get(path) ?? null;
    },
    getText(path: string): PreviewText | null {
      const live = readLive(path);
      if (live !== null) return clampText(live, true);
      return textCache.get(path) ?? null;
    },
    requestMeta,
    requestText,
    get textCacheSize(): number {
      return textCache.size;
    },
    get metaCacheSize(): number {
      return metaCache.size;
    },
    get pendingRequests(): number {
      return textInFlight.size + metaInFlight.size;
    },
    invalidate,
    clear(): void {
      textCache.clear();
      metaCache.clear();
      textInFlight.clear();
      metaInFlight.clear();
      livePaths.clear();
    },
    dispose(): void {
      disposed = true;
      textCache.clear();
      metaCache.clear();
      textInFlight.clear();
      metaInFlight.clear();
      livePaths.clear();
    },
  };
}
