/**
 * 节点 DOM 层（C2）：只挂 `world-layer.getWorldElement()`（由 engine 传入），
 * 容器与节点元素均可注入，便于在 node 下测试「挂载点唯一、left/top = absolute - origin」。
 *
 * - 位置只在节点集合或 origin 变化时重算；平移/缩放只改世界层容器 transform；
 * - 交互（拖拽/选中）归 C3，本层 `pointer-events: none`，不抢 C1 的平移缩放；
 * - 不定义节点 schema：`extractNodes` 负责从文档取可渲染视图。
 */
import {
  hasOutsideNodeLabel,
  isFixedSizeNodeKind,
  isNodeContentMode,
  mediaUrlForPath,
  nodeLocalPosition,
  nodeOutsideLabelLayout,
  nodeScreenRect,
  NODE_WIDTH,
  type CanvasNodeView,
} from './node-layout.ts';
import { mediaLoadErrorMessage } from '../../features/media/media-playback.ts';
import {
  CARD_TAG_LIMIT,
  deriveSummaryFallback,
  formatWordCount,
  EMPTY_SUMMARY_TEXT,
  PREVIEW_SNAPSHOT_HINT,
  PREVIEW_TRUNCATED_HINT,
  PREVIEW_UNAVAILABLE_HINT,
  type CardMetadata,
  type PreviewText,
} from './doc-preview.ts';
import type { ViewportSize, ViewportTransform } from './viewport.ts';
import { tagLeaf } from '../../core/tag-path.ts';
import { createAiNodeCard, type AiNodeCard, type AiNodeCardClassNames } from './ai-node-card.ts';

/** 只要求 append：真实世界层与测试替身都满足。 */
export interface NodeLayerParent {
  append(element: HTMLElement): void;
}

/** P6-C1-C：媒体节点内部元素的 CSS 类名（由 engine 注入 CSS Modules 名）。 */
export interface NodeMediaClassNames {
  readonly image: string;
  readonly label: string;
  readonly placeholder: string;
  /** 2026-11-25：与文章节点同形的顶部信息、内表面和底部页脚。 */
  readonly kicker?: string;
  readonly kickerBadge?: string;
  readonly surface?: string;
  readonly footer?: string;
  readonly document?: string;
  /** CR-20261119-24：音频/视频播放控件类名；engine 必须注入 CSS Modules 导出值，缺省仅供测试。 */
  readonly player?: string;
  /** CR-20261121-56：音频自定义播放器（隐藏元素 + 控件条 + 圆钮 + 进度条 + 时间）。 */
  readonly audioEl?: string;
  readonly audioPlayer?: string;
  readonly audioPlay?: string;
  readonly audioTrack?: string;
  readonly audioFill?: string;
  readonly audioTime?: string;
}

/** CR-20261119-05：文档节点卡片三件套与内容滚动区的 CSS 类名。 */
export interface NodeDocClassNames {
  readonly body: string;
  readonly summary: string;
  /** 2026-11-25：顶部固定信息条（EMBER / 文章）与右侧形态徽标。 */
  readonly kicker: string;
  readonly kickerBadge: string;
  /** 2026-11-25：底部固定信息条（字数 · 分钟 | 出链反链），落在半透明外轮廓上。 */
  readonly footer: string;
  readonly tags: string;
  readonly tag: string;
  /** 卡内元信息（正文字数，muted 等宽，靠右）。 */
  readonly meta: string;
  /** CR-20261121-56：出链/反链（图标+数字）。 */
  readonly links: string;
  readonly linkOut: string;
  readonly linkBack: string;
  readonly content: string;
  /** 2026-11-23：内容裁剪壳；滚动条随圆角裁在节点边框内。 */
  readonly clip?: string;
  readonly text: string;
  readonly hint: string;
  /** CR-20261121-45 项3：渐隐后常驻的「展开」钮（D2：文档节点 → 打开阅读浮窗）。 */
  readonly expand: string;
}

/** CR-20261121-56：卡片第 3 行链接计数（wiki 语义，惰性全库索引）。 */
export interface DocLinkCounts {
  readonly out: number;
  readonly back: number;
}

/** CR-20261121-59：文本/提示词/AI 卡片部件类名（engine 注入 CSS Modules 哈希名）。 */
export interface NodeSimpleClassNames {
  readonly title: string;
  readonly icon: string;
  readonly content: string;
  readonly run: string;
  readonly empty: string;
  /** 2026-11-25：文本节点底部固定信息（字数 | EMBER）。 */
  readonly footer: string;
}

export interface NodeLayerOptions {
  readonly className: string;
  readonly nodeClassName: string;
  /** C4 选中类；缺省 `selected`，只改 outline，不改节点盒尺寸。 */
  readonly selectedClassName?: string;
  /** 缺省 `document.createElement`；测试注入假元素。 */
  readonly createElement?: () => HTMLElement;
  /** P6-C1-C：媒体内部元素类名；缺省为固定字符串（测试用）。 */
  readonly mediaClassNames?: NodeMediaClassNames;
  /** P6-C1-C：媒体内部元素工厂；缺省 `document.createElement`。 */
  readonly createChildElement?: (
    tagName: 'img' | 'span' | 'div' | 'audio' | 'video' | 'button' | 'textarea',
  ) => HTMLElement;
  /** CR-20261119-05：文档节点内部元素类名；缺省为固定字符串（测试用）。 */
  readonly docClassNames?: NodeDocClassNames;
  /** CR-20261119-05：已缓存的卡片元数据；未加载时返回 null。 */
  readonly readDocMeta?: (path: string) => CardMetadata | null;
  /** CR-20261119-05：已缓存的正文预览；未加载时返回 null。 */
  readonly readDocText?: (path: string) => PreviewText | null;
  /** CR-20261121-56：卡片第 3 行出链/反链计数（wiki 语义；索引未就绪返回 null → 整行隐藏）。 */
  readonly readDocLinkCounts?: (path: string) => DocLinkCounts | null;
  /** CR-20261121-59：提示词节点右下角「开始」钮 → 触发所连 AI 节点执行。 */
  readonly onRunPrompt?: (id: string) => void;
  /** AI 节点内联提示词提交与执行。 */
  readonly onUpdateAiText?: (id: string, text: string) => boolean;
  readonly onRunAi?: (id: string) => void;
  /** 2026-11-24：单击 AI 卡片右上角模型 → 打开模型选择浮层。 */
  readonly onOpenAiModel?: (id: string) => void;
  readonly aiClassNames?: AiNodeCardClassNames;
  /** CR-20261121-59：卡片部件类名。 */
  readonly simpleClassNames?: NodeSimpleClassNames;
  /** CR-20261120-34：内容模式的阅读渲染（安全 DOM）；缺省退化为纯文本。 */
  readonly renderDocPreview?: (container: HTMLElement, text: string) => void;
  /** CR-20261121-45 项3：文档节点「展开」钮点击（D2：打开阅读浮窗）。id 稳定（parts 按 id 键控），
   * 由 engine 从最新 nodeViews 解析 docPath/label。 */
  readonly onOpenReadMode?: (id: string) => void;
  /** CR-20261121-45 外标题：卡片外左上标注（文档=文档名/媒体=自定义名）类名；缺省 'node-label'。 */
  readonly labelClassName?: string;
  /** CR-20261121-45 项E：空文本节点占位类名；缺省 'node-placeholder'。 */
  readonly placeholderClassName?: string;
  /** CR-20261119-12：engine 注入的 autoH 测量回调；node-layer 读 offsetHeight 后回传。 */
  readonly measureAutoHeight?: (id: string, h: number) => void;
  /** CR-20261119-12：测试注入的 offsetHeight getter；默认 el => el.offsetHeight。 */
  readonly getOffsetHeightForTest?: (el: HTMLElement) => number;
  /** 2026-11-24：选中节点的环境光层类名（缺省不渲染，测试与无主题场景零影响）。 */
  readonly glowClassName?: string;
}

export interface NodeLayer {
  readonly element: HTMLElement;
  /**
   * 同步节点集合；`origin` 变化时必须重算 left/top。
   * CR-20261119-05：`viewport` 用于内容滚动区视口裁剪（缺省视为全部可见）。
   */
  setNodes(
    nodes: readonly CanvasNodeView[],
    transform: ViewportTransform,
    viewport?: ViewportSize,
  ): void;
  setSelectedNodes(selected: ReadonlySet<string>): void;
  /** CR-20261122-63：编辑浮层覆盖的节点；底层只隐藏装饰，保留选中/AI 状态。 */
  setEditingNode(id: string | null): void;
  /** CR-20261121-45 项4：悬停节点（端口圆点显现）。null=清除。 */
  setHoverNode(id: string | null): void;
  /** CR-20261121-45 项4：选中连线的端点节点（端口高亮主色描边）。 */
  setPortHighlight(ids: ReadonlySet<string>): void;
  /** CR-20261122-62：AI 节点实时运行态；null=清除。 */
  setAiRunning(id: string | null): void;
  /** CR-20261122-62：AI 节点短暂完成/失败态；null=清除。 */
  setAiFlash(flash: { readonly id: string; readonly kind: 'ok' | 'error' } | null): void;
  /** CR-20261119-12：只对指定 ids 读 offsetHeight 并回调 engine；零全量 document 扫描。 */
  measure(ids: ReadonlySet<string>): void;
  dispose(): void;
}

/** 文档节点 DOM 部件；mount 记录当前挂载形态，culled 时内容区卸载但标题保留。 */
interface DocParts {
  readonly kicker: HTMLElement;
  readonly kickerBadge: HTMLElement;
  readonly body: HTMLElement;
  readonly summary: HTMLElement;
  readonly tags: HTMLElement;
  readonly meta: HTMLElement;
  readonly links: HTMLElement;
  readonly linkOut: HTMLElement;
  readonly linkBack: HTMLElement;
  readonly content: HTMLElement;
  readonly clip: HTMLElement;
  readonly text: HTMLElement;
  readonly hint: HTMLElement;
  readonly expand: HTMLElement;
  /** 2026-11-25：外轮廓上的底部固定信息条。 */
  readonly footer: HTMLElement;
  mount: 'none' | 'card' | 'content';
  contentMounted: boolean;
  tagSignature: string;
  /** 上一次渲染进内容区的正文；不变则不重建 DOM。 */
  renderedText: string | null;
  scrollWired: boolean;
  expandWired: boolean;
}

export function createNodeLayer(parent: NodeLayerParent, options: NodeLayerOptions): NodeLayer {
  const createElement = options.createElement ?? ((): HTMLElement => document.createElement('div'));
  const createChild =
    options.createChildElement ??
    ((
      tagName: 'img' | 'span' | 'div' | 'audio' | 'video' | 'button' | 'textarea',
    ): HTMLElement => document.createElement(tagName));
  const mediaClassNames = options.mediaClassNames ?? {
    image: 'media-image',
    label: 'media-label',
    placeholder: 'media-placeholder',
    kicker: 'media-kicker',
    kickerBadge: 'media-kicker-badge',
    surface: 'media-surface',
    footer: 'media-footer',
    document: 'media-document',
    player: 'media-player',
    audioEl: 'media-audio-el',
    audioPlayer: 'media-audio-player',
    audioPlay: 'media-audio-play',
    audioTrack: 'media-audio-track',
    audioFill: 'media-audio-fill',
    audioTime: 'media-audio-time',
  };
  const playerClassName = mediaClassNames.player ?? 'media-player';
  const element = createElement();
  element.className = options.className;
  let selected = new Set<string>();
  /* 2026-11-24：选中节点的环境光。只做一层固定尺寸的光斑，随同步循环更新 transform，
   * 不参与布局、不拦截指针；未注入类名时不创建（单测零影响）。 */
  const glow = options.glowClassName === undefined ? null : createElement();
  if (glow !== null) {
    glow.className = options.glowClassName as string;
    glow.setAttribute('aria-hidden', 'true');
    element.append(glow);
  }
  const nodeCenters = new Map<string, { x: number; y: number }>();
  let glowShown = false;
  /** 选中唯一节点时把光斑移到它中心；多选/无选中淡出。坐标与节点同为屏幕空间。 */
  const updateGlow = (): void => {
    if (glow === null) return;
    const id = selected.size === 1 ? selected.values().next().value : undefined;
    const center = id === undefined ? undefined : nodeCenters.get(id);
    if (center === undefined) {
      if (glowShown) {
        glow.style.opacity = '0';
        glowShown = false;
      }
      return;
    }
    glow.style.transform = `translate3d(${(center.x - 600).toFixed(1)}px, ${(center.y - 600).toFixed(1)}px, 0)`;
    if (!glowShown) {
      glow.style.opacity = '1';
      glowShown = true;
    }
  };
  const elements = new Map<string, HTMLElement>();
  const sizedElements = new WeakSet<HTMLElement>();
  const mediaParts = new Map<
    string,
    {
      key: string;
      visual: HTMLElement;
      title: HTMLElement;
      kicker: HTMLElement;
      badge: HTMLElement;
      surface: HTMLElement;
      footer: HTMLElement;
      label: HTMLElement;
      visualKind: 'image' | 'audio' | 'video' | 'doc';
      /** CR-20261121-56：音频自定义控件条（audio 才有，重建/出错时随 visual 一起清理）。 */
      strip: HTMLElement | null;
    }
  >();

  /** CR-20261119-24：释放媒体元素（pause + removeAttribute + load），放掉 media:// Range 连接。 */
  const releaseMediaElement = (el: HTMLElement): void => {
    const media = el as HTMLMediaElement;
    if (typeof media.pause !== 'function') return; // 测试假元素 / 非媒体元素
    try {
      media.pause();
      media.removeAttribute('src');
      media.load();
    } catch {
      // 释放阶段 DOM 异常无害（元素可能已脱离文档），不属业务吞错。
    }
  };

  /** 单播放策略：任一元素开始播放时，暂停画布内其它媒体元素。 */
  const pauseOthers = (self: HTMLElement): void => {
    for (const parts of mediaParts.values()) {
      if (parts.visual === self) continue;
      const media = parts.visual as HTMLMediaElement;
      if (typeof media.pause === 'function' && !media.paused) media.pause();
    }
  };
  const docParts = new Map<string, DocParts>();
  /** CR-20261121-59：文本/提示词/AI 节点卡片部件（小标题 + 内容 + 图标 + 开始钮）。
   *  2026-11-23：AI 卡片新增预处理按钮行（简化/分割/要点/总结，功能待上线）。 */
  const simpleParts = new Map<
    string,
    {
      readonly kind: 'text' | 'prompt';
      readonly title: HTMLElement;
      readonly content: HTMLElement;
      run?: HTMLElement | null;
      /** 2026-11-25：文本节点底部固定信息（字数 | EMBER）。 */
      footer?: HTMLElement | null;
    }
  >();
  const aiParts = new Map<string, AiNodeCard>();

  /** 12px 细线节点图标（innerHTML 一次性注入静态串；假元素无 innerHTML 时安全跳过）。 */
  const NODE_ICON_HTML: Record<'text' | 'prompt' | 'ai', string> = {
    text: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden="true"><path d="M2.5 1.5H8l1.5 1.5v7.5h-7Z" strokeLinejoin="round"/><path d="M4 4.5h4M4 6.5h4M4 8.5h2.5" strokeLinecap="round"/></svg>',
    prompt: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden="true"><path d="M1.5 2.5h9v6.5h-5L3 11V9H1.5Z" strokeLinejoin="round"/><path d="M3.5 5h5M3.5 7h3" strokeLinecap="round"/></svg>',
    ai: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M10.5 3.5A2.3 2.3 0 0 0 8.2 5.6 2.3 2.3 0 0 0 6.3 8.7a2.3 2.3 0 0 0 .5 4.2A2.3 2.3 0 0 0 9 17h1.5v-13.5Z"/><path d="M13.5 3.5A2.3 2.3 0 0 1 15.8 5.6 2.3 2.3 0 0 1 17.7 8.7a2.3 2.3 0 0 1-.5 4.2A2.3 2.3 0 0 1 15 17h-1.5v-13.5Z"/><path d="M10.5 17v1.5a1.5 1.5 0 0 0 3 0V17"/></svg>',
  };

  /** 标题小字（12px 次级灰）。文本节点带细线图标；AI/提示词按参考图只用纯文字标签。 */
  const createCardTitle = (kind: 'text' | 'prompt' | 'ai', titleText: string): HTMLElement => {
    const title = createChild('div');
    title.className = simpleClassNames.title;
    title.textContent = titleText;
    if (kind === 'text') {
      try {
        title.innerHTML = `<span class="${simpleClassNames.icon}" aria-hidden="true">${NODE_ICON_HTML[kind]}</span>${titleText}`;
      } catch {
        // 测试假元素不支持 innerHTML：保留 textContent 兜底（图标缺省不影响结构测试）。
        title.textContent = titleText;
      }
    }
    return title;
  };

  const clearSimple = (id: string): void => {
    const parts = simpleParts.get(id);
    if (parts === undefined) return;
    parts.title.remove();
    parts.content.remove();
    parts.run?.remove();
    parts.footer?.remove();
    simpleParts.delete(id);
    const item = elements.get(id);
    if (item !== undefined) delete item.dataset.simple;
  };

  /** 提示词右下角「开始」钮（CR-20261121-59：用图标代替文字）。 */
  const createRunButton = (id: string): HTMLElement => {
    const run = createChild('button');
    run.className = simpleClassNames.run;
    run.setAttribute('type', 'button');
    run.setAttribute('aria-label', '开始执行 AI');
    run.setAttribute('title', '开始执行 AI');
    // CR-20261121-59：engine.onPointerDown 靠此标记把按压让给控件（否则拖拽手势吞掉 click）。
    run.setAttribute('data-node-control', 'true');
    run.textContent = '\u25B6\uFE0E';
    if (typeof run.addEventListener === 'function') {
      run.addEventListener('click', (event) => {
        event.stopPropagation();
        options.onRunPrompt?.(id);
      });
      run.addEventListener('dblclick', (event) => event.stopPropagation());
    }
    return run;
  };

  const clearAi = (id: string): void => {
    aiParts.get(id)?.root.remove();
    aiParts.delete(id);
  };
  /* CR-20261121-45 外标题：卡片外左上标注（文档=文档名；媒体=自定义名；缩放补偿 ≥11px 屏幕） */
  const labelEls = new Map<string, HTMLElement>();
  /* 项E：空文本节点占位 */
  const placeholderEls = new Map<string, HTMLElement>();
  const simpleClassNames = options.simpleClassNames ?? {
    title: 'node-card-title',
    icon: 'node-card-icon',
    content: 'node-card-content',
    run: 'node-run-btn',
    empty: 'node-card-empty',
    footer: 'node-card-footer',
  };
  const aiClassNames = options.aiClassNames ?? {
    root: 'ai-card', header: 'ai-header', title: 'ai-title', model: 'ai-model',
    prompt: 'ai-prompt', footer: 'ai-footer', actions: 'ai-actions', chip: 'ai-chip',
    run: 'ai-run', runner: 'ai-runner', runnerGlow: 'ai-runner-glow', runnerCore: 'ai-runner-core',
  };
  const docClassNames = options.docClassNames ?? {
    body: 'doc-body',
    summary: 'doc-summary',
    kicker: 'doc-kicker',
    kickerBadge: 'doc-kicker-badge',
    footer: 'doc-footer',
    tags: 'doc-tags',
    tag: 'doc-tag',
    meta: 'doc-meta',
    links: 'doc-links',
    linkOut: 'doc-link-out',
    linkBack: 'doc-link-back',
    content: 'doc-content',
    clip: 'docClip',
    text: 'doc-text',
    hint: 'doc-hint',
    expand: 'doc-expand',
  };

  /* CR-20261121-45 项3：溢出检测调度（rAF 合帧）；node 环境无 rAF 时同步跑（假元素尺寸恒 0，
   * 不会误判溢出）。scrollEnd 滚到底时摘遮罩，防末行被渐隐盖住。 */
  const overflowChecks = new Set<string>();
  let overflowRaf: number | null = null;
  const runOverflowChecks = (): void => {
    overflowRaf = null;
    for (const id of overflowChecks) {
      overflowChecks.delete(id);
      const item = elements.get(id);
      const parts = docParts.get(id);
      if (item === undefined || parts === undefined || !parts.contentMounted) continue;
      const el = parts.content;
      const scrollH = typeof el.scrollHeight === 'number' ? el.scrollHeight : 0;
      const clientH = typeof el.clientHeight === 'number' ? el.clientHeight : 0;
      if (scrollH > clientH + 1) item.dataset.overflow = 'true';
      else delete item.dataset.overflow;
    }
  };
  const scheduleOverflowCheck = (id: string): void => {
    overflowChecks.add(id);
    if (overflowRaf !== null) return;
    if (typeof requestAnimationFrame !== 'function') {
      runOverflowChecks();
      return;
    }
    overflowRaf = requestAnimationFrame(runOverflowChecks);
  };
  const selectedClassName = options.selectedClassName ?? 'selected';
  let editing: string | null = null;
  let hovered = new Set<string>();
  let portHighlighted = new Set<string>();
  let aiRunning: string | null = null;
  let aiFlash: { readonly id: string; readonly kind: 'ok' | 'error' } | null = null;
  /* LOD 滞回（±5%）：0.37 开启、0.43 关闭，防缩放抖动反复切换（§7-6） */
  let lodOn = false;
  const applyFlags = (item: HTMLElement, id: string): void => {
    const isSelected = selected.has(id);
    item.className = isSelected
      ? `${options.nodeClassName} ${selectedClassName}`
      : options.nodeClassName;
    if (isSelected) item.dataset.selected = 'true';
    else delete item.dataset.selected;
    if (editing === id) item.dataset.editing = 'true';
    else delete item.dataset.editing;
    if (hovered.has(id)) item.dataset.hover = 'true';
    else delete item.dataset.hover;
    if (portHighlighted.has(id)) item.dataset.portHl = 'true';
    else delete item.dataset.portHl;
    if (aiRunning === id) item.dataset.aiRunning = 'true';
    else delete item.dataset.aiRunning;
    if (aiFlash?.id === id) item.dataset.aiFlash = aiFlash.kind;
    else delete item.dataset.aiFlash;
    if (lodOn) item.dataset.lod = 'true';
    else delete item.dataset.lod;
  };

  /** CR-20261119-11：撤可见 resize handle，热区由 engine.resolveResizeZone 纯函数判定。 */

  const clearMedia = (id: string): void => {
    const parts = mediaParts.get(id);
    if (parts === undefined) return;
    releaseMediaElement(parts.visual);
    parts.strip?.remove();
    parts.kicker.remove();
    parts.surface.remove();
    parts.footer.remove();
    mediaParts.delete(id);
  };

  const createDocParts = (): DocParts => {
    // 2026-11-25：顶部固定信息条与底部固定页脚落在半透明外壳上（内表面只放正文/标签），
    // 同心圆角：外壳 18px，内容内缩 8px → 10px。
    const kicker = createChild('div');
    kicker.className = docClassNames.kicker;
    const kickerText = createChild('span');
    kickerText.textContent = 'EMBER / 文章';
    const kickerBadge = createChild('span');
    kickerBadge.className = docClassNames.kickerBadge;
    kickerBadge.textContent = '摘要';
    kicker.append(kickerText, kickerBadge);
    const body = createChild('div');
    body.className = docClassNames.body;
    const summary = createChild('div');
    summary.className = docClassNames.summary;
    const tags = createChild('div');
    tags.className = docClassNames.tags;
    body.append(summary, tags);
    // 底部页脚：字数 · 分钟（左）+ 出链/反链（右）。
    const footer = createChild('div');
    footer.className = docClassNames.footer;
    const meta = createChild('div');
    meta.className = docClassNames.meta;
    const links = createChild('div');
    links.className = docClassNames.links;
    const linkOut = createChild('span');
    linkOut.className = docClassNames.linkOut;
    const linkBack = createChild('span');
    linkBack.className = docClassNames.linkBack;
    links.append(linkOut, linkBack);
    footer.append(meta, links);
    const content = createChild('div');
    content.className = docClassNames.content;
    content.dataset.nodeScroll = 'true';
    content.tabIndex = 0;
    const text = createChild('div');
    text.className = docClassNames.text;
    const hint = createChild('div');
    hint.className = docClassNames.hint;
    content.append(text, hint);
    // 内容裁剪壳：节点本身保持 overflow:visible 以显示外置端口圆点，
    // 滚动条/正文由这层按圆角裁切，避免滚动条跑出节点边框。
    const clip = createChild('div');
    clip.className = docClassNames.clip ?? 'docClip';
    const expand = createChild('button');
    expand.className = docClassNames.expand;
    expand.textContent = '展开';
    if (typeof expand.setAttribute === 'function') expand.setAttribute('type', 'button');
    return {
      kicker,
      kickerBadge,
      body,
      summary,
      tags,
      meta,
      links,
      linkOut,
      linkBack,
      content,
      clip,
      text,
      hint,
      expand,
      footer,
      mount: 'none',
      contentMounted: false,
      tagSignature: '',
      renderedText: null,
      scrollWired: false,
      expandWired: false,
    };
  };

  /** 2026-11-25：底部固定信息 = 字数 · 阅读时长（350 字/分钟估算，最少 1 分钟）。 */
  const updateDocMeta = (parts: DocParts, chars: number): void => {
    if (chars <= 0) {
      if (parts.meta.textContent !== '') parts.meta.textContent = '';
      return;
    }
    const minutes = Math.max(1, Math.round(chars / 350));
    const text = `${formatWordCount(chars)} · ${minutes} 分钟`;
    if (parts.meta.textContent !== text) parts.meta.textContent = text;
  };

  const clearDoc = (id: string): void => {
    const parts = docParts.get(id);
    if (parts === undefined) return;
    parts.kicker.remove();
    parts.body.remove();
    parts.clip.remove();
    parts.footer.remove();
    parts.expand.remove();
    docParts.delete(id);
  };

  const updateTags = (parts: DocParts, tags: readonly string[]): void => {
    const shown = tags.slice(0, CARD_TAG_LIMIT);
    const overflow = tags.length > CARD_TAG_LIMIT ? `+${tags.length - CARD_TAG_LIMIT}` : '';
    const signature = `${shown.join('\u0000')}|${overflow}`;
    if (parts.tagSignature === signature) return;
    parts.tagSignature = signature;
    for (const child of Array.from(parts.tags.children)) child.remove();
    for (const tag of shown) {
      const chip = createChild('span');
      chip.className = docClassNames.tag;
      // 斜杠层级标签在卡片上只显示叶名，完整路径放在 title 里。
      chip.textContent = tagLeaf(tag);
      chip.title = tag;
      parts.tags.append(chip);
    }
    if (overflow !== '') {
      const chip = createChild('span');
      chip.className = docClassNames.tag;
      chip.textContent = overflow;
      parts.tags.append(chip);
    }
  };

  const viewportVisible = (
    node: CanvasNodeView,
    transform: ViewportTransform,
    viewport: ViewportSize | undefined,
  ): boolean => {
    if (viewport === undefined) return true;
    const rect = nodeScreenRect(node, transform);
    return rect.right >= 0 && rect.left <= viewport.width && rect.bottom >= 0 && rect.top <= viewport.height;
  };

  /** 文档节点：卡片三件套（标题/简介/标签）或内容模式（标题 + 滚动正文）。 */
  const renderDocument = (
    item: HTMLElement,
    node: CanvasNodeView,
    transform: ViewportTransform,
    viewport: ViewportSize | undefined,
  ): void => {
    const path = node.docPath;
    if (path === undefined) return;
    let parts = docParts.get(node.id);
    if (parts === undefined) {
      parts = createDocParts();
      docParts.set(node.id, parts);
    }
    const mode: 'card' | 'content' = isNodeContentMode(node) ? 'content' : 'card';
    if (parts.mount !== mode) {
      parts.kicker.remove();
      parts.body.remove();
      parts.clip.remove();
      parts.footer.remove();
      parts.expand.remove();
      parts.contentMounted = false;
      item.append(parts.kicker);
      if (mode === 'card') {
        item.append(parts.body);
        item.append(parts.footer);
      }
      parts.mount = mode;
    }
    const badgeText = mode === 'card' ? '摘要' : '正文';
    if (parts.kickerBadge.textContent !== badgeText) parts.kickerBadge.textContent = badgeText;

    if (mode === 'card') {
      const meta = options.readDocMeta?.(path) ?? null;
      // CR-20261121-45：无 frontmatter 摘要时回退正文首行散文；两者皆无 → 「暂无简介」（muted 灰）
      const metaSummary = meta?.summary ?? '';
      const fallback =
        metaSummary.trim() === ''
          ? deriveSummaryFallback(options.readDocText?.(path)?.text ?? '')
          : '';
      const summary = metaSummary !== '' ? metaSummary : fallback !== '' ? fallback : EMPTY_SUMMARY_TEXT;
      if (parts.summary.textContent !== summary) parts.summary.textContent = summary;
      if (summary === EMPTY_SUMMARY_TEXT) item.dataset.noSummary = 'true';
      else delete item.dataset.noSummary;
      // 2026-11-25：字数 · 分钟移到底部外轮廓页脚；标签仍在内表面。
      const cardPreview = options.readDocText?.(path) ?? null;
      updateDocMeta(
        parts,
        cardPreview !== null && !cardPreview.failed
          ? cardPreview.text.replace(/\s+/g, '').length
          : 0,
      );
      updateTags(parts, meta?.tags ?? []);
      const counts = options.readDocLinkCounts?.(path) ?? null;
      const outText = counts === null ? '' : `↗ ${counts.out}`;
      const backText = counts === null ? '' : `↩ ${counts.back}`;
      if (parts.linkOut.textContent !== outText) parts.linkOut.textContent = outText;
      if (parts.linkBack.textContent !== backText) parts.linkBack.textContent = backText;
      return;
    }

    // 内容模式：仅对视口内可见的节点挂载滚动 DOM；离开视口卸载（重挂天然复位滚动）。
    const visible = viewportVisible(node, transform, viewport);
    if (visible && !parts.contentMounted) {
      parts.clip.append(parts.content);
      item.append(parts.clip);
      item.append(parts.footer);
      item.append(parts.expand);
      parts.contentMounted = true;
      // CR-20261121-45 项3：溢出检测 + 滚到底摘遮罩（只挂一次监听）
      scheduleOverflowCheck(node.id);
      if (!parts.scrollWired && typeof parts.content.addEventListener === 'function') {
        parts.scrollWired = true;
        parts.content.addEventListener('scroll', () => {
          const el = parts.content;
          const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
          item.dataset.scrollEnd = atEnd ? 'true' : 'false';
          if (atEnd) scheduleOverflowCheck(node.id);
        });
      }
    } else if (!visible && parts.contentMounted) {
      parts.content.remove();
      parts.clip.remove();
      parts.footer.remove();
      parts.expand.remove();
      parts.contentMounted = false;
    }
    const preview = options.readDocText?.(path) ?? null;
    const text = preview === null || preview.failed ? '' : preview.text;
    // 内容模式同样在底部外轮廓给出字数 · 分钟。
    updateDocMeta(parts, preview === null || preview.failed ? 0 : text.replace(/\s+/g, '').length);
    const hint =
      preview === null
        ? ''
        : preview.failed
          ? PREVIEW_UNAVAILABLE_HINT
          : preview.truncated
            ? PREVIEW_TRUNCATED_HINT
            : preview.fromLive
              ? ''
              : PREVIEW_SNAPSHOT_HINT;
    const renderer = options.renderDocPreview;
    const needsRender =
      renderer !== undefined ? parts.renderedText !== text : parts.text.textContent !== text;
    if (needsRender) {
      if (renderer !== undefined) renderer(parts.text, text);
      else parts.text.textContent = text;
      parts.renderedText = text;
    }
    if (parts.hint.textContent !== hint) parts.hint.textContent = hint;
    // 渲染正文后内容高度可能变化，重跑溢出检测
    scheduleOverflowCheck(node.id);
    if (!parts.expandWired && typeof parts.expand.addEventListener === 'function') {
      parts.expandWired = true;
      parts.expand.addEventListener('click', (event) => {
        event.stopPropagation();
        // node.id 对该 parts 恒定（docParts 按 id 键控），首绑 id 即稳定 id；
        // 最新 docPath/label 由 engine 从 nodeViews 解析。
        options.onOpenReadMode?.(node.id);
      });
    }
  };

  const createVisual = (kind: 'image' | 'audio' | 'video' | 'doc'): HTMLElement => {
    if (kind === 'doc') {
      const document = createChild('div');
      document.className = mediaClassNames.document ?? 'media-document';
      document.textContent = '双击预览文档';
      return document;
    }
    if (kind === 'image') {
      const image = createChild('img');
      image.className = mediaClassNames.image;
      image.setAttribute('draggable', 'false');
      image.setAttribute('loading', 'lazy');
      return image;
    }
    // CR-20261119-24：音频/视频播放控件。控件交互不得透传成节点拖拽/框选。
    // CR-20261121-46：不再整块拦 pointerdown/mousedown（旧实现把视频整个画面变成
    // 死区，节点无法拖动/选中）。改为 data-media-player 标记 + engine.onPointerDown
    // 前置判定：音频整块、视频底部控件条早退给原生控件；画面本体放行给画布手势。
    // click/dblclick 仍拦：控件上的双击不得透传成节点双击（engine dblclick 在 host 上）。
    // CR-20261121-56：音频改自定义播放器——`<audio>` 隐藏（无 controls），只承担播放与
    // 事件；控件条由 createAudioStrip 构建并独占 data-media-player='audio' 标记（engine
    // 按条形区域放行按压）。视频保持原生控件 + 底部 44px 让位（CR-46），不动。
    const tag = kind === 'audio' ? 'audio' : 'video';
    const player = createChild(tag) as HTMLMediaElement;
    if (kind === 'audio') {
      player.className = mediaClassNames.audioEl ?? 'media-audio-el';
      player.setAttribute('preload', 'metadata');
      player.setAttribute('draggable', 'false');
    } else {
      player.className = playerClassName;
      player.setAttribute('controls', '');
      player.setAttribute('preload', 'metadata');
      player.setAttribute('draggable', 'false');
      player.setAttribute('data-media-player', tag);
      for (const type of ['click', 'dblclick'] as const) {
        // addEventListener 缺席 = 测试假元素；守卫后跳过。
        if (typeof player.addEventListener !== 'function') continue;
        player.addEventListener(type, (event) => event.stopPropagation());
      }
    }
    // 单播放策略：本元素开始播放时暂停画布内其它媒体元素。
    if (typeof player.addEventListener === 'function') {
      player.addEventListener('play', () => {
        pauseOthers(player);
      });
    }
    // error 事件判定编码支持（canPlayType 对 mov/mp4 恒 maybe，不作拒绝依据）：
    // SRC_NOT_SUPPORTED / DECODE → 「容器已识别，此编码暂不支持」占位回退。
    if (typeof player.addEventListener === 'function') {
      player.addEventListener('error', () => {
        const media = player;
        const message = mediaLoadErrorMessage(media.error?.code);
        const fallback = createChild('div');
        fallback.className = mediaClassNames.placeholder;
        fallback.textContent = message;
        releaseMediaElement(player);
        player.replaceWith(fallback);
        for (const parts of mediaParts.values()) {
          if (parts.visual === player) {
            parts.visual = fallback;
            if (parts.strip !== null) {
              parts.strip.remove();
              parts.strip = null;
            }
            break;
          }
        }
      });
    }
    return player;
  };

  /**
   * CR-20261121-56：音频自定义控件条——圆形播放钮 + 极简进度条（圆点滑块）+ 时间。
   * engine 靠 data-media-player='audio' 把条形区域的按压让给控件
   * （interaction.isMediaChromePress 按 rect 纵向范围判定）；条外卡体照常拖拽/框选。
   */
  const createAudioStrip = (player: HTMLMediaElement): HTMLElement => {
    const strip = createChild('div');
    strip.className = mediaClassNames.audioPlayer ?? 'media-audio-player';
    strip.setAttribute('data-media-player', 'audio');
    const play = createChild('button');
    play.className = mediaClassNames.audioPlay ?? 'media-audio-play';
    play.textContent = '\u25B6\uFE0E';
    play.setAttribute('type', 'button');
    play.setAttribute('aria-label', '播放/暂停');
    const track = createChild('div');
    track.className = mediaClassNames.audioTrack ?? 'media-audio-track';
    track.setAttribute('aria-label', '播放进度');
    const fill = createChild('div');
    fill.className = mediaClassNames.audioFill ?? 'media-audio-fill';
    track.append(fill);
    const time = createChild('span');
    time.className = mediaClassNames.audioTime ?? 'media-audio-time';
    time.textContent = '--:-- / --:--';
    strip.append(play);
    strip.append(track);
    strip.append(time);
    for (const type of ['click', 'dblclick'] as const) {
      if (typeof strip.addEventListener !== 'function') break;
      strip.addEventListener(type, (event) => event.stopPropagation());
    }
    const formatTime = (seconds: number): string => {
      if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
      const total = Math.floor(seconds);
      return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    };
    const renderProgress = (): void => {
      const duration = player.duration;
      const current = player.currentTime;
      const hasDuration =
        typeof duration === 'number' && Number.isFinite(duration) && duration > 0;
      const ratio = hasDuration ? Math.min(current / duration, 1) : 0;
      fill.style.width = `${(ratio * 100).toFixed(1)}%`;
      time.textContent = `${formatTime(current)} / ${hasDuration ? formatTime(duration) : '--:--'}`;
    };
    if (typeof play.addEventListener === 'function') {
      play.addEventListener('click', () => {
        if (player.paused) {
          if (typeof player.play === 'function') void player.play();
        } else if (typeof player.pause === 'function') {
          player.pause();
        }
      });
    }
    for (const type of ['timeupdate', 'loadedmetadata', 'durationchange'] as const) {
      if (typeof player.addEventListener !== 'function') break;
      player.addEventListener(type, renderProgress);
    }
    if (typeof player.addEventListener === 'function') {
      player.addEventListener('play', () => {
        play.textContent = '\u23F8\uFE0E';
      });
      player.addEventListener('pause', () => {
        play.textContent = '\u25B6\uFE0E';
      });
    }
    // 进度条点击/拖拽定位（浏览器环境；node 测试无 window 时自动跳过）。
    const seekTo = (clientX: number): void => {
      const rect = track.getBoundingClientRect();
      if (typeof rect.width !== 'number' || rect.width <= 0) return;
      const ratio = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
      if (
        typeof player.duration === 'number' &&
        Number.isFinite(player.duration) &&
        player.duration > 0
      ) {
        player.currentTime = ratio * player.duration;
      }
    };
    if (typeof window !== 'undefined' && typeof track.addEventListener === 'function') {
      track.addEventListener('pointerdown', (event) => {
        seekTo(event.clientX);
        const onMove = (moveEvent: PointerEvent): void => seekTo(moveEvent.clientX);
        const onUp = (): void => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });
    }
    return strip;
  };

  /** CR-20261121-59：文本/提示词/AI 卡片——小标题(图标) + 内容（+ 提示词右下角开始钮）。 */
  const renderSimpleCard = (item: HTMLElement, node: CanvasNodeView): void => {
    const kind = node.kind === 'prompt' ? 'prompt' : 'text';
    const current = simpleParts.get(node.id);
    if (current === undefined || current.kind !== kind) {
      if (item.textContent !== '') item.textContent = '';
      clearSimple(node.id);
      const title = createCardTitle(kind, kind === 'prompt' ? '提示词' : '文本');
      const content = createChild('div');
      content.className = simpleClassNames.content;
      content.dataset.simpleKind = kind;
      if (kind === 'prompt') {
        // 固定尺寸后长提示词需要内部滚动；data-node-scroll 让画布滚轮让给文本框。
        content.dataset.nodeScroll = 'true';
        content.tabIndex = 0;
      }
      let run: HTMLElement | null = null;
      let footer: HTMLElement | null = null;
      if (kind === 'prompt') {
        run = createRunButton(node.id);
        item.append(title);
        item.append(content);
        item.append(run);
      } else {
        // 2026-11-25：文本节点改为 top kicker + 内容 + 外轮廓底部固定页脚。
        footer = createChild('div');
        footer.className = simpleClassNames.footer;
        item.dataset.simple = kind;
        item.append(title);
        item.append(content);
        item.append(footer);
      }
      simpleParts.set(node.id, { kind, title, content, run, footer });
    }
    const parts = simpleParts.get(node.id);
    if (parts === undefined) return;
    if (kind === 'prompt') {
      const text = node.promptText ?? '';
      if (text === '') {
        if (parts.content.dataset.emptyState !== 'true') {
          parts.content.dataset.emptyState = 'true';
          try {
            parts.content.innerHTML =
              `<span class="${simpleClassNames.empty}">${NODE_ICON_HTML.prompt}<i>双击输入提示词</i></span>`;
          } catch {
            parts.content.textContent = '双击输入提示词';
          }
        }
        return;
      }
      if (parts.content.dataset.emptyState !== undefined) {
        delete parts.content.dataset.emptyState;
        try {
          parts.content.innerHTML = '';
        } catch {
          parts.content.textContent = '';
        }
      }
      if (parts.content.textContent !== text) parts.content.textContent = text;
      return;
    }
    // 文本：内容 + 多行渐隐（CSS mask）；空=占位
    if (node.label === '') {
      if (item.dataset.empty !== 'true') {
        item.dataset.empty = 'true';
        if (parts.content.textContent !== '') parts.content.textContent = '';
        const ph = createChild('div');
        ph.className = options.placeholderClassName ?? 'node-placeholder';
        ph.textContent = '双击编辑';
        parts.content.append(ph);
        placeholderEls.set(node.id, ph);
      }
      return;
    }
    if (item.dataset.empty !== undefined) {
      delete item.dataset.empty;
      placeholderEls.get(node.id)?.remove();
      placeholderEls.delete(node.id);
    }
    if (parts.content.textContent !== node.label) parts.content.textContent = node.label;
    if (parts.footer != null) {
      const count = node.label.replace(/\s+/g, '').length;
      const footerText = count > 0 ? `${count} 字` : '';
      if (parts.footer.textContent !== footerText) parts.footer.textContent = footerText;
    }
  };

  const renderAiCard = (item: HTMLElement, node: CanvasNodeView): void => {
    let card = aiParts.get(node.id);
    if (card === undefined) {
      card = createAiNodeCard({
        id: node.id,
        text: node.promptText ?? '',
        model: node.aiModel,
        classNames: aiClassNames,
        createElement: createChild,
        onCommit: (id, text) => options.onUpdateAiText?.(id, text) ?? false,
        onRun: (id) => options.onRunAi?.(id),
        onOpenModel: (id) => options.onOpenAiModel?.(id),
      });
      aiParts.set(node.id, card);
      item.append(card.root);
    }
    card.setText(node.promptText ?? '');
    card.setModel(node.aiModel);
    card.setRunning(aiRunning === node.id);
  };

  /** 媒体节点：文章式顶部信息 + 内表面预览 + 外轮廓页脚；保留音视频播放交互。 */
  const renderMedia = (item: HTMLElement, node: CanvasNodeView): void => {
    const media = node.media;
    if (media === undefined) return;
    const key = `${media.kind}|${media.path}`;
    const current = mediaParts.get(node.id);
    if (item.dataset.mediaKind !== media.kind) item.dataset.mediaKind = media.kind;

    if (current === undefined) {
      const kicker = createChild('div');
      kicker.className = mediaClassNames.kicker ?? 'media-kicker';
      const title = createChild('span');
      const badge = createChild('span');
      badge.className = mediaClassNames.kickerBadge ?? 'media-kicker-badge';
      kicker.append(title);
      kicker.append(badge);
      const surface = createChild('div');
      surface.className = mediaClassNames.surface ?? 'media-surface';
      const visual = createVisual(media.kind);
      surface.append(visual);
      let strip: HTMLElement | null = null;
      if (media.kind === 'audio') {
        strip = createAudioStrip(visual as HTMLMediaElement);
        surface.append(strip);
      }
      const footer = createChild('div');
      footer.className = mediaClassNames.footer ?? 'media-footer';
      const label = createChild('span');
      label.className = mediaClassNames.label;
      footer.append(label);
      item.append(kicker);
      item.append(surface);
      item.append(footer);
      mediaParts.set(node.id, {
        key, visual, title, kicker, badge, surface, footer, label, visualKind: media.kind, strip,
      });
      if (media.kind === 'audio' || media.kind === 'video') {
        visual.setAttribute('src', mediaUrlForPath(media.path));
      }
    } else if (current.key !== key || current.visualKind !== media.kind) {
      // kind/path 变化只重建内表面媒体元素，外壳与页脚保持稳定。
      releaseMediaElement(current.visual);
      current.visual.remove();
      current.strip?.remove();
      const visual = createVisual(media.kind);
      current.surface.append(visual);
      let strip: HTMLElement | null = null;
      if (media.kind === 'audio') {
        strip = createAudioStrip(visual as HTMLMediaElement);
        current.surface.append(strip);
      }
      current.visual = visual;
      current.strip = strip;
      current.key = key;
      current.visualKind = media.kind;
      if (media.kind === 'audio' || media.kind === 'video') {
        visual.setAttribute('src', mediaUrlForPath(media.path));
      }
    }

    const parts = mediaParts.get(node.id);
    if (parts === undefined) return;
    const kindLabels = { image: '图像', audio: '声音', video: '视频', doc: '文档' } as const;
    const title = `EMBER / ${kindLabels[media.kind]}`;
    const badge = media.kind === 'audio' ? '播放' : media.kind === 'doc' ? '只读' : '预览';
    if (parts.title.textContent !== title) parts.title.textContent = title;
    if (parts.badge.textContent !== badge) parts.badge.textContent = badge;
    if (parts.label.textContent !== node.label) parts.label.textContent = node.label;
    if (media.kind === 'image') {
      parts.visual.setAttribute('src', mediaUrlForPath(media.path));
      parts.visual.setAttribute('alt', node.label);
    }
  };

  parent.append(element);

  return {
    element,
    setNodes(
      nodes: readonly CanvasNodeView[],
      transform: ViewportTransform,
      viewport?: ViewportSize,
    ): void {
      /* CR-20261121-45 项5：LOD 滞回（0.37 开 / 0.43 关） */
      const scale = transform.scale;
      if (!lodOn && scale < 0.37) lodOn = true;
      else if (lodOn && scale > 0.43) lodOn = false;
      const alive = new Set<string>();
      nodeCenters.clear();
      for (const node of nodes) {
        alive.add(node.id);
        let item = elements.get(node.id);
        if (item === undefined) {
          item = createElement();
          item.dataset.nodeId = node.id;
          elements.set(node.id, item);
          element.append(item);
        }
        if (node.media !== undefined) {
          if (item.dataset.nodeType !== 'media') {
            // 仅首次切换为媒体时清掉旧文本；后续轮次不能清，否则会连子元素一起清空。
            if (item.textContent !== '') item.textContent = '';
            clearDoc(node.id);
            clearSimple(node.id);
            clearAi(node.id);
            item.dataset.nodeType = 'media';
          }
          renderMedia(item, node);
        } else if (node.docPath !== undefined) {
          if (item.dataset.nodeType !== 'document') {
            if (item.textContent !== '') item.textContent = '';
            clearMedia(node.id);
            clearSimple(node.id);
            clearAi(node.id);
            item.dataset.nodeType = 'document';
          }
          renderDocument(item, node, transform, viewport);
        } else if (node.kind === 'ai') {
          if (item.dataset.nodeType !== 'ai') {
            if (item.textContent !== '') item.textContent = '';
            clearMedia(node.id);
            clearDoc(node.id);
            clearSimple(node.id);
            item.dataset.nodeType = 'ai';
            delete item.dataset.empty;
            delete item.dataset.mediaKind;
            placeholderEls.get(node.id)?.remove();
            placeholderEls.delete(node.id);
          }
          renderAiCard(item, node);
        } else if (node.kind === 'prompt') {
          if (item.dataset.nodeType !== 'prompt') {
            if (item.textContent !== '') item.textContent = '';
            clearMedia(node.id);
            clearDoc(node.id);
            clearAi(node.id);
            item.dataset.nodeType = 'prompt';
            delete item.dataset.empty;
            delete item.dataset.mediaKind;
            placeholderEls.get(node.id)?.remove();
            placeholderEls.delete(node.id);
          }
          renderSimpleCard(item, node);
        } else {
          if (item.dataset.nodeType === 'media') clearMedia(node.id);
          if (item.dataset.nodeType === 'document') clearDoc(node.id);
          if (item.dataset.nodeType === 'ai') clearAi(node.id);
          delete item.dataset.nodeType;
          delete item.dataset.mediaKind;
          // CR-20261121-59：组节点保持纯标签渲染；自由文本走卡片结构（小标题+内容+渐隐）。
          if (node.group === true) {
            clearSimple(node.id);
            placeholderEls.get(node.id)?.remove();
            placeholderEls.delete(node.id);
            delete item.dataset.empty;
            if (item.textContent !== node.label) item.textContent = node.label;
          } else {
            renderSimpleCard(item, node);
          }
        }
        // 外标题：文档=文档名；媒体=自定义名（内容寻址文件名仍在卡内底部）；文本节点无
        const outsideLabel = hasOutsideNodeLabel(node) ? node.label : '';
        if (outsideLabel === '') {
          const el = labelEls.get(node.id);
          if (el !== undefined) {
            el.remove();
            labelEls.delete(node.id);
          }
        } else {
          let labelEl = labelEls.get(node.id);
          if (labelEl === undefined) {
            labelEl = createElement();
            labelEl.className = options.labelClassName ?? 'node-label';
            if (typeof labelEl.setAttribute === 'function') labelEl.setAttribute('aria-hidden', 'true');
            labelEls.set(node.id, labelEl);
            element.append(labelEl);
          }
          if (labelEl.textContent !== outsideLabel) labelEl.textContent = outsideLabel;
          const label = nodeOutsideLabelLayout(node, transform);
          labelEl.style.left = `${label.x}px`;
          labelEl.style.top = `${label.y}px`;
          labelEl.style.width = `${label.width}px`;
          labelEl.style.fontSize = label.fontSize === null ? '' : `${label.fontSize}px`;
        }
        applyFlags(item, node.id);
        const local = nodeLocalPosition(node, transform);
        item.style.left = `${local.x}px`;
        item.style.top = `${local.y}px`;
        nodeCenters.set(node.id, {
          x: local.x + (node.w ?? NODE_WIDTH) / 2,
          y: local.y + (node.h ?? 120) / 2,
        });
        // 只有显式尺寸才写内联；缺失且此前未写过时不动 style，保持旧节点行为。
        // AI / 提示词节点由 CSS 固定尺寸，忽略磁盘上的历史 w/h。
        const fixedSize = isFixedSizeNodeKind(node.kind);
        if (fixedSize) {
          item.style.width = '';
          item.style.height = '';
          sizedElements.delete(item);
        } else if (node.w !== undefined || node.h !== undefined) {
          item.style.width = node.w === undefined ? '' : `${node.w}px`;
          item.style.height = node.h === undefined ? '' : `${node.h}px`;
          sizedElements.add(item);
        } else if (sizedElements.has(item)) {
          item.style.width = '';
          item.style.height = '';
          sizedElements.delete(item);
        }
      }
      for (const [id, item] of elements) {
        if (alive.has(id)) continue;
        clearMedia(id);
        clearDoc(id);
        clearSimple(id);
        clearAi(id);
        labelEls.get(id)?.remove();
        labelEls.delete(id);
        placeholderEls.get(id)?.remove();
        placeholderEls.delete(id);
        item.remove();
        elements.delete(id);
      }
      updateGlow();
    },
    setSelectedNodes(next): void {
      selected = new Set(next);
      for (const [id, item] of elements) applyFlags(item, id);
      updateGlow();
    },
    setEditingNode(id): void {
      editing = id;
      for (const [nodeId, item] of elements) {
        if (editing === nodeId || item.dataset.editing !== undefined) applyFlags(item, nodeId);
      }
    },
    setHoverNode(id): void {
      hovered = id === null ? new Set<string>() : new Set([id]);
      for (const [nodeId, item] of elements) {
        if (hovered.has(nodeId) || item.dataset.hover !== undefined) applyFlags(item, nodeId);
      }
    },
    setPortHighlight(ids): void {
      portHighlighted = new Set(ids);
      for (const [nodeId, item] of elements) {
        if (portHighlighted.has(nodeId) || item.dataset.portHl !== undefined) applyFlags(item, nodeId);
      }
    },
    setAiRunning(id): void {
      aiRunning = id;
      for (const [nodeId, item] of elements) {
        if (aiRunning === nodeId || item.dataset.aiRunning !== undefined) applyFlags(item, nodeId);
      }
      for (const [nodeId, card] of aiParts) card.setRunning(aiRunning === nodeId);
    },
    setAiFlash(flash): void {
      aiFlash = flash;
      for (const [nodeId, item] of elements) {
        if (aiFlash?.id === nodeId || item.dataset.aiFlash !== undefined) {
          applyFlags(item, nodeId);
        }
      }
    },
    /** CR-20261119-12：只对指定 ids 读 offsetHeight 并回调 engine。零全量 document 扫描。 */
    measure(ids: ReadonlySet<string>): void {
      const getter = options.getOffsetHeightForTest;
      const cb = options.measureAutoHeight;
      if (cb === undefined) return;
      for (const id of ids) {
        const item = elements.get(id);
        if (item === undefined) continue;
        // AI / 提示词节点尺寸固定，无需测量自动高度。
        const parts = simpleParts.get(id);
        if (aiParts.has(id) || (parts !== undefined && isFixedSizeNodeKind(parts.kind))) continue;
        const h = getter ? getter(item) : item.offsetHeight;
        if (h > 0) cb(id, Math.round(h));
      }
    },
    dispose(): void {
      for (const parts of mediaParts.values()) releaseMediaElement(parts.visual);
      mediaParts.clear();
      docParts.clear();
      simpleParts.clear();
      aiParts.clear();
      labelEls.clear();
      placeholderEls.clear();
      elements.clear();
      element.remove();
    },
  };
}
