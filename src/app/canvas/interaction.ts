/**
 * C4 纯交互状态机：不碰 DOM、文档或 store。引擎只负责命中与执行 effects。
 * 拖拽预览只返回位置补丁；pointerup 至多产生一条 move 命令，Esc 只还原预览。
 */
import { MEDIA_CONTROL_STRIP_PX, MIN_NODE_HEIGHT, MIN_NODE_WIDTH } from './consts.ts';
import { nodeSizeOf, type CanvasNodeView } from './node-layout.ts';
import { computeResizeResult, type ResizeDir } from './resize-math.ts';
import type { Point, Rect } from './viewport.ts';

/**
 * CR-20261121-46：pointerdown 是否落在媒体播放控件区（落区内 → engine 早退，
 * 不建手势/不捕获/preventDefault，原生控件接管；区外画面放行给画布拖拽）。
 *
 * 入参是 engine 提取好的原始值（本层不碰 DOM）：
 * - `kind`：player 元素 `data-media-player` 属性值（'audio'/'video'），null=非媒体元素；
 * - `rectBottom`：player 元素 getBoundingClientRect().bottom，null=拿不到 rect；
 * - `clientY`：pointerdown 的 clientY。
 *
 * 音频元素整体就是控件面板，整块让给原生；视频只有底部控件条是控件
 * （WebKit 内联控件叠加视频底部，高度 MEDIA_CONTROL_STRIP_PX），画面本体可拖。
 */
export interface MediaChromeRect {
  readonly top: number;
  readonly bottom: number;
}

export function isMediaChromePress(
  kind: string | null,
  rect: MediaChromeRect | null,
  clientY: number,
): boolean {
  // CR-20261121-56：音频=自定义控件条（圆钮+进度条+时间整行），rect 纵向范围内即控件交互；
  // 条外卡体照常拖拽/框选（原生 controls 时代的「整块让位」已废弃）。
  if (kind === 'audio') {
    if (rect === null) return false;
    return clientY >= rect.top && clientY <= rect.bottom;
  }
  // 视频=原生控件：底部 44px 传输条让位（CR-46）；CR-20261121-57 补顶部 44px——
  // WKWebView 的全屏/画中画按钮在视频顶部，旧口径下按压被画布手势吞掉导致按钮失效。
  // 中部画面本体仍放行拖拽/单击播放。
  if (kind !== 'video' || rect === null) return false;
  return (
    clientY >= rect.bottom - MEDIA_CONTROL_STRIP_PX ||
    clientY <= rect.top + MEDIA_CONTROL_STRIP_PX
  );
}

export const MARQUEE_THRESHOLD_PX = 4;

export interface CanvasSelection {
  readonly nodes: ReadonlySet<string>;
  readonly edges: ReadonlySet<string>;
}

/**
 * C6 delta 编码：move 命令存相对位移 dx/dy（= to - from），不存 from/to 绝对坐标。
 * undo 应用 -dx/-dy，redo 应用 +dx/+dy。内存比 from/to 省约 50%（数值载荷）。
 */
export interface CanvasMoveEntry {
  readonly id: string;
  readonly dx: number;
  readonly dy: number;
}

export interface CanvasMoveCommand {
  readonly kind: 'move';
  readonly entries: readonly CanvasMoveEntry[];
}

export interface CanvasPortHit {
  readonly nodeId: string;
  readonly portId: string;
  readonly dir: 'in' | 'out';
}

export type CanvasHitTarget =
  | { readonly kind: 'node'; readonly id: string }
  | { readonly kind: 'edge'; readonly id: string }
  | { readonly kind: 'port'; readonly port: CanvasPortHit }
  | { readonly kind: 'resize'; readonly id: string; readonly direction: ResizeDir }
  | { readonly kind: 'blank' };

interface NodeGesture {
  readonly kind: 'node';
  readonly start: Point;
  readonly origins: readonly CanvasNodeView[];
  readonly before: CanvasSelection;
  readonly offset: Point;
  /** ⌥复制：拖动结束生成副本而非移动。 */
  readonly duplicate: boolean;
}

interface MarqueeGesture {
  readonly kind: 'marquee';
  readonly start: Point;
  readonly current: Point;
  readonly active: boolean;
  readonly additive: boolean;
  readonly before: CanvasSelection;
}

interface PanGesture {
  readonly kind: 'pan';
  readonly last: Point;
}

interface ConnectionGesture {
  readonly kind: 'connection';
  readonly from: CanvasPortHit;
  readonly current: Point;
}

/** CR-20261119-11：8 方向缩放；origin 记录按下时的世界盒，预览只改视图。 */
interface ResizeGesture {
  readonly kind: 'resize';
  readonly id: string;
  readonly origin: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly start: Point;
  readonly direction: ResizeDir;
}

export type CanvasGesture =
  | NodeGesture
  | MarqueeGesture
  | PanGesture
  | ConnectionGesture
  | ResizeGesture;

export interface InteractionState {
  readonly selection: CanvasSelection;
  readonly gesture: CanvasGesture | null;
}

export type InteractionEvent =
  | {
      readonly type: 'pointerDown';
      readonly point: Point;
      readonly button: number;
      readonly shiftKey: boolean;
      readonly toggleKey: boolean;
      /** ⌥复制修饰键。 */
      readonly altKey: boolean;
      readonly pan: boolean;
      readonly target: CanvasHitTarget;
      readonly nodes: readonly CanvasNodeView[];
      /** B2：冲突只读态不得开始节点拖拽预览，避免 commit=false 后视图漂移。 */
      readonly readOnly?: boolean;
    }
  | {
      readonly type: 'pointerMove';
      readonly point: Point;
      readonly scale: number;
      readonly target?: CanvasHitTarget;
    }
  | {
      readonly type: 'pointerUp';
      readonly point: Point;
      readonly scale: number;
      readonly target?: CanvasHitTarget;
      readonly marqueeNodeIds?: readonly string[];
      /** 引擎以 pointerup 客户区落点判定编辑器浮窗；状态机只处理纯数据。 */
      readonly editorDrop?: { readonly windowId: string; readonly clientPoint: Point };
    }
  | { readonly type: 'cancel' };

export type InteractionEffect =
  | { readonly type: 'selection'; readonly selection: CanvasSelection }
  | { readonly type: 'preview'; readonly positions: readonly CanvasNodeView[] }
  | { readonly type: 'commit'; readonly command: CanvasMoveCommand }
  | { readonly type: 'pan'; readonly delta: Point }
  | { readonly type: 'marquee'; readonly rect: Rect | null }
  | {
      readonly type: 'connectionDraft';
      readonly from: CanvasPortHit;
      readonly current: Point;
    }
  | {
      readonly type: 'duplicate';
      readonly entries: readonly { readonly id: string; readonly x: number; readonly y: number }[];
    }
  | { readonly type: 'resizePreview'; readonly id: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly dir: ResizeDir }
  | { readonly type: 'resizeCommit'; readonly id: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly dir: ResizeDir }
  | {
      readonly type: 'mediaDropToEditor';
      readonly windowId: string;
      readonly clientPoint: Point;
      readonly kind: 'image' | 'audio' | 'video';
      readonly path: string;
      readonly label: string;
    }
  | {
      readonly type: 'connectionCommit';
      readonly fromNodeId: string;
      readonly fromPortId: string;
      readonly toNodeId: string;
      readonly toPortId: string;
    }
  | {
      readonly type: 'connectionDropEmpty';
      readonly from: { readonly nodeId: string; readonly portId: string };
      readonly point: Point;
    }
  | { readonly type: 'connectionCancel' };

export interface InteractionResult {
  readonly state: InteractionState;
  readonly effects: readonly InteractionEffect[];
}

function emptySelection(): CanvasSelection {
  return { nodes: new Set(), edges: new Set() };
}

function copySelection(selection: CanvasSelection): CanvasSelection {
  return { nodes: new Set(selection.nodes), edges: new Set(selection.edges) };
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

function sameSelection(a: CanvasSelection, b: CanvasSelection): boolean {
  return sameSet(a.nodes, b.nodes) && sameSet(a.edges, b.edges);
}

function withSelection(state: InteractionState, selection: CanvasSelection): InteractionState {
  return sameSelection(state.selection, selection) ? state : { ...state, selection };
}

function selectionEffect(before: CanvasSelection, after: CanvasSelection): readonly InteractionEffect[] {
  return sameSelection(before, after) ? [] : [{ type: 'selection', selection: after }];
}

function marqueeRect(start: Point, current: Point): Rect {
  return {
    left: Math.min(start.x, current.x),
    top: Math.min(start.y, current.y),
    right: Math.max(start.x, current.x),
    bottom: Math.max(start.y, current.y),
  };
}

function previewPositions(gesture: NodeGesture, point: Point, scale: number): readonly CanvasNodeView[] {
  const offset = {
    x: (point.x - gesture.start.x) / scale,
    y: (point.y - gesture.start.y) / scale,
  };
  return gesture.origins.map((node) => ({
    ...node,
    x: node.x + offset.x,
    y: node.y + offset.y,
  }));
}

/** CR-20261119-11：8 方向缩放预览，返回完整 {x,y,w,h} 供 engine 预览与 commit 同用。 */
function resizedRect(
  gesture: ResizeGesture,
  point: Point,
  scale: number,
): { readonly x: number; readonly y: number; readonly w: number; readonly h: number } {
  const delta = {
    dx: (point.x - gesture.start.x) / scale,
    dy: (point.y - gesture.start.y) / scale,
  };
  return computeResizeResult(
    gesture.origin,
    delta,
    gesture.direction,
    MIN_NODE_WIDTH,
    MIN_NODE_HEIGHT,
  );
}

function pointerDown(state: InteractionState, event: Extract<InteractionEvent, { type: 'pointerDown' }>): InteractionResult {
  if (event.button === 1 || (event.button === 0 && event.pan)) {
    return {
      state: { ...state, gesture: { kind: 'pan', last: event.point } },
      effects: [],
    };
  }
  if (event.button !== 0) return { state, effects: [] };

  // CR-20261119-11：8 方向缩放；只读态不建手势（engine 也已拦截）。
  if (event.target.kind === 'resize') {
    if (event.readOnly === true) return { state, effects: [] };
    const targetId = event.target.id;
    const node = event.nodes.find((item) => item.id === targetId);
    if (node === undefined) return { state, effects: [] };
    const size = nodeSizeOf(node);
    return {
      state: {
        ...state,
        gesture: {
          kind: 'resize',
          id: node.id,
          origin: { x: node.x, y: node.y, w: size.w, h: size.h },
          start: event.point,
          direction: event.target.direction,
        },
      },
      effects: [],
    };
  }

  // C0-D：左键点击 out 端口开始连线草稿。B2 readOnly 态禁止。
  if (event.target.kind === 'port' && event.target.port.dir === 'out') {
    if (event.readOnly === true) {
      return { state, effects: [] };
    }
    const from = event.target.port;
    return {
      state: { ...state, gesture: { kind: 'connection', from, current: event.point } },
      effects: [{ type: 'connectionDraft', from, current: event.point }],
    };
  }
  if (event.target.kind === 'port' && event.target.port.dir === 'in') {
    // 单独点 in 端口不开始连线，也不改变当前选中与手势（out→in 规则）。
    return { state, effects: [] };
  }

  const previous = state.selection;
  if (event.target.kind === 'edge') {
    const edges = new Set(event.toggleKey || event.shiftKey ? previous.edges : []);
    const nodes = event.toggleKey || event.shiftKey ? new Set(previous.nodes) : new Set<string>();
    if (event.toggleKey) {
      if (edges.has(event.target.id)) edges.delete(event.target.id);
      else edges.add(event.target.id);
    } else {
      edges.add(event.target.id);
    }
    const selection = { nodes, edges };
    return { state: { ...withSelection(state, selection), gesture: null }, effects: selectionEffect(previous, selection) };
  }

  if (event.target.kind === 'node') {
    const nodes = new Set(
      event.toggleKey || event.shiftKey
        ? previous.nodes
        : previous.nodes.has(event.target.id)
          ? previous.nodes
          : [],
    );
    const edges = event.toggleKey || event.shiftKey ? new Set(previous.edges) : new Set<string>();
    if (event.toggleKey) {
      if (nodes.has(event.target.id)) nodes.delete(event.target.id);
      else nodes.add(event.target.id);
    } else {
      nodes.add(event.target.id);
    }
    const selection = { nodes, edges };
    const selected = withSelection(state, selection);
    if (event.toggleKey || event.readOnly === true) {
      return { state: { ...selected, gesture: null }, effects: selectionEffect(previous, selection) };
    }
    const origins = event.nodes.filter((node) => nodes.has(node.id));
    return {
      state: {
        selection: selected.selection,
        gesture: {
          kind: 'node',
          start: event.point,
          origins,
          before: previous,
          offset: { x: 0, y: 0 },
          duplicate: event.altKey,
        },
      },
      effects: selectionEffect(previous, selection),
    };
  }

  const selection = event.shiftKey ? copySelection(previous) : emptySelection();
  return {
    state: {
      selection,
      gesture: {
        kind: 'marquee',
        start: event.point,
        current: event.point,
        active: false,
        additive: event.shiftKey,
        before: previous,
      },
    },
    effects: selectionEffect(previous, selection),
  };
}

function pointerMove(state: InteractionState, event: Extract<InteractionEvent, { type: 'pointerMove' }>): InteractionResult {
  const gesture = state.gesture;
  if (gesture === null) return { state, effects: [] };
  if (gesture.kind === 'resize') {
    const rect = resizedRect(gesture, event.point, event.scale);
    return {
      state,
      effects: [{ type: 'resizePreview', id: gesture.id, x: rect.x, y: rect.y, w: rect.w, h: rect.h, dir: gesture.direction }],
    };
  }
  if (gesture.kind === 'connection') {
    return {
      state: { ...state, gesture: { ...gesture, current: event.point } },
      effects: [{ type: 'connectionDraft', from: gesture.from, current: event.point }],
    };
  }

  if (gesture.kind === 'pan') {
    const delta = { x: event.point.x - gesture.last.x, y: event.point.y - gesture.last.y };
    return {
      state: { ...state, gesture: { ...gesture, last: event.point } },
      effects: delta.x === 0 && delta.y === 0 ? [] : [{ type: 'pan', delta }],
    };
  }
  if (gesture.kind === 'marquee') {
    const active =
      gesture.active ||
      Math.hypot(event.point.x - gesture.start.x, event.point.y - gesture.start.y) >= MARQUEE_THRESHOLD_PX;
    const next = { ...gesture, current: event.point, active };
    return {
      state: { ...state, gesture: next },
      effects: active ? [{ type: 'marquee', rect: marqueeRect(next.start, next.current) }] : [],
    };
  }

  const positions = previewPositions(gesture, event.point, event.scale);
  const offset = {
    x: (event.point.x - gesture.start.x) / event.scale,
    y: (event.point.y - gesture.start.y) / event.scale,
  };
  return {
    state: { ...state, gesture: { ...gesture, offset } },
    effects: [{ type: 'preview', positions }],
  };
}

function pointerUp(state: InteractionState, event: Extract<InteractionEvent, { type: 'pointerUp' }>): InteractionResult {
  const gesture = state.gesture;
  if (gesture === null) return { state, effects: [] };

  // CR-20261119-11：8 方向缩放结束；无位移或 clamp 后与 origin 相同则只还原预览。
  if (gesture.kind === 'resize') {
    const rect = resizedRect(gesture, event.point, event.scale);
    const unchanged = rect.x === gesture.origin.x && rect.y === gesture.origin.y && rect.w === gesture.origin.w && rect.h === gesture.origin.h;
    return {
      state: { ...state, gesture: null },
      effects: unchanged
        ? [{ type: 'resizePreview', id: gesture.id, x: gesture.origin.x, y: gesture.origin.y, w: gesture.origin.w, h: gesture.origin.h, dir: gesture.direction }]
        : [{ type: 'resizeCommit', id: gesture.id, x: rect.x, y: rect.y, w: rect.w, h: rect.h, dir: gesture.direction }],
    };
  }

  // C0-D：合法目标端口/节点直接连线；仅空白落点弹「新建并连接」菜单。
  if (gesture.kind === 'connection') {
    const target = event.target;
    if (
      target?.kind === 'port' &&
      target.port.dir === 'in' &&
      target.port.nodeId !== gesture.from.nodeId
    ) {
      return {
        state: { ...state, gesture: null },
        effects: [
          {
            type: 'connectionCommit',
            fromNodeId: gesture.from.nodeId,
            fromPortId: gesture.from.portId,
            toNodeId: target.port.nodeId,
            toPortId: target.port.portId,
          },
        ],
      };
    }
    if (target?.kind === 'node' && target.id !== gesture.from.nodeId) {
      return {
        state: { ...state, gesture: null },
        effects: [
          {
            type: 'connectionCommit',
            fromNodeId: gesture.from.nodeId,
            fromPortId: gesture.from.portId,
            toNodeId: target.id,
            toPortId: 'in',
          },
        ],
      };
    }
    if (target !== undefined && target.kind !== 'blank') {
      return {
        state: { ...state, gesture: null },
        effects: [{ type: 'connectionCancel' }],
      };
    }
    return {
      state: { ...state, gesture: null },
      effects: [
        {
          type: 'connectionDropEmpty',
          from: { nodeId: gesture.from.nodeId, portId: gesture.from.portId },
          point: event.point,
        },
      ],
    };
  }

  if (gesture.kind === 'pan') return { state: { ...state, gesture: null }, effects: [] };
  if (gesture.kind === 'marquee') {
    const effects: InteractionEffect[] = [{ type: 'marquee', rect: null }];
    if (gesture.active) {
      const nodes = new Set(gesture.additive ? gesture.before.nodes : []);
      for (const id of event.marqueeNodeIds ?? []) nodes.add(id);
      const selection = { nodes, edges: new Set(gesture.additive ? gesture.before.edges : []) };
      effects.push(...selectionEffect(state.selection, selection));
      return { state: { selection, gesture: null }, effects };
    }
    return { state: { ...state, gesture: null }, effects };
  }

  if (event.editorDrop !== undefined && !gesture.duplicate && gesture.origins.length === 1) {
    const origin = gesture.origins[0];
    if (origin?.media !== undefined && origin.media.kind !== 'doc') {
      return {
        state: { ...state, gesture: null },
        effects: [
          { type: 'preview', positions: gesture.origins },
          {
            type: 'mediaDropToEditor',
            windowId: event.editorDrop.windowId,
            clientPoint: event.editorDrop.clientPoint,
            kind: origin.media.kind,
            path: origin.media.path,
            label: origin.label,
          },
        ],
      };
    }
  }

  const positions = previewPositions(gesture, event.point, event.scale);
  const entries = positions.flatMap((position) => {
    const origin = gesture.origins.find((node) => node.id === position.id);
    if (origin === undefined || (origin.x === position.x && origin.y === position.y)) return [];
    return [{ id: position.id, dx: position.x - origin.x, dy: position.y - origin.y }];
  });

  // ⌥复制：有位移才生成副本；原节点复位，副本落在拖动结束位置。
  if (gesture.duplicate) {
    if (entries.length === 0) {
      return { state: { ...state, gesture: null }, effects: [{ type: 'preview', positions: gesture.origins }] };
    }
    return {
      state: { ...state, gesture: null },
      effects: [
        { type: 'preview', positions: gesture.origins },
        {
          type: 'duplicate',
          entries: entries.map((entry) => ({
            id: entry.id,
            x: (gesture.origins.find((node) => node.id === entry.id)?.x ?? 0) + entry.dx,
            y: (gesture.origins.find((node) => node.id === entry.id)?.y ?? 0) + entry.dy,
          })),
        },
      ],
    };
  }

  return {
    state: { ...state, gesture: null },
    effects:
      entries.length === 0
        ? [{ type: 'preview', positions }]
        : [{ type: 'commit', command: { kind: 'move', entries } }],
  };
}

function cancel(state: InteractionState): InteractionResult {
  const gesture = state.gesture;
  if (gesture === null) return { state, effects: [] };
  if (gesture.kind === 'connection') {
    return { state: { ...state, gesture: null }, effects: [{ type: 'connectionCancel' }] };
  }
  if (gesture.kind === 'resize') {
    return {
      state: { ...state, gesture: null },
      effects: [{ type: 'resizePreview', id: gesture.id, x: gesture.origin.x, y: gesture.origin.y, w: gesture.origin.w, h: gesture.origin.h, dir: gesture.direction }],
    };
  }
  const effects: InteractionEffect[] = [];
  if (gesture.kind === 'node') {
    effects.push({ type: 'preview', positions: gesture.origins });
  } else if (gesture.kind === 'marquee') {
    effects.push({ type: 'marquee', rect: null });
  }
  if (gesture.kind !== 'pan') effects.push(...selectionEffect(state.selection, gesture.before));
  return {
    state: { selection: gesture.kind === 'pan' ? state.selection : gesture.before, gesture: null },
    effects,
  };
}

export function createInteractionState(): InteractionState {
  return { selection: emptySelection(), gesture: null };
}

/** 外部多选 API 只改选中集合，不伪造指针事件、不产生历史命令。 */
export function setInteractionSelection(state: InteractionState, selection: CanvasSelection): InteractionState {
  return withSelection(state, copySelection(selection));
}

export function reduceInteraction(state: InteractionState, event: InteractionEvent): InteractionResult {
  switch (event.type) {
    case 'pointerDown':
      return pointerDown(state, event);
    case 'pointerMove':
      return pointerMove(state, event);
    case 'pointerUp':
      return pointerUp(state, event);
    case 'cancel':
      return cancel(state);
  }
}
