/**
 * CanvasEngine：grid/edges/world/highlight 四层与 C4 交互接线。
 *
 * - viewport 根是唯一事件源；节点层与 canvas 层保持 pointer-events:none；
 * - 节点拖拽预览只改 nodeViews，pointerup 才由 document-controller 写文档/历史/保存；
 * - 连线缓存只重算 incident 边，退化次数与 grid/world/edges/nodes 分档耗时分别可读；
 * - dispose：破坏性清理，仅用于确定不再复用的实例——注销 registry、停监听/rAF/observer；
 *   不 flush、不 beginClosing。写盘与 seal 编排见 lifecycle.ts（普通切换走
 *   createCanvasSwitchDisposer，绝不 beginClosing；应用退出 seal 前才走 createCanvasDisposer）。
 */
import styles from './canvas.module.css';
import {
  CanvasInteractionController,
  type CanvasOpenResult,
  type CanvasPositionPatch,
} from './document-controller.ts';
import type { CanvasStore } from '../../core/canvas/ports.ts';
import {
  absoluteToScreen,
  createScreenEdgeCache,
  edgeAnchor,
  extractEdgeViews,
  hitTestEdges,
  planEdgeDraw,
  type CanvasEdgeView,
  type EdgeDrawWarning,
  type EdgeHit,
  type ScreenEdge,
} from './edge-layout.ts';
import { createEdgeLayer, type EdgeLayer } from './edge-layer.ts';
import { createEdgePulseLayer, type EdgePulseLayer } from './edge-pulse.ts';
import { shouldSyncNodeLayer } from './node-sync.ts';
import {
  createFrameState,
  createGridInvalidation,
  type CanvasFrameStats,
} from './frame-state.ts';
import { drawGrid, type GridPalette } from './grid.ts';
import { onThemeColorsChange, themeColors } from './canvas-palette.ts';
import {
  createInteractionState,
  isMediaChromePress,
  reduceInteraction,
  setInteractionSelection,
  type CanvasHitTarget,
  type CanvasPortHit,
  type InteractionEffect,
  type InteractionState,
} from './interaction.ts';
import { resolveWorldElement } from './engine-mount.ts';
import {
  extractNodes,
  extractNodeViews,
  hitTestNodes,
  isFixedSizeNodeKind,
  isNodeContentMode,
  marqueeNodeIds,
  mergeAutoHeights,
  nodeScreenRect,
  nodeSizeOf,
  nodeWorldRects,
  readOrigin,
  type CanvasNodeView,
} from './node-layout.ts';
import { createDocPreviewService, type DocPreviewService } from './doc-preview.ts';
import { draftCurve } from './connection-draft.ts';
import { isTextEditingTarget } from './select-all-route.ts';
import {
  dispatchCanvasNotice,
  type CanvasNotice,
  type CanvasNoticeCode,
} from './notice.ts';
import { createNodeLayer, type DocLinkCounts, type NodeLayer } from './node-layer.ts';
import { createDocPreviewRenderer } from './preview-dom.ts';
import {
  createEmptyCanvasDocument,
  parseCanvasDocument,
  serializeCanvasDocument,
  type CanvasDocument,
} from './format.ts';
import type { CanvasCommand, CanvasSchemaIssue } from '#canvas-format';
import {
  createCanvasSelectAllSelection,
  createDeleteSelectionCommands,
  createDuplicateNodeCommands,
  inspectConnectionCandidate,
  makeEdgeId,
  pruneInteraction,
} from './canvas-interactions.ts';
import type { CanvasEngineRegistry } from './registry.ts';
import { inspectCanvasDocument } from './schema-adapter.ts';
import { createCanvasDocumentView, createCanvasMountGuard, readCanvasDpr } from './view-sync.ts';
import {
  createViewportTransform,
  fitRectsToViewport,
  ORIGIN_PRECISION_LIMIT,
  panBy,
  REBASE_THRESHOLD,
  rebase,
  rebaseOffset,
  resetView,
  zoomAt,
  type Point,
  type Rect,
  type ViewportSize,
  type ViewportTransform,
} from './viewport.ts';
import { createWorldLayer, type WorldLayer } from './world-layer.ts';

/** 画布 flush 结果视图：只暴露 engine / lifecycle / close-hooks 实际消费的字段。 */
export interface CanvasFlushView {
  readonly ok: boolean;
  readonly timedOut: boolean;
  readonly error: { readonly message: string } | null;
}

/** CR-R2-6：画布保存契约单源——open / beginClosing 取自 core，save / flush 保留消费视图。 */
export type CanvasDocumentStore = Pick<CanvasStore, 'open' | 'beginClosing'> & {
  readonly save: (id: string, text: string) => Promise<unknown>;
  flush(options?: { readonly timeoutMs?: number }): Promise<CanvasFlushView>;
};

export interface CanvasEngineOptions {
  readonly host: HTMLElement;
  readonly store: CanvasDocumentStore;
  readonly canvasId: string;
  readonly dpr?: number;
  readonly palette?: Partial<GridPalette>;
  /** B5：挂载成功后登记当前实例，供关窗守卫触达。 */
  readonly registry?: CanvasEngineRegistry;
  /** C0-C：CanvasView 已 open + 分类；挂载时复用，避免同一画布读两次。 */
  readonly initialOpen?: CanvasOpenResult;
  /** CR-20261119-05：文档节点预览数据源（live text 优先，其次只读快照）。 */
  readonly docSource?: CanvasDocSource;
  /** CR-20261121-56：卡片出链/反链计数（app 层提供，wiki 语义；null=索引未就绪）。 */
  readonly readDocLinkCounts?: (path: string) => DocLinkCounts | null;
  /** CR-20261121-59：提示词右下角「开始」钮 → 所连 AI 节点执行。 */
  readonly onRunPrompt?: (id: string) => void;
  readonly onUpdateAiText?: (id: string, text: string) => boolean;
  readonly onRunAi?: (id: string) => void;
  /** CR-20261121-45 项3/项2：文档节点「展开」→ 打开阅读浮窗（AppShell 层）。 */
  readonly onOpenReadMode?: (payload: {
    readonly docPath: string;
    readonly title: string;
    readonly sourceNodeId: string;
  }) => void;
}

/** CR-20261119-05：预览访问器注入点；由 CanvasView 经 ember-store 提供。 */
export interface CanvasDocSource {
  readonly readLiveText: (path: string) => string | null;
  readonly readSnapshot: (path: string) => Promise<string>;
}

export interface CanvasDragTelemetry {
  /** 节点拖拽输入对应的绘制帧：输入回调 JS + draw JS，单位 ms。 */
  readonly dragJsSamples: readonly number[];
  /** 每次 hitTarget 的端口→节点→连线命中总耗时，单位 ms。 */
  readonly hitTestSamples: readonly number[];
  readonly dragFrames: number;
}

export type { CanvasNotice, CanvasNoticeCode } from './notice.ts';

/** C0-D：engine 对 React 层发射的交互事件。 */
export type CanvasEngineEvent =
  | { readonly kind: 'contextMenu'; readonly screenPoint: Point; readonly target: CanvasHitTarget }
  | { readonly kind: 'doubleClickNode'; readonly nodeId: string }
  | {
      readonly kind: 'mediaDropToEditor';
      readonly windowId: string;
      readonly clientPoint: Point;
      readonly media: {
        readonly kind: 'image' | 'audio' | 'video';
        readonly path: string;
        readonly label: string;
      };
    }
  | {
      readonly kind: 'connectionDropEmpty';
      readonly screenPoint: Point;
      readonly worldPoint: Point;
      readonly from: { readonly nodeId: string; readonly portId: string };
    };

// CR-20261119-11：常量归 consts.ts，消除与 resize-math.ts 的 ESM 循环。
import { PORT_HALF_HIT, RESIZE_HANDLE_HIT } from './consts.ts';
import { cursorForResizeDir, resolveResizeZone, type ResizeDir } from './resize-math.ts';

/** CSS Modules 的索引签名在 noUncheckedIndexedAccess 下是 string | undefined。 */
function classOf(name: string): string {
  const value = styles[name];
  if (value === undefined) throw new Error(`画布缺少 CSS 类：${name}`);
  return value;
}

const KEY_PAN_PX = 40;
const KEY_PAN_FAST_PX = 160;
export const KEY_ZOOM_FACTOR = 1.2;
const WHEEL_ZOOM_RATE = 0.0015;

/** CR-20261119-05：事件目标是否位于文档节点的内容滚动容器内（不被 CSS Modules 类名耦合）。 */
function isInsideNodeContent(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-node-scroll]') !== null;
}

/** CR-20261121-48：媒体画面单击切换播放。pointerup 属于用户激活事件，play() 可正常启动。 */
function toggleMediaPlayback(media: HTMLMediaElement): void {
  if (!media.paused) {
    media.pause();
    return;
  }
  const started: Promise<void> | undefined = media.play();
  // 解码/加载失败由元素自身 error 事件回退为占位，这里只吞掉未处理的 Promise 拒绝。
  void started?.catch(() => undefined);
}

export class CanvasEngine {
  private readonly host: HTMLElement;
  private readonly store: CanvasDocumentStore;
  private readonly canvasId: string;
  private readonly paletteOverride: Partial<GridPalette> | undefined;
  private readonly registry: CanvasEngineRegistry | undefined;
  private readonly initialOpen: CanvasOpenResult | undefined;
  private readonly dprOverride: number | undefined;
  /** CR-20261119-05：文档预览 LRU/截断/元数据缓存；缺省不启用（测试与无 docSource 场景）。 */
  private readonly docPreview: DocPreviewService | null;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly world: WorldLayer;
  private readonly nodes: NodeLayer;
  private readonly edges: EdgeLayer;
  private readonly pulse: EdgePulseLayer = createEdgePulseLayer(classOf('edgePulse'));
  private readonly highlight: EdgeLayer;
  private readonly listeners = new AbortController();
  private readonly mountGuard = createCanvasMountGuard();

  private transform: ViewportTransform = createViewportTransform();
  private size: ViewportSize = { width: 1, height: 1 };
  private dpr: number;
  private frame: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private mounted = false;
  private stopped = false;
  private mountPromise: Promise<void> | null = null;
  private controller: CanvasInteractionController | null = null;
  private registryToken: number | null = null;
  private interactionLocked = false;
  private issues: readonly CanvasSchemaIssue[] = [];
  private nodeViews: readonly CanvasNodeView[] = [];
  private edgeViews: readonly CanvasEdgeView[] = [];
  private screenEdges: readonly ScreenEdge[] = [];
  private readonly screenEdgeCache = createScreenEdgeCache();
  private readonly dirtyNodeIds = new Set<string>();
  /** CR-20261119-12：autoH 测量结果暂存；与 view.autoH 同步。 */
  private readonly autoHeights = new Map<string, number>();
  /** CR-20261119-12：待测量的 id 集合；scheduleMeasure 加，draw 内 measure 后清。 */
  private readonly pendingMeasureIds = new Set<string>();
  /** CR-20261119-12：本帧 autoH 变化的 id；draw 内并入 movedNodeIds 重排端点。 */
  private readonly pendingAutoEdgeIds = new Set<string>();
  /** CR-20261119-09：syncViewsFromDocument / applyExternalDocument 后置 true，触发 draw 调 setNodes；成功后复位 false。 */
  private nodeLayerDirty = false;
  /** CR-20261122-63：每次 mount 的初始适配周期；用户操作即永久结束本周期。 */
  private initialFit: { stableFrames: number; fontsPending: boolean } | null = null;
  private interaction: InteractionState = createInteractionState();
  private edgeWarning: EdgeDrawWarning | null = null;
  private readonly frameState = createFrameState();
  private readonly gridInvalidation = createGridInvalidation();
  private activePointerId: number | null = null;
  /** CR-20261121-48：媒体画面按压快照。press 落在播放器画面（非控件条）时记录，
   *  pointerup 位移未超阈值即视为单击，由画布层切换播放/暂停（pointerdown 的
   *  preventDefault + pointer capture 会吞掉原生 click，不能依赖原生播放封面按钮）。 */
  private mediaPress: {
    readonly player: HTMLMediaElement;
    readonly x: number;
    readonly y: number;
    moved: boolean;
  } | null = null;
  private spaceDown = false;
  private marqueeElement: HTMLDivElement | null = null;
  private draftElement: SVGSVGElement | null = null;
  private draftPath: SVGPathElement | null = null;
  private status: CanvasNotice | null = null;
  private readonly noticeListeners = new Set<(notice: CanvasNotice) => void>();
  private readonly onceNotices = new Set<CanvasNoticeCode>();
  /** C0-D：contextmenu / doubleClickNode 等事件通道。 */
  private readonly engineEventListeners = new Set<(event: CanvasEngineEvent) => void>();
  private dragMeasuring = false;
  /** 主题切换（data-theme / 系统外观）时重绘网格背景。 */
  private unsubscribeTheme: (() => void) | null = null;
  private dragInputMs = 0;
  private dragFramePending = false;
  private readonly dragJsSamples: number[] = [];
  private readonly hitTestSamples: number[] = [];

  constructor(options: CanvasEngineOptions) {
    this.host = options.host;
    this.store = options.store;
    this.canvasId = options.canvasId;
    this.registry = options.registry;
    this.initialOpen = options.initialOpen;
    this.dprOverride = options.dpr;
    this.dpr = readCanvasDpr(options.dpr);
    this.paletteOverride = options.palette;
    this.docPreview =
      options.docSource === undefined
        ? null
        : createDocPreviewService({
            readLiveText: options.docSource.readLiveText,
            readSnapshot: options.docSource.readSnapshot,
            onUpdate: () => {
              this.markDocumentNodesDirty();
            },
          });

    this.canvas = document.createElement('canvas');
    this.canvas.className = classOf('grid');
    this.canvas.dataset.layer = 'grid';
    this.canvas.setAttribute('aria-hidden', 'true');
    const context = this.canvas.getContext('2d');
    if (context === null) throw new Error('无法创建 Canvas 2D 上下文');
    this.ctx = context;

    this.world = createWorldLayer(classOf('world'));
    this.world.element.dataset.layer = 'world';
    this.edges = createEdgeLayer({ className: classOf('edges'), layerName: 'edges' });
    this.highlight = createEdgeLayer({ className: classOf('highlight'), layerName: 'highlight' });
    this.nodes = createNodeLayer(this.world.getWorldElement(), {
      className: classOf('nodeLayer'),
      glowClassName: classOf('ambientGlow'),
      nodeClassName: classOf('node'),
      selectedClassName: classOf('selected'),
      mediaClassNames: {
        image: classOf('mediaImage'), label: classOf('mediaLabel'), placeholder: classOf('mediaPlaceholder'),
        kicker: classOf('mediaKicker'), kickerBadge: classOf('mediaKickerBadge'),
        surface: classOf('mediaSurface'), footer: classOf('mediaFooter'), document: classOf('mediaDocument'),
        player: classOf('media-player'), audioEl: classOf('mediaAudioEl'),
        audioPlayer: classOf('mediaAudioPlayer'), audioPlay: classOf('mediaAudioPlay'),
        audioTrack: classOf('mediaAudioTrack'), audioFill: classOf('mediaAudioFill'), audioTime: classOf('mediaAudioTime'),
      },
      docClassNames: {
        body: classOf('docBody'), summary: classOf('docSummary'),
        kicker: classOf('docKicker'), kickerBadge: classOf('docKickerBadge'),
        footer: classOf('docFooter'),
        tags: classOf('docTags'), tag: classOf('docTag'), meta: classOf('docMeta'),
        links: classOf('docLinks'), linkOut: classOf('docLinkOut'), linkBack: classOf('docLinkBack'),
        content: classOf('docContent'), clip: classOf('docClip'), text: classOf('docText'),
        hint: classOf('docHint'), expand: classOf('docExpand'),
      },
      readDocMeta: (path) => this.docPreview?.getMeta(path) ?? null,
      readDocText: (path) => this.docPreview?.getText(path) ?? null,
      readDocLinkCounts: options.readDocLinkCounts,
      // CR-20261121-59：提示词右下角「开始」钮 → 所连 AI 节点执行。
      onRunPrompt: options.onRunPrompt,
      onUpdateAiText: options.onUpdateAiText, onRunAi: options.onRunAi,
      onOpenAiModel: (id) => this.emitEngineEvent({ kind: 'doubleClickNode', nodeId: id }),
      simpleClassNames: {
        title: classOf('nodeCardTitle'), icon: classOf('nodeCardIcon'),
        content: classOf('nodeCardContent'), run: classOf('nodeRunBtn'), empty: classOf('nodeCardEmpty'),
        footer: classOf('nodeCardFooter'),
      },
      aiClassNames: {
        root: classOf('aiCard'), header: classOf('aiHeader'), title: classOf('aiTitle'),
        model: classOf('aiModel'), prompt: classOf('aiPrompt'), footer: classOf('aiFooter'),
        actions: classOf('aiActions'), chip: classOf('aiChip'), run: classOf('aiRun'),
        runner: classOf('aiRunner'), runnerGlow: classOf('aiRunnerGlow'), runnerCore: classOf('aiRunnerCore'),
      },
      // CR-20261120-34：内容模式渲染为只读 Markdown 预览（安全 DOM，无 raw HTML）。
      renderDocPreview: createDocPreviewRenderer(),
      // CR-20261121-45 外标题/占位类名
      labelClassName: classOf('nodeLabel'),
      placeholderClassName: classOf('nodePlaceholder'),
      // CR-20261119-12：node-layer 测量回调——engine 私有方法绑定
      measureAutoHeight: (id, h) => this.onAutoHeightMeasured(id, h),
      // CR-20261121-45 项3：文档节点「展开」→ 打开阅读浮窗（D2）
      onOpenReadMode: (id) => {
        const node = this.nodeViews.find((view) => view.id === id);
        if (node === undefined || node.docPath === undefined) return;
        options.onOpenReadMode?.({ docPath: node.docPath, title: node.label, sourceNodeId: node.id });
      },
    });
  }

  mount(): Promise<void> {
    if (this.mountPromise !== null) return this.mountPromise;
    this.mountPromise = this.doMount();
    return this.mountPromise;
  }

  private async doMount(): Promise<void> {
    const generation = this.mountGuard.begin();
    this.mounted = true;
    this.host.classList.add(classOf('viewport'));
    this.host.setAttribute('role', 'application');
    this.host.setAttribute('aria-label', '画布视图');
    if (this.host.tabIndex < 0) this.host.tabIndex = 0;

    this.host.append(this.canvas, this.edges.element, this.pulse.element, this.world.element, this.highlight.element);
    this.attachEvents();
    this.resize();

    try {
      const opened =
        this.initialOpen ??
        (await this.store.open(this.canvasId));
      // StrictMode / dispose-during-mount：过期结果不得写状态、注册或清理新实例。
      if (!this.mounted || !this.mountGuard.isCurrent(generation)) return;
      const document =
        opened.text === null ? createEmptyCanvasDocument() : parseCanvasDocument(opened.text);
      const schema = inspectCanvasDocument(document);
      this.issues = schema.issues;
      this.controller = new CanvasInteractionController({
        canvasId: this.canvasId,
        store: this.store,
        document,
        readOnly: schema.readOnly,
        issues: schema.issues,
        applyPositions: (positions) => {
          this.setNodePositions(positions);
        },
        onConflict: () => {
          this.emitNotice({
            code: 'E_CONFLICT',
            message: '文件已被外部修改；已停止保存，撤销仍可用',
            persistent: true,
          });
        },
        onSaveError: (error) => {
          this.emitNotice({
            code: 'E_SAVE_FAILED',
            message: `${error.code}: ${error.message}`,
            persistent: true,
          });
        },
        onCommandError: (error) => {
          this.emitNotice({
            code: 'E_COMMAND',
            message: `${error.code}: ${error.message}`,
            persistent: false,
          });
        },
      });
      const view = createCanvasDocumentView({
        document,
        projection: schema.projection,
        transform: this.transform,
      });
      this.transform = view.transform;
      this.nodeViews = view.nodeViews;
      this.edgeViews = view.edgeViews;
      this.interaction = view.interaction;
      this.dirtyNodeIds.clear();
      for (const node of this.nodeViews) this.dirtyNodeIds.add(node.id);
      this.initialFit = { stableFrames: 0, fontsPending: false };
      this.applyTransform(this.transform);
      this.autoHeightPruneAndSchedule();
      this.registerInstance();
      this.scheduleFrame();
      // CR-20261119-12 / CR-20261122-63：字体加载后重测，并在初始适配周期内重新居中。
      const fonts =
        typeof globalThis.document !== 'undefined' && 'fonts' in globalThis.document
          ? globalThis.document.fonts
          : null;
      if (fonts !== null) {
        this.initialFit.fontsPending = true;
        void fonts.ready.then(
          () => {
            if (!this.mounted || !this.mountGuard.isCurrent(generation)) return;
            if (this.initialFit !== null) this.initialFit.fontsPending = false;
            const allAutoIds = this.nodeViews
              .filter((v) => v.h === undefined && (v.docPath !== undefined || v.kind === 'prompt'))
              .map((v) => v.id);
            if (allAutoIds.length > 0) this.scheduleMeasure(allAutoIds);
            else this.scheduleFrame();
          },
          () => {
            if (!this.mounted || !this.mountGuard.isCurrent(generation)) return;
            if (this.initialFit !== null) this.initialFit.fontsPending = false;
            this.scheduleFrame();
          },
        );
      }
      if (schema.readOnly) this.emitSchemaNotice();
    } catch (error) {
      // 挂载失败只清理本实例，不 flush、不 beginClosing；失败实例不可复用。
      this.abortMount();
      throw error;
    }
  }

  private registerInstance(): void {
    if (this.registry === undefined || this.registryToken !== null) return;
    this.registryToken = this.registry.register({
      lockInteraction: () => {
        this.lockInteraction();
      },
      resumeInteraction: () => {
        this.resumeInteraction();
      },
      flush: () => this.flushPending(),
      dispose: () => this.dispose(),
    });
  }

  private emitSchemaNotice(): void {
    const count = this.issues.length;
    this.emitNotice({
      code: 'E_SCHEMA',
      message:
        count === 0
          ? '画布 schema 已恢复'
          : `画布包含 ${count} 处 schema 问题；已整幅只读，修复后重新打开`,
      persistent: count > 0,
    });
  }

  serialize(): string {
    return this.controller?.serialize() ?? serializeCanvasDocument(createEmptyCanvasDocument());
  }

  getWorldElement(): HTMLElement {
    return resolveWorldElement(this.world);
  }

  /** 裁决 1A：唯一连线选中 API；多 id 同帧高亮，不保留 setSelectedEdge 包装。 */
  setSelectedEdges(edgeIds: readonly string[]): void {
    this.interaction = setInteractionSelection(this.interaction, {
      nodes: this.interaction.selection.nodes,
      edges: new Set(edgeIds),
    });
    this.applySelection(this.interaction);
    this.scheduleFrame();
  }

  getSelection(): { readonly nodes: ReadonlySet<string>; readonly edges: ReadonlySet<string> } {
    return {
      nodes: new Set(this.interaction.selection.nodes),
      edges: new Set(this.interaction.selection.edges),
    };
  }

  /** 渲染位置补丁；文档只由 controller 改写，预览调用不会触发保存。 */
  setNodePositions(patch: readonly CanvasPositionPatch[]): void {
    const positions = new Map(patch.map((position) => [position.id, position]));
    let changed = false;
    this.nodeViews = this.nodeViews.map((node) => {
      const position = positions.get(node.id);
      if (position === undefined || (node.x === position.x && node.y === position.y)) return node;
      changed = true;
      this.dirtyNodeIds.add(node.id);
      return { ...node, x: position.x, y: position.y };
    });
    if (changed) this.scheduleFrame();
  }

  hitTestEdge(point: Point): EdgeHit | null {
    if (this.dirtyNodeIds.size > 0) this.updateScreenEdges(new Set(this.dirtyNodeIds));
    return hitTestEdges(this.screenEdges, point);
  }

  getEdgeWarning(): EdgeDrawWarning | null {
    return this.edgeWarning;
  }

  getFrameStats(): CanvasFrameStats {
    return this.frameState.getStats();
  }

  getDragTelemetry(): CanvasDragTelemetry {
    return {
      dragJsSamples: [...this.dragJsSamples],
      hitTestSamples: [...this.hitTestSamples],
      dragFrames: this.dragJsSamples.length,
    };
  }

  getCanvasStatus(): CanvasNotice | null {
    return this.status;
  }

  /** 状态栏读取 getCanvasStatus；toast 订阅本事件。E_PRECISION/E_CONFLICT 同码只提示一次。 */
  subscribeCanvasNotices(listener: (notice: CanvasNotice) => void): () => void {
    this.noticeListeners.add(listener);
    if (this.status !== null) listener(this.status);
    return () => {
      this.noticeListeners.delete(listener);
    };
  }

  resetPrecisionView(): void {
    this.finishInitialFit();
    if (this.status?.code === 'E_PRECISION') this.status = null;
    this.onceNotices.delete('E_PRECISION');
    this.applyTransform(resetView(this.transform));
  }

  undo(): boolean {
    const changed = this.controller?.undo() ?? false;
    if (changed) this.afterDocumentMutation();
    return changed;
  }

  redo(): boolean {
    const changed = this.controller?.redo() ?? false;
    if (changed) this.afterDocumentMutation();
    return changed;
  }

  isReadOnly(): boolean {
    return this.controller?.isReadOnly() ?? false;
  }

  getSchemaIssues(): readonly CanvasSchemaIssue[] {
    return this.issues;
  }

  /** B3：非破坏锁定——阻止新输入并取消活动手势，保留 DOM/rAF/observer 供恢复。 */
  lockInteraction(): void {
    if (this.interactionLocked) return;
    this.interactionLocked = true;
    this.cancelGesture();
  }

  resumeInteraction(): void {
    this.interactionLocked = false;
  }

  isInteractionLocked(): boolean {
    return this.interactionLocked;
  }

  /** 关窗/切换前只发未保存文档，不含 core 队列 flush。 */
  flushPending(): Promise<void> {
    return this.controller?.flushSave() ?? Promise.resolve();
  }

  /**
   * C5 冲突合并 C：二选一解决 E_CONFLICT 只读态。
   * - keep-local：覆盖外部版本为本地文档。
   * - accept-external：丢弃本地改动，加载外部版本；重新应用 origin、
   *   用投影重建视图并清幽灵选中/活动手势。
   */
  async resolveConflict(action: 'keep-local' | 'accept-external'): Promise<boolean> {
    if (this.controller === null) return false;
    const ok = await this.controller.resolveConflict(action);
    if (!ok) return false;
    if (action === 'accept-external') {
      this.applyExternalDocument(this.controller.getDocument());
      return true;
    }
    this.syncViewsFromDocument();
    if (this.status?.code === 'E_CONFLICT') {
      this.status = null;
      this.onceNotices.delete('E_CONFLICT');
    }
    this.scheduleFrame();
    return true;
  }

  private applyExternalDocument(document: CanvasDocument): void {
    const schema = inspectCanvasDocument(document);
    this.issues = schema.issues;
    const view = createCanvasDocumentView({
      document,
      projection: schema.projection,
      transform: this.transform,
    });
    this.transform = view.transform;
    this.nodeViews = view.nodeViews;
    this.edgeViews = view.edgeViews;
    // S1：外部版本替换后同样按新投影收敛选中集（视图工厂已给空集合，此处是显式双保险）。
    this.interaction = pruneInteraction(view.interaction, document);
    this.activePointerId = null;
    this.updateMarquee(null);
    this.clearDraftLine();
    this.dirtyNodeIds.clear();
    for (const node of this.nodeViews) this.dirtyNodeIds.add(node.id);
    this.applySelection(this.interaction);
    if (this.status?.code === 'E_CONFLICT') {
      this.status = null;
      this.onceNotices.delete('E_CONFLICT');
    }
    if (schema.readOnly) {
      this.emitSchemaNotice();
    } else if (this.status?.code === 'E_SCHEMA') {
      this.status = null;
      this.onceNotices.delete('E_SCHEMA');
    }
    // CR-20261119-12：合并 autoH + prune + 兜底补测
    this.autoHeightPruneAndSchedule();
    // CR-20261119-09：外部版本替换后视图已重建，必须触发 setNodes。
    this.nodeLayerDirty = true;
    this.scheduleFrame();
  }

  /** 破坏性清理：只用于确定不再复用的实例；不 flush、不 beginClosing。 */
  private lastHoverNodeId: string | null = null;
  private lastPortHighlightKey = '';

  /** CR-20261121-45 项4：命中最上层节点（屏幕矩形包含点）。 */
  private hitNode(point: { readonly x: number; readonly y: number }): CanvasNodeView | null {
    for (let i = this.nodeViews.length - 1; i >= 0; i--) {
      const node = this.nodeViews[i];
      if (node === undefined) continue;
      const rect = nodeScreenRect(node, this.transform);
      if (point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom) {
        return node;
      }
    }
    return null;
  }

  /** CR-20261121-45 项4：选中连线的端点节点 → 端口高亮（变化才下发）。 */
  private syncPortHighlight(): void {
    const selected = this.interaction.selection.edges;
    if (selected.size === 0) {
      if (this.lastPortHighlightKey !== '') {
        this.lastPortHighlightKey = '';
        this.nodes.setPortHighlight(new Set());
      }
      return;
    }
    const ids = new Set<string>();
    for (const view of this.edgeViews) {
      if (selected.has(view.id)) {
        ids.add(view.from);
        ids.add(view.to);
      }
    }
    const key = [...ids].sort().join('\u0000');
    if (key !== this.lastPortHighlightKey) {
      this.lastPortHighlightKey = key;
      this.nodes.setPortHighlight(ids);
    }
  }

  /**
   * 用户 2026-11-24：拖拽悬停端口高亮的显式复位。connectionDraft 悬停直接
   * setPortHighlight，绕过了 syncPortHighlight 的 key 去重；手势收尾若只调
   * syncPortHighlight，空选区会因 key 未变而跳过 DOM 复位，途经的节点端口
   * 常亮放大（截图：生成1.md 两颗橙色圆点不灭）。手势收尾一律走这里：
   * 按当前选中边重算并强制重发（无选中边即清空）。
   */
  private resetDragPortHighlight(): void {
    const ids = new Set<string>();
    for (const view of this.edgeViews) {
      if (this.interaction.selection.edges.has(view.id)) {
        ids.add(view.from);
        ids.add(view.to);
      }
    }
    this.lastPortHighlightKey = [...ids].sort().join('\u0000');
    this.nodes.setPortHighlight(ids);
  }

  /** CR-20261121-44：网格调色板运行时解析令牌（options.palette 逐键覆写），主题切换即生效。 */
  private gridPalette(): GridPalette {
    const theme = themeColors();
    return {
      background: this.paletteOverride?.background ?? theme.canvasBg,
      dot: this.paletteOverride?.dot ?? theme.gridDot,
    };
  }

  dispose(): Promise<void> {
    this.teardown();
    return Promise.resolve();
  }

  /** 挂载失败清理：只清理本实例 DOM/监听/rAF/observer/controller。 */
  abortMount(): void {
    this.teardown();
  }

  private teardown(): void {
    this.mountGuard.invalidate();
    this.interactionLocked = false;
    this.controller = null;
    if (this.registry !== undefined && this.registryToken !== null) {
      this.registry.unregister(this.registryToken);
      this.registryToken = null;
    }
    this.stop();
  }

  private attachEvents(): void {
    const signal = this.listeners.signal;
    this.host.addEventListener('pointerdown', this.onPointerDown, { signal });
    this.host.addEventListener('pointermove', this.onPointerMove, { signal });
    this.host.addEventListener('pointerup', this.onPointerUp, { signal });
    this.host.addEventListener('pointercancel', this.onPointerCancel, { signal });
    this.host.addEventListener('pointerleave', this.onPointerLeave, { signal });
    this.host.addEventListener('wheel', this.onWheel, { passive: false, signal });
    this.host.addEventListener('keydown', this.onKeyDown, { signal });
    this.host.addEventListener('keyup', this.onKeyUp, { signal });
    this.host.addEventListener('blur', this.onBlur, { signal });
    // C0-D：右键菜单与双击文本编辑入口。
    this.host.addEventListener('contextmenu', this.onContextMenu, { signal });
    this.host.addEventListener('dblclick', this.onDoubleClick, { signal });
    // 2026-11-23：指针在画布 DOM 外松开时也要收尾；host 已处理则 activePointerId 已清空。
    if (typeof window !== 'undefined') window.addEventListener('pointerup', this.onWindowPointerUp);

    // 主题令牌失效后强制重绘网格：Canvas 2D 背景色是绘制时快照，不会随 CSS 自动更新。
    this.unsubscribeTheme = onThemeColorsChange(() => {
      this.gridInvalidation.invalidate();
      this.scheduleFrame();
    });

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.resize();
        this.scheduleFrame();
      });
      this.resizeObserver.observe(this.host);
    }
  }

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.mounted = false;
    this.initialFit = null;
    this.listeners.abort();
    if (typeof window !== 'undefined') window.removeEventListener('pointerup', this.onWindowPointerUp);
    this.unsubscribeTheme?.();
    this.unsubscribeTheme = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    this.updateMarquee(null);
    this.clearDraftLine();
    this.host.style.cursor = '';
    this.edges.dispose(); this.pulse.dispose();
    this.highlight.dispose();
    this.nodes.dispose();
    this.world.dispose();
    this.canvas.remove();
    this.docPreview?.dispose();
  }

  private localPoint(event: PointerEvent | WheelEvent): Point {
    const rect = this.host.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private hitTarget(point: Point, allowResize = false): CanvasHitTarget {
    const started = performance.now();
    try {
      // CR-20261119-11：8 方向缩放 zone 优先于端口/节点命中。
      if (allowResize) {
        const zone = this.hitResizeHandle(point);
        if (zone !== null) return { kind: 'resize', id: zone.id, direction: zone.dir };
      }
      // C0-D：port 在 node 和 edge 前查，因为端口在节点边缘上。
      const port = this.hitTestPort(point);
      if (port !== null) return { kind: 'port', port };
      const node = hitTestNodes(this.nodeViews, this.transform, point);
      if (node !== null) return { kind: 'node', id: node.id };
      const edge = this.hitTestEdge(point);
      return edge === null ? { kind: 'blank' } : { kind: 'edge', id: edge.edgeId };
    } finally {
      this.hitTestSamples.push(performance.now() - started);
    }
  }

  /** CR-20261119-11：8 方向无边框缩放 zone；只读/多选不命中；端口 zone 让给 hitTarget 的 port 分支。 */
  private hitResizeHandle(point: Point): { readonly id: string; readonly dir: ResizeDir } | null {
    if (this.isReadOnly()) return null;
    const selection = this.interaction.selection.nodes;
    if (selection.size !== 1) return null;
    const id = [...selection][0];
    if (id === undefined) return null;
    const node = this.nodeViews.find((item) => item.id === id);
    if (node === undefined) return null;
    // 用户 2026-11-23：AI / 提示词节点尺寸固定，不提供缩放手柄。
    if (isFixedSizeNodeKind(node.kind)) return null;
    const rect = nodeScreenRect(node, this.transform);
    const zone = resolveResizeZone(rect, point, RESIZE_HANDLE_HIT);
    if (zone.dir === null) return null;  // 端口 zone 或无 zone
    return { id, dir: zone.dir };
  }

  /** CR-20261119-11：8 方向光标。hover 时按 resolveResizeZone 拿方向，拖拽时按 gesture.direction。 */
  private updateResizeCursor(point: Point | null, allowHover: boolean): void {
    const gesture = this.interaction.gesture;
    if (gesture !== null && gesture.kind === 'resize') {
      this.host.style.cursor = cursorForResizeDir(gesture.direction);
      return;
    }
    if (allowHover && gesture === null && point !== null) {
      const zone = this.hitResizeHandle(point);
      if (zone !== null) {
        this.host.style.cursor = cursorForResizeDir(zone.dir);
        return;
      }
    }
    this.host.style.cursor = '';
  }

  /** C0-D：默认端口位置（in 左 / out 右），热区 ±PORT_HALF_HIT。 */
  private hitTestPort(point: Point): CanvasPortHit | null {
    for (const node of this.nodeViews) {
      const rect = nodeScreenRect(node, this.transform);
      const cxIn = rect.left;
      // N3 修正：端口纵向中点跟随节点实际屏幕高度（含显式 h）。
      const cy = (rect.top + rect.bottom) / 2;
      if (
        Math.abs(point.x - cxIn) <= PORT_HALF_HIT &&
        Math.abs(point.y - cy) <= PORT_HALF_HIT
      ) {
        return { nodeId: node.id, portId: 'in', dir: 'in' };
      }
      const cxOut = rect.right;
      if (
        Math.abs(point.x - cxOut) <= PORT_HALF_HIT &&
        Math.abs(point.y - cy) <= PORT_HALF_HIT
      ) {
        return { nodeId: node.id, portId: 'out', dir: 'out' };
      }
    }
    return null;
  }

  /**
   * CR-20261121-46：媒体播放控件区命中（DOM 提取部分，纯判定在 interaction.isMediaChromePress）。
   * node-layer 在控件区标 `data-media-player`：视频在 `<video>` 元素上（只让出底部
   * 控件条），CR-20261121-56 起音频在自定义控件条容器上（条形区域整行让位）。
   * 命中 → 控件接管（不建手势/不捕获/不 preventDefault）；其余放行给画布手势。
   */
  private isMediaChromePress(event: PointerEvent): boolean {
    const region = this.mediaPlayerRegion(event);
    if (region === null) return false;
    const kind = region.getAttribute('data-media-player');
    const rect = region.getBoundingClientRect();
    // width/height 全 0 = 测试假 DOM 或未布局元素，视为拿不到 rect。
    const hasRect = rect.width > 0 || rect.height > 0;
    return isMediaChromePress(
      kind,
      hasRect ? { top: rect.top, bottom: rect.bottom } : null,
      event.clientY,
    );
  }

  /** 事件目标所在的控件区元素（node-layer 的 data-media-player 标记；任意元素）。 */
  private mediaPlayerRegion(event: PointerEvent): Element | null {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    return target.closest('[data-media-player]');
  }

  /** CR-48 视频画面本体的待单击判定：仍是 HTMLMediaElement 能力判定（音频条容器会被排除）。 */
  private mediaPlayerElement(event: PointerEvent): HTMLMediaElement | null {
    const region = this.mediaPlayerRegion(event);
    if (region === null) return null;
    // 用能力判定代替 HTMLMediaElement instanceof：无 DOM 全局的测试环境安全。
    return typeof (region as Partial<HTMLMediaElement>).play === 'function'
      ? (region as HTMLMediaElement)
      : null;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (
      !this.mounted ||
      this.interactionLocked ||
      this.activePointerId !== null ||
      (event.button !== 0 && event.button !== 1)
    ) {
      return;
    }
    this.finishInitialFit();
    // CR-20261121-46：控件区按压交给原生播放控件；必须在 preventDefault 之前早退。
    if (this.isMediaChromePress(event)) {
      this.mediaPress = null;
      return;
    }
    // CR-20261121-59：节点内置控件（提示词 ▶ 开始钮等，data-node-control 标记）——
    // 按压让给控件自身：不早退会建节点拖拽手势，click 被手势吞掉、按钮失灵。
    if (event.target instanceof Element && event.target.closest('[data-node-control]') !== null) {
      return;
    }
    // CR-20261121-48：画面本体按压记为「待单击」，pointerup 未拖拽时切换播放。
    const player = event.button === 0 ? this.mediaPlayerElement(event) : null;
    this.mediaPress =
      player === null
        ? null
        : { player, x: event.clientX, y: event.clientY, moved: false };
    const started = performance.now();
    try {
      event.preventDefault();
      this.host.focus({ preventScroll: true });
      const point = this.localPoint(event);
      const pan = event.button === 1 || (event.button === 0 && this.spaceDown);
      const allowResize =
        event.button === 0 &&
        !event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey;
      const target: CanvasHitTarget = pan ? { kind: 'blank' } : this.hitTarget(point, allowResize);
      if (target.kind === 'node') {
        this.dragMeasuring = true;
        this.dragInputMs = 0;
      }
      const result = reduceInteraction(this.interaction, {
        type: 'pointerDown',
        point,
        button: event.button,
        shiftKey: event.shiftKey,
        toggleKey: event.metaKey || event.ctrlKey,
        altKey: event.altKey,
        pan,
        target,
        nodes: this.nodeViews,
        readOnly: this.isReadOnly(),
      });
      this.interaction = result.state;
      this.applyEffects(result.effects);
      this.updateResizeCursor(point, false);
      this.activePointerId = event.pointerId;
      this.host.setPointerCapture(event.pointerId);
    } finally {
      if (this.dragMeasuring) this.dragInputMs += performance.now() - started;
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.mounted) return;
    const point = this.localPoint(event);
    if (event.pointerId !== this.activePointerId) {
      if (this.activePointerId === null && !this.interactionLocked) {
        this.updateResizeCursor(point, true);
        // CR-20261121-45 项4：悬停节点 → 端口圆点显现（仅 hover 集变化时下发）
        const node = this.hitNode(point);
        const hoverId = node?.id ?? null;
        if (hoverId !== this.lastHoverNodeId) {
          this.lastHoverNodeId = hoverId;
          this.nodes.setHoverNode(hoverId);
        }
      }
      return;
    }
    if (this.lastHoverNodeId !== null) {
      this.lastHoverNodeId = null;
      this.nodes.setHoverNode(null);
    }
    // 媒体画面按压超过 3px 视为拖拽，pointerup 不再触发播放切换。
    const press = this.mediaPress;
    if (press !== null && !press.moved) {
      const dx = event.clientX - press.x;
      const dy = event.clientY - press.y;
      if (dx * dx + dy * dy > 9) press.moved = true;
    }
    const started = performance.now();
    try {
      const nodeDrag = this.interaction.gesture?.kind === 'node';
      const result = reduceInteraction(this.interaction, {
        type: 'pointerMove',
        point,
        scale: this.transform.scale,
        // C0-D：连线过程中实时检查指针下方是否有端口。
        target: this.hitTarget(point),
      });
      this.interaction = result.state;
      this.applyEffects(result.effects);
      this.updateResizeCursor(point, false);
      if (nodeDrag) this.dragFramePending = true;
    } finally {
      if (this.dragMeasuring) this.dragInputMs += performance.now() - started;
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) return;
    const mediaPress = this.mediaPress;
    this.mediaPress = null;
    const started = performance.now();
    const nodeDrag = this.interaction.gesture?.kind === 'node';
    try {
      const gesture = this.interaction.gesture;
      const point = this.localPoint(event);
      const marquee = gesture?.kind === 'marquee' && gesture.active
        ? marqueeNodeIds(
            this.nodeViews,
            this.transform,
            {
              left: Math.min(gesture.start.x, point.x),
              top: Math.min(gesture.start.y, point.y),
              right: Math.max(gesture.start.x, point.x),
              bottom: Math.max(gesture.start.y, point.y),
            },
          )
        : [];
      const editorWindowId = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>('[data-editor-window-id]')?.dataset.editorWindowId;
      const result = reduceInteraction(this.interaction, {
        type: 'pointerUp',
        point,
        scale: this.transform.scale,
        target: this.hitTarget(point),
        marqueeNodeIds: marquee,
        ...(gesture?.kind === 'node' && editorWindowId !== undefined
          ? {
              editorDrop: {
                windowId: editorWindowId,
                clientPoint: { x: event.clientX, y: event.clientY },
              },
            }
          : {}),
      });
      this.interaction = result.state;
      this.applyEffects(result.effects);
      // CR-20261121-48：画面单击（未拖拽）切换播放/暂停；拖拽节点不触发。
      if (mediaPress !== null && !mediaPress.moved) toggleMediaPlayback(mediaPress.player);
      this.updateResizeCursor(point, !this.interactionLocked);
      if (nodeDrag) this.dragFramePending = true;
    } finally {
      if (this.dragMeasuring) this.dragInputMs += performance.now() - started;
      if (nodeDrag) this.dragMeasuring = false;
      this.releasePointer(event.pointerId);
    }
  };

  /**
   * 2026-11-23：host 的 pointerup 没收到（指针在画布 DOM 外松开）时的兜底。
   * host 已处理时 activePointerId 已在 releasePointer 中清空，这里直接跳过。
   */
  private readonly onWindowPointerUp = (event: PointerEvent): void => {
    if (!this.mounted || event.pointerId !== this.activePointerId) return;
    if (this.interaction.gesture?.kind !== 'connection') return;
    const rect = this.host.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const result = reduceInteraction(this.interaction, {
      type: 'pointerUp',
      point,
      scale: this.transform.scale,
      target: { kind: 'blank' },
    });
    this.interaction = result.state;
    this.applyEffects(result.effects);
    this.releasePointer(event.pointerId);
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) return;
    this.cancelGesture();
    this.releasePointer(event.pointerId);
  };

  private readonly onPointerLeave = (): void => {
    // 空闲离开即还原；resize 捕获指针期间即使移出热区也保持 nwse-resize。
    this.updateResizeCursor(null, false);
    // 用户 2026-11-24：指针离画布后不再有 move 事件把 hover 清掉，显式复位，
    // 否则最后悬停节点的端口常亮（data-hover 与拖拽悬停同款式）。
    if (this.lastHoverNodeId !== null) {
      this.lastHoverNodeId = null;
      this.nodes.setHoverNode(null);
    }
  };

  private releasePointer(pointerId: number): void {
    if (this.host.hasPointerCapture(pointerId)) this.host.releasePointerCapture(pointerId);
    this.activePointerId = null;
  }

  /** @internal CR-20261119-13：命令总线可调用；暴露给 CanvasViewController 委托层。 */
  cancelGesture(): void {
    this.mediaPress = null;
    const nodeDrag = this.interaction.gesture?.kind === 'node';
    const result = reduceInteraction(this.interaction, { type: 'cancel' });
    this.interaction = result.state;
    this.applyEffects(result.effects);
    this.updateResizeCursor(null, false);
    if (nodeDrag) {
      this.dragFramePending = true;
      this.dragMeasuring = false;
    }
    if (this.activePointerId !== null && this.host.hasPointerCapture(this.activePointerId)) {
      this.host.releasePointerCapture(this.activePointerId);
    }
    this.activePointerId = null;
  }

  /** @internal CR-20261119-13：重置缩放/平移到默认（scale=1.0, origin=(0,0)）。 */
  resetView(): void {
    this.finishInitialFit();
    this.applyTransform(resetView(this.transform));
  }

  /** @internal CR-20261119-13：是否有 in-progress gesture。 */
  hasActiveGesture(): boolean {
    return this.interaction.gesture !== null;
  }

  /** @internal CR-20261119-13：是否有选中节点或边。 */
  hasSelection(): boolean {
    return this.interaction.selection.nodes.size > 0 || this.interaction.selection.edges.size > 0;
  }

  private applyEffects(effects: readonly InteractionEffect[]): void {
    for (const effect of effects) {
      switch (effect.type) {
        case 'selection':
          this.applySelection(this.interaction);
          this.scheduleFrame();
          break;
        case 'preview':
          this.setNodePositions(effect.positions);
          break;
        case 'commit':
          if (this.controller?.commit(effect.command) ?? false) {
            this.afterDocumentMutation();
          } else {
            // B2：commit=false（冲突只读等）时用文档真值回写视图，消除预览漂移。
            this.syncViewsFromDocument();
          }
          break;
        case 'duplicate': {
          // ⌥复制：源节点已在 pointerUp 复位，这里只追加新节点副本。
          const commands = createDuplicateNodeCommands(effect.entries, this.getDocument().nodes);
          if (commands.length === 0) break;
          if (this.controller?.execute(commands) ?? false) {
            this.afterDocumentMutation();
          } else {
            this.syncViewsFromDocument();
          }
          break;
        }
        case 'resizePreview':
          this.setNodeRect(effect.id, effect.x, effect.y, effect.w, effect.h);
          break;
        case 'resizeCommit': {
          // CR-20261119-11：preview 只改 nodeViews，getDocument() 仍是 origin。
          const doc = this.getDocument();
          type OriginNode = { readonly id: string; readonly x: number; readonly y: number };
          const nodeBefore = (doc.nodes as readonly OriginNode[]).find((n) => n.id === effect.id);
          const originX = nodeBefore?.x ?? effect.x;
          const originY = nodeBefore?.y ?? effect.y;
          const dx = effect.x - originX;
          const dy = effect.y - originY;
          const commands: CanvasCommand[] = [];
          if (dx !== 0 || dy !== 0) {
            commands.push({ kind: 'move', entries: [{ id: effect.id, dx, dy }] });
          }
          commands.push({ kind: 'updateNode', id: effect.id, changes: { w: effect.w, h: effect.h } });
          if (this.controller?.execute(commands) ?? false) {
            this.afterDocumentMutation();
          } else {
            this.syncViewsFromDocument();
            this.emitNotice({
              code: 'E_RESIZE_FAILED',
              message: '调整节点尺寸失败，已恢复原尺寸',
              persistent: false,
            });
          }
          break;
        }
        case 'mediaDropToEditor':
          this.emitEngineEvent({
            kind: 'mediaDropToEditor',
            windowId: effect.windowId,
            clientPoint: effect.clientPoint,
            media: { kind: effect.kind, path: effect.path, label: effect.label },
          });
          break;
        case 'pan':
          this.applyTransform(panBy(this.transform, effect.delta));
          break;
        case 'marquee':
          this.updateMarquee(effect.rect);
          break;
        case 'connectionCommit': {
          // C0-D：pointerUp 落定前先过 I9 预检，非法候选不进 mutate/历史。
          this.clearDraftLine();
          this.resetDragPortHighlight();
          const candidate = {
            from: { nodeId: effect.fromNodeId, portId: effect.fromPortId },
            to: { nodeId: effect.toNodeId, portId: effect.toPortId },
          };
          const rejection = this.controller === null
            ? []
            : inspectConnectionCandidate(this.controller.getDocument(), candidate);
          const issue = rejection[0];
          if (issue !== undefined) {
            this.emitNotice({
              code: 'E_COMMAND',
              message: `连线未创建：${issue.message}`,
              persistent: false,
            });
            break;
          }
          if (
            this.controller?.execute([
              {
                kind: 'addEdge',
                edge: {
                  id: makeEdgeId(),
                  from: candidate.from,
                  to: candidate.to,
                },
              },
            ]) ?? false
          ) {
            this.afterDocumentMutation();
          }
          break;
        }
        case 'connectionDropEmpty': {
          // N4：先清草稿再弹菜单，保证菜单出现时无残留虚线。
          this.clearDraftLine();
          // 用户 2026-11-24：拖拽途经端口的高亮随手势收尾一并复位，否则菜单
          // 弹出后源/目标节点端口常亮放大（见 resetDragPortHighlight 注释）。
          this.resetDragPortHighlight();
          if (this.isReadOnly()) break;
          this.emitEngineEvent({
            kind: 'connectionDropEmpty',
            screenPoint: effect.point,
            worldPoint: this.screenToWorld(effect.point),
            from: effect.from,
          });
          break;
        }
        case 'connectionDraft': {
          // C1-E：只读态不绘制（手势本就不会建立，双保险）。
          if (this.isReadOnly()) break;
          this.updateDraftLine(effect.from, effect.current);
          // CR-20261121-59：拖拽经过端口 → 圆点放大+主题色（吸附反馈）；离开恢复选区高亮。
          const hovered = this.hitTestPort(effect.current);
          if (hovered !== null) {
            this.nodes.setPortHighlight(new Set([hovered.nodeId]));
          } else {
            this.syncPortHighlight();
          }
          break;
        }
        case 'connectionCancel':
          this.clearDraftLine();
          this.resetDragPortHighlight();
          break;
      }
    }
  }

  private applySelection(state: InteractionState): void {
    this.nodes.setSelectedNodes(state.selection.nodes);
  }

  /** CR-20261119-11：预览阶段同步更新单个节点的 x+y+w+h，不写历史、不触发 schema 校验。 */
  private setNodeRect(id: string, x: number, y: number, w: number, h: number): void {
    const previous = this.nodeViews.find((node) => node.id === id);
    if (previous === undefined || (previous.x === x && previous.y === y && previous.w === w && previous.h === h)) return;
    const next = { ...previous, x, y, w, h };
    this.nodeViews = this.nodeViews.map((node) => node.id === id ? next : node);
    if (next.docPath !== undefined && !isNodeContentMode(previous) &&
      isNodeContentMode(next) && this.isDocNodeVisible(next)) {
      void this.docPreview?.requestText(next.docPath);
    }
    this.dirtyNodeIds.add(id);
    this.scheduleFrame();
  }

  private updateMarquee(rect: Rect | null): void {
    if (rect === null) {
      this.marqueeElement?.remove();
      this.marqueeElement = null;
      return;
    }
    if (this.marqueeElement === null) {
      this.marqueeElement = document.createElement('div');
      this.marqueeElement.className = classOf('marquee');
      this.marqueeElement.dataset.layer = 'marquee';
      this.marqueeElement.setAttribute('aria-hidden', 'true');
      this.host.append(this.marqueeElement);
    }
    this.marqueeElement.style.left = `${rect.left}px`;
    this.marqueeElement.style.top = `${rect.top}px`;
    this.marqueeElement.style.width = `${rect.right - rect.left}px`;
    this.marqueeElement.style.height = `${rect.bottom - rect.top}px`;
  }

  /** R2：移除连线草稿；每次调用后引用置空，不重复挂载。 */
  private clearDraftLine(): void {
    this.draftElement?.remove();
    this.draftElement = null;
    this.draftPath = null;
  }

  /**
   * R2：拖动中的贝塞尔草稿。起点复用落定边同源锚点：
   * 世界坐标 `edgeAnchor(absolute, 'out', nodeSizeOf(node))` → `absoluteToScreen`；
   * 控制柄规则与落定边一致（connection-draft 与 edge-layout 共用常量）。
   */
  private updateDraftLine(from: CanvasPortHit, current: Point): void {
    const node = this.nodeViews.find((item) => item.id === from.nodeId);
    if (node === undefined) {
      this.clearDraftLine();
      return;
    }
    const anchor = absoluteToScreen(
      edgeAnchor({ x: node.x, y: node.y }, 'out', nodeSizeOf(node)),
      this.transform,
    );
    const curve = draftCurve(anchor, current);
    if (this.draftElement === null) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', classOf('draftCurve'));
      svg.dataset.layer = 'draft';
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      svg.append(path);
      this.host.append(svg);
      this.draftElement = svg;
      this.draftPath = path;
    }
    this.draftPath?.setAttribute('d', curve.d);
  }

  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.mounted || this.interactionLocked) return;
    this.finishInitialFit();
    // CR-20261119-05：内容滚动容器内滚轮交原生滚动，不缩放画布（到顶到底也不链给画布）。
    if (isInsideNodeContent(event.target)) return;
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * WHEEL_ZOOM_RATE);
    this.applyTransform(zoomAt(this.transform, this.localPoint(event), factor));
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.mounted || this.interactionLocked) return;
    this.finishInitialFit();
    // CR-20261119-05：内容滚动区聚焦时方向键/翻页键交原生滚动，不透传画布平移。
    if (isInsideNodeContent(event.target)) {
      const key = event.key;
      if (
        key.startsWith('Arrow') ||
        key === 'PageUp' ||
        key === 'PageDown' ||
        key === 'Home' ||
        key === 'End'
      ) {
        return;
      }
    }
    if (event.key === ' ' || event.code === 'Space') {
      event.preventDefault();
      this.spaceDown = true;
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelGesture();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      if (isTextEditingTarget(event.target)) return;
      event.preventDefault();
      this.selectAll();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (event.ctrlKey && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.redo();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      const hasSelectedNodes = this.interaction.selection.nodes.size > 0;
      const commands = createDeleteSelectionCommands(
        this.getDocument(),
        [...this.interaction.selection.nodes],
        [...this.interaction.selection.edges],
      );
      if (commands.length === 0) return;
      event.preventDefault();
      if (!this.executeCommands(commands)) {
        this.emitNotice({
          code: 'E_COMMAND',
          message: this.isReadOnly()
            ? hasSelectedNodes ? '画布只读，无法删除节点' : '画布只读，无法删除连线'
            : hasSelectedNodes ? '节点删除失败，未应用更改' : '连线删除失败，未应用更改',
          persistent: false,
        });
      }
      return;
    }

    const pan = event.shiftKey ? KEY_PAN_FAST_PX : KEY_PAN_PX;
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        this.applyTransform(panBy(this.transform, { x: -pan, y: 0 }));
        break;
      case 'ArrowRight':
        event.preventDefault();
        this.applyTransform(panBy(this.transform, { x: pan, y: 0 }));
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.applyTransform(panBy(this.transform, { x: 0, y: -pan }));
        break;
      case 'ArrowDown':
        event.preventDefault();
        this.applyTransform(panBy(this.transform, { x: 0, y: pan }));
        break;
      case '+':
      case '=':
        event.preventDefault();
        this.applyTransform(this.zoomAtCenter(KEY_ZOOM_FACTOR));
        break;
      case '-':
      case '_':
        event.preventDefault();
        this.applyTransform(this.zoomAtCenter(1 / KEY_ZOOM_FACTOR));
        break;
      case '0':
        event.preventDefault();
        this.resetPrecisionView();
        break;
      default:
        break;
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (event.key === ' ' || event.code === 'Space') this.spaceDown = false;
  };

  private readonly onBlur = (): void => {
    this.spaceDown = false;
    // B3：窗口失焦时取消活动手势，避免 pointerup 丢失后残留拖拽/框选。
    this.cancelGesture();
  };

  // C0-D：右键菜单与双击文本编辑事件通道。
  private readonly onContextMenu = (event: MouseEvent): void => {
    if (
      !this.mounted ||
      this.interactionLocked ||
      this.interaction.gesture !== null ||
      this.activePointerId !== null
    ) {
      return;
    }
    event.preventDefault();
    const rect = this.host.getBoundingClientRect();
    const screenPoint = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const target = this.hitTarget(screenPoint);
    this.emitEngineEvent({ kind: 'contextMenu', screenPoint, target });
  };

  private readonly onDoubleClick = (event: MouseEvent): void => {
    if (!this.mounted || this.interactionLocked || this.isReadOnly()) return;
    const rect = this.host.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const node = hitTestNodes(this.nodeViews, this.transform, point);
    if (node === null) return;
    this.emitEngineEvent({ kind: 'doubleClickNode', nodeId: node.id });
  };

  private emitEngineEvent(event: CanvasEngineEvent): void {
    for (const listener of this.engineEventListeners) listener(event);
  }

  subscribeEngineEvents(listener: (event: CanvasEngineEvent) => void): () => void {
    this.engineEventListeners.add(listener);
    return () => {
      this.engineEventListeners.delete(listener);
    };
  }

  /** C0-D：公共命令入口，React 层（右键菜单/新建节点/删除等）通过此触发。 */
  executeCommands(commands: readonly CanvasCommand[]): boolean {
    const ok = this.controller?.execute(commands) ?? false;
    if (ok) this.afterDocumentMutation();
    return ok;
  }

  /** S3：⌘/Ctrl+A 统一入口（host 键盘与 document 级兜底共用）；只改选中集，不写文档。 */
  selectAll(): void {
    if (!this.mounted || this.interactionLocked) return;
    this.interaction = setInteractionSelection(
      this.interaction,
      createCanvasSelectAllSelection(this.getDocument()),
    );
    this.applySelection(this.interaction);
    this.scheduleFrame();
  }

  /** S4：看板定位——按节点 id 选中，不改文档、不入历史。 */
  selectNode(id: string): boolean {
    if (!this.mounted || this.interactionLocked) return false;
    if (!this.nodeViews.some((node) => node.id === id)) return false;
    this.interaction = setInteractionSelection(this.interaction, {
      nodes: new Set([id]),
      edges: new Set(),
    });
    this.applySelection(this.interaction);
    this.scheduleFrame();
    return true;
  }

  /** S4：看板定位——把节点中心平移到视口中心，保持当前缩放与 origin。 */
  centerOn(id: string): boolean {
    if (!this.mounted) return false;
    const node = this.nodeViews.find((entry) => entry.id === id);
    if (node === undefined) return false;
    const size = nodeSizeOf(node);
    const centerX = node.x + size.w / 2;
    const centerY = node.y + size.h / 2;
    const { scale, originX, originY } = this.transform;
    this.finishInitialFit();
    this.applyTransform({
      ...this.transform,
      tx: this.size.width / 2 - (centerX + originX) * scale,
      ty: this.size.height / 2 - (centerY + originY) * scale,
    });
    return true;
  }

  /** C0-D：从视口屏幕坐标换算世界坐标（供右键菜单新建节点使用）。 */
  screenToWorld(screenPoint: Point): Point {
    const scale = this.transform.scale;
    const originX = this.transform.originX;
    const originY = this.transform.originY;
    const { tx, ty } = this.transform;
    return {
      x: (screenPoint.x - tx) / scale - originX,
      y: (screenPoint.y - ty) / scale - originY,
    };
  }

  /** C0-D：暴露当前文档（只读）供 CanvasView 查询节点信息。 */
  getDocument(): CanvasDocument {
    const doc = this.controller?.getDocument();
    if (doc !== undefined) return doc;
    return { schemaVersion: 2, nodes: [], edges: [] };
  }

  /** C0-D：暴露当前视口变换（只读）供 CanvasView 定位编辑层。 */
  getTransform(): ViewportTransform {
    return this.transform;
  }

  /** C0-D：暴露当前 nodeViews 供 hitTest 参考（只读）。 */
  getNodeViews(): readonly CanvasNodeView[] {
    return this.nodeViews;
  }

  /** CR-20261121-56：外部数据（链接索引等）到达后强制重算视图并重绘卡片。 */
  refreshViews(): void {
    this.syncViewsFromDocument();
  }

  /** CR-20261122-63：编辑浮层覆盖节点时抑制底层装饰，不写文档/历史。 */
  setEditingNode(id: string | null): void {
    this.nodes.setEditingNode(id);
  }

  /** CR-20261122-62：AI 执行状态直接写节点 dataset，不触发文档/历史。 */
  setAiRunning(id: string | null): void {
    this.nodes.setAiRunning(id);
  }

  setAiFlash(flash: { readonly id: string; readonly kind: 'ok' | 'error' } | null): void {
    this.nodes.setAiFlash(flash);
  }

  /** CR-20261122-62：AI 写入文档后使旧卡片快照失效。 */
  invalidateDocPreview(path: string): void {
    this.docPreview?.invalidate(path);
  }

  /** @internal CR-20261119-13：命令总线可调用。 */
  zoomAtCenter(factor: number): ViewportTransform {
    this.finishInitialFit();
    return zoomAt(
      this.transform,
      { x: this.size.width / 2, y: this.size.height / 2 },
      factor,
    );
  }

  /** 状态栏双击：适配并居中全部节点；只缩小，不改文档与历史。 */
  fitAllNodes(): void {
    this.finishInitialFit();
    this.applyTransform(fitRectsToViewport(nodeWorldRects(this.nodeViews), this.size, this.transform));
  }

  private finishInitialFit(): void {
    this.initialFit = null;
  }

  /** 测量之后、连线之前适配；等待外部数据时不空转，数据到达会自行调度下一帧。 */
  private applyInitialFit(): void {
    const fit = this.initialFit;
    if (fit === null) return;
    /* 启动首帧窗口未完成布局时 rect 为 0（resize 兜底 1×1）：适配会写成内容全在视口外的
     * 退化变换，后续 resize 不重算 → 画布空白直到重挂载。退化视口跳过，等真实尺寸。 */
    if (this.size.width <= 1 || this.size.height <= 1) return;
    if (this.nodeViews.length === 0) {
      this.initialFit = null;
      return;
    }
    const next = fitRectsToViewport(nodeWorldRects(this.nodeViews), this.size, this.transform);
    const changed =
      next.tx !== this.transform.tx ||
      next.ty !== this.transform.ty ||
      next.scale !== this.transform.scale ||
      next.originX !== this.transform.originX ||
      next.originY !== this.transform.originY;
    if (changed) {
      fit.stableFrames = 0;
      this.applyTransform(next);
      return;
    }
    const pending =
      fit.fontsPending ||
      this.pendingMeasureIds.size > 0 ||
      (this.docPreview?.pendingRequests ?? 0) > 0;
    if (pending) {
      fit.stableFrames = 0;
      return;
    }
    fit.stableFrames += 1;
    if (fit.stableFrames >= 2) {
      this.initialFit = null;
      return;
    }
    this.scheduleFrame();
  }

  private applyTransform(next: ViewportTransform): void {
    const previous = this.transform;
    const originChanged = next.originX !== previous.originX || next.originY !== previous.originY;
    if (
      next.tx !== previous.tx ||
      next.ty !== previous.ty ||
      next.scale !== previous.scale ||
      originChanged
    ) {
      this.gridInvalidation.invalidate();
    }
    this.transform = next;
    this.frameState.measureWorld(() => {
      this.world.apply(next);
    });
    if (originChanged || next.scale !== previous.scale) {
      // CR-20261123：缩放变化必须重跑 setNodes——LOD 滞回（0.37/0.43）与外标题字号补偿
      // 都只在 setNodes 内按当前 scale 计算；否则从低缩放回到正常比例后，文档节点会
      // 卡在「仅标题条」形态（高度塌陷成细线，resize 热区几乎不可点）。
      for (const node of this.nodeViews) this.dirtyNodeIds.add(node.id);
      if (next.scale !== previous.scale) {
        // LOD 切换会显隐正文，autoH 需按新形态重测；否则会被低缩放时的塌陷高度长期污染。
        const autoIds = this.nodeViews
          .filter((node) => node.h === undefined && node.docPath !== undefined)
          .map((node) => node.id);
        if (autoIds.length > 0) this.scheduleMeasure(autoIds);
      }
    } else if (this.docPreview !== null) {
      // CR-20261119-05：内容滚动 DOM 的视口裁剪依赖 transform，平移/缩放时重挂或卸载。
      for (const node of this.nodeViews) {
        if (node.docPath !== undefined && isNodeContentMode(node)) {
          this.dirtyNodeIds.add(node.id);
        }
      }
    }
    if (Math.max(Math.abs(next.tx), Math.abs(next.ty)) > REBASE_THRESHOLD) {
      this.emitNotice({
        code: 'E_PRECISION',
        message: '相机坐标超出安全范围；可重置视图',
        persistent: true,
      });
    }
    this.scheduleFrame();
  }

  private afterDocumentMutation(): void {
    const controller = this.controller;
    if (controller === null) return;
    this.syncViewsFromDocument();
    const nodes = extractNodes(controller.getDocument());
    const maxAbs = nodes.reduce(
      (maximum, node) => Math.max(maximum, Math.abs(node.x), Math.abs(node.y)),
      0,
    );
    if (maxAbs <= REBASE_THRESHOLD) return;
    const origin = readOrigin(controller.getDocument());
    const offset = rebaseOffset(this.transform);
    if (
      Math.max(Math.abs(origin.x), Math.abs(origin.y)) > ORIGIN_PRECISION_LIMIT ||
      (offset.x === 0 && offset.y === 0)
    ) {
      this.emitNotice({
        code: 'E_PRECISION',
        message: '节点坐标超出安全范围，未自动 rebase；可重置视图',
        persistent: true,
      });
      return;
    }

    // 同一 offset 原子平移文档、lastOrigin、past/future、transform 与渲染缓存。
    controller.rebase(offset);
    this.applyTransform(rebase(this.transform, offset));
    this.emitNotice({
      code: 'E_REBASED',
      message: '坐标已归一',
      persistent: false,
    });
  }

  /** 用 inspection 投影重建视图；坏条目只从渲染隔离，原文不动。 */
  private syncViewsFromDocument(): void {    const controller = this.controller;
    if (controller === null) return;
    const document = controller.getDocument();
    const schema = inspectCanvasDocument(document);
    this.issues = schema.issues;
    this.nodeViews = extractNodeViews(schema.projection.nodes);
    this.edgeViews = extractEdgeViews(schema.projection.edges, this.nodeViews);
    // CR-20261119-12：合并 autoH + prune Map + 兜底补测
    this.autoHeightPruneAndSchedule();
    // S1：删除/撤销/重做/外部变更后同步选中集，避免残留死 id 令后续删除整批被拒。
    this.interaction = pruneInteraction(this.interaction, document);
    this.applySelection(this.interaction);
    this.dirtyNodeIds.clear();
    for (const node of this.nodeViews) this.dirtyNodeIds.add(node.id);
    // CR-20261119-09：视图已重建，即便 dirtyNodeIds 为空也必须触发 setNodes([]) 清 node-layer。
    this.nodeLayerDirty = true;
    this.scheduleFrame();
  }

  /** CR-20261119-12：autoH 合并 + prune + 兜底补测。syncViewsFromDocument / applyExternalDocument / doMount 共用。 */
  private autoHeightPruneAndSchedule(): void {
    // 0. 显式 h 接管：手动 resize / user 设显式 h → Map 清除该 id
    for (const v of this.nodeViews) {
      if (v.h !== undefined) this.autoHeights.delete(v.id);
    }
    // 1. 不可变合并（mergeAutoHeights 内部已处理：显式 h 原样返回、document h 缺省合 autoH）
    this.nodeViews = mergeAutoHeights(this.nodeViews, this.autoHeights);
    // 2. prune：Map 中存在但 nodeViews 已无的 id（节点已删）
    const viewIds = new Set(this.nodeViews.map((v) => v.id));
    for (const id of this.autoHeights.keys()) {
      if (!viewIds.has(id)) this.autoHeights.delete(id);
    }
    // 3. 兜底补测：h 缺省且 Map 尚无值的 document 节点
    const needMeasure = this.nodeViews
      .filter(
        (v) => v.h === undefined && v.docPath !== undefined && !this.autoHeights.has(v.id),
      )
      .map((v) => v.id);
    if (needMeasure.length > 0) this.scheduleMeasure(needMeasure);
  }

  /** CR-20261119-12：把 ids 加入待测量集合，强制调度一帧。
   *  无论调用方有没有 dirty——字体加载/仅元数据到达这些路径自身不触发帧。 */
  private scheduleMeasure(ids: readonly string[]): void {
    for (const id of ids) this.pendingMeasureIds.add(id);
    this.scheduleFrame();
  }

  /** CR-20261119-12：node-layer 测量回调——容差 + 不可变合进 nodeViews + 挂本帧 edge 队列。 */
  private onAutoHeightMeasured(id: string, h: number): void {
    const prev = this.autoHeights.get(id);
    if (prev !== undefined && Math.abs(prev - h) <= 1) return;
    this.autoHeights.set(id, h);
    // 不可变替换（与 engine.ts 既有 .map 风格一致）
    this.nodeViews = this.nodeViews.map((v) => (v.id === id ? { ...v, autoH: h } : v));
    this.pendingAutoEdgeIds.add(id);
  }

  private emitNotice(notice: CanvasNotice): void {
    if (notice.persistent) this.status = notice;
    dispatchCanvasNotice(notice, this.onceNotices, this.noticeListeners);
  }

  private scheduleFrame(): void {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.draw();
    });
  }

  /** CR-20261119-05：文档预览数据到达后重绘文档节点。CR-20261119-12 加可选 id——指定 id 只 dirty 该节点，不传则全量 dirty。 */
  private markDocumentNodesDirty(id?: string): void {
    if (!this.mounted) return;
    if (id !== undefined) {
      this.dirtyNodeIds.add(id);
    } else {
      for (const node of this.nodeViews) {
        if (node.docPath !== undefined) this.dirtyNodeIds.add(node.id);
      }
    }
    if (this.initialFit !== null) {
      const autoIds = this.nodeViews
        .filter((node) => node.h === undefined && node.docPath !== undefined)
        .map((node) => node.id);
      if (autoIds.length > 0) this.scheduleMeasure(autoIds);
    }
    this.scheduleFrame();
  }

  /** CR-20261119-05：文档内容被编辑（live text 变化）后由 React 层触发重绘。 */
  refreshDocPreviews(): void {
    this.markDocumentNodesDirty();
  }

  /** CR-20261119-05：懒加载入口——卡片只读元数据，内容模式且可见才读正文。 */
  private syncDocPreviews(): void {
    const preview = this.docPreview;
    if (preview === null) return;
    for (const node of this.nodeViews) {
      const path = node.docPath;
      if (path === undefined) continue;
      if (!this.isDocNodeVisible(node)) continue;
      void preview.requestMeta(path);
      if (isNodeContentMode(node)) {
        void preview.requestText(path);
      }
    }
  }

  private isDocNodeVisible(node: CanvasNodeView): boolean {
    const rect = nodeScreenRect(node, this.transform);
    return (
      rect.right >= 0 &&
      rect.left <= this.size.width &&
      rect.bottom >= 0 &&
      rect.top <= this.size.height
    );
  }

  private updateScreenEdges(movedNodeIds: ReadonlySet<string>): boolean {
    const update = this.screenEdgeCache.update(
      this.edgeViews,
      this.nodeViews,
      this.transform,
      this.size,
      movedNodeIds,
    );
    this.screenEdges = update.edges;
    return update.degenerated;
  }

  private draw(): void {
    const drawStarted = performance.now();
    this.syncDocPreviews();
    let gridMs = 0;
    const gridDrawn = this.gridInvalidation.consume();
    if (gridDrawn) {
      const gridStart = performance.now();
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      drawGrid(this.ctx, this.transform, this.size, this.dpr, this.gridPalette());
      gridMs = performance.now() - gridStart;
    }

    this.syncPortHighlight();
    const movedNodeIds = new Set(this.dirtyNodeIds);
    // CR-20261119-09：nodeLayerDirty 让非空→空 场景也触发 setNodes([])，清 node-layer ghost。
    if (shouldSyncNodeLayer(this.nodeLayerDirty, movedNodeIds.size)) {
      this.frameState.measureNodes(() => {
        this.nodes.setNodes(this.nodeViews, this.transform, this.size);
      });
      // 只有 setNodes 成功后才复位；抛错时保留 dirty，让下一帧重试。
      this.nodeLayerDirty = false;
    }

    // CR-20261119-12：测量相位——独立于 shouldSyncNodeLayer，pending 非空就必跑。
    // 字体加载 / 仅元数据到达 这些路径没有 dirty，这里也能消费 pendingMeasureIds。
    if (this.pendingMeasureIds.size > 0) {
      const toMeasure = this.pendingMeasureIds;
      this.frameState.measureNodes(() => {
        this.nodes.measure(toMeasure);
      });
      this.pendingMeasureIds.clear();
    }

    // CR-20261119-12：autoH 变化的 id 并入本帧 movedNodeIds——不拖到下一帧。
    if (this.pendingAutoEdgeIds.size > 0) {
      for (const id of this.pendingAutoEdgeIds) movedNodeIds.add(id);
      this.pendingAutoEdgeIds.clear();
    }

    // CR-20261122-63：autoH 已合入 nodeViews，先适配再用新 transform 计算连线。
    this.applyInitialFit();

    const edgeStart = performance.now();
    const degenerated = this.updateScreenEdges(movedNodeIds);
    const plan = planEdgeDraw(this.screenEdges, this.size);
    this.edges.draw(plan); this.pulse.setEdges(plan.edges);
    this.edgeWarning = plan.warning;
    const selectedIds = this.interaction.selection.edges;
    this.highlight.drawHighlight(this.screenEdges.filter((edge) => selectedIds.has(edge.id)));
    const edgeMs = performance.now() - edgeStart;

    this.dirtyNodeIds.clear();
    this.frameState.completeFrame(gridMs, edgeMs, gridDrawn, degenerated);
    const drawMs = performance.now() - drawStarted;
    if (this.dragFramePending) {
      this.dragJsSamples.push(this.dragInputMs + drawMs);
      this.dragInputMs = 0;
      this.dragFramePending = false;
    }
  }

  private resize(): void {
    // B3：每次 resize 重读 dpr（显示器切换/缩放变化）；显式注入只用于验收。
    this.dpr = readCanvasDpr(this.dprOverride);
    const rect = this.host.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const wasDegenerate = this.size.width <= 1 || this.size.height <= 1;
    if (width !== this.size.width || height !== this.size.height) {
      this.gridInvalidation.invalidate();
    }
    this.size = { width, height };
    /* 从退化尺寸恢复（启动首帧/窗口重现）：初始适配若已结束则重排，避免停在旧变换上。 */
    if (
      wasDegenerate && width > 1 && height > 1 &&
      this.initialFit === null && this.nodeViews.length > 0
    ) {
      this.initialFit = { stableFrames: 0, fontsPending: false }; this.scheduleFrame();
    }

    const dpr = Math.max(1, this.dpr);
    const deviceWidth = Math.max(1, Math.round(width * dpr));
    const deviceHeight = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== deviceWidth) this.canvas.width = deviceWidth;
    if (this.canvas.height !== deviceHeight) this.canvas.height = deviceHeight;
    this.edges.resize(this.size, dpr); this.pulse.resize(this.size, dpr);
    this.highlight.resize(this.size, dpr);
  }
}
