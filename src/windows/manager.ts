/**
 * P5-C1：WindowManager 核心纯逻辑。
 *
 * 唯一状态源：窗口列表、z 序（数组末尾 = 最顶层）、几何、平铺/层叠算法、
 * 会话内位置记忆。纯 TS，不引 React / zustand / @tauri-apps（gate:layers），
 * 不做 I/O，不读 DOM——视口尺寸由调用方传入，故可脱离渲染层独立测试。
 *
 * 焦点（focusedId）与 z 序（records 顺序）正交解耦：`focus` 只改焦点、
 * `raiseToTop` 只改顺序、`activate` 两者皆改（指针点击的默认行为）。
 *
 * 快照缓存：`snapshot()` 在两次变更间返回同一冻结引用，供 useSyncExternalStore
 * 做引用比较，避免每次渲染都生成新对象导致的无限重渲染（React 要求 getSnapshot 缓存）。
 */
import { nextFocusableId, prevFocusableId } from './focus.ts';

/** 窗口几何：位置 + 尺寸，全部为像素整数语义的 number。 */
export interface Geometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 可用视口（渲染层传入，manager 不读 DOM）。 */
export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** 一条窗口记录；z 序由其在 records 数组中的位置表达，不存冗余 zOrder 字段。 */
export interface WindowRecord {
  readonly id: string;
  readonly contentType: string;
  readonly geometry: Geometry;
  readonly minimized: boolean;
}

/** 对外只读快照：每次返回新副本，外部不可改写内部状态。 */
export interface WindowManagerSnapshot {
  readonly windows: ReadonlyArray<WindowRecord>;
  readonly focusedId: string | null;
}

/** PLAN §7 P5：浮窗最小宽 360 / 最小高 240。 */
export const MIN_WINDOW_WIDTH = 360;
export const MIN_WINDOW_HEIGHT = 240;

/** 渲染层 z-index 基数：实际 z = BASE + index（index = 在 records 中的位置）。 */
export const WINDOW_BASE_Z_INDEX = 1000;

/** 平铺窗口之间的间隙（像素）。 */
export const DEFAULT_TILE_GAP = 8;

/** 层叠时每窗相对前一窗的右下偏移（像素）。 */
export const DEFAULT_CASCADE_STEP = 28;

/** 内容类型 → 默认尺寸。仅编辑器在 P5 落地；其余类型回退到 editor 尺寸。 */
export const DEFAULT_WINDOW_SIZES = Object.freeze({
  editor: Object.freeze({ width: 720, height: 480 }),
});

type Listener = () => void;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function defaultSizeFor(contentType: string): { readonly width: number; readonly height: number } {
  if (contentType === 'editor') return DEFAULT_WINDOW_SIZES.editor;
  return DEFAULT_WINDOW_SIZES.editor;
}

/**
 * 钳制几何到合法范围（T5）：先钳尺寸、后钳位置。
 *
 * 尺寸：`width ∈ [MIN_W, viewport.width]`、`height ∈ [MIN_H, viewport.height]`。
 * 当视口小于最小尺寸时，尺寸保持最小值（窗口溢出视口），位置被钳到左上角露出。
 * 位置：用钳制后的尺寸计算上下界 `max(0, viewport - size)`，保留调用方给定的
 * x/y 意图，仅做边界钳制——避免先钳位置（用旧大尺寸）再钳尺寸导致越界。
 */
export function clampGeometry(geometry: Geometry, viewport: Viewport): Geometry {
  // 尺寸：地板优先的非对称钳制（T5 原文）——视口小于最小尺寸时尺寸保持 MIN。
  const width = Math.max(MIN_WINDOW_WIDTH, Math.min(geometry.width, viewport.width));
  const height = Math.max(MIN_WINDOW_HEIGHT, Math.min(geometry.height, viewport.height));
  // 位置：用钳制后的尺寸算上界，再做对称钳制（上界恒 ≥ 0，故 min ≤ max）。
  const x = clamp(geometry.x, 0, Math.max(0, viewport.width - width));
  const y = clamp(geometry.y, 0, Math.max(0, viewport.height - height));
  return { x, y, width, height };
}

/**
 * 默认位置（PLAN §4 / ui-spec §11）：窗口垂直中心落在视口 45% 高度处
 * （略高于几何中线 50%），水平居中。仅计算、不钳制；钳制由 clampGeometry 负责。
 */
export function computeDefaultPosition(
  size: { readonly width: number; readonly height: number },
  viewport: Viewport,
): { readonly x: number; readonly y: number } {
  const x = (viewport.width - size.width) / 2;
  const y = viewport.height * 0.45 - size.height / 2;
  return { x, y };
}

/** 某内容类型的默认几何：取默认尺寸 → 算默认位置 → clampGeometry 钳制。 */
export function computeDefaultGeometry(contentType: string, viewport: Viewport): Geometry {
  const size = defaultSizeFor(contentType);
  const pos = computeDefaultPosition(size, viewport);
  return clampGeometry({ x: pos.x, y: pos.y, width: size.width, height: size.height }, viewport);
}

/**
 * 平铺布局（W4=B：纯几何可测）。单一公式无特例：cols = ceil(sqrt(n))，
 * rows = ceil(n / cols)，row-major 填入，末尾空格留空不分配。
 * 每格尺寸 = (视口 - 间隙) / 网格，再经 clampGeometry 保证最小尺寸与边界。
 */
export function computeTileLayout(
  ids: ReadonlyArray<string>,
  viewport: Viewport,
  gap = DEFAULT_TILE_GAP,
): Map<string, Geometry> {
  const result = new Map<string, Geometry>();
  const n = ids.length;
  if (n === 0) return result;

  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const cellW = (viewport.width - gap * (cols - 1)) / cols;
  const cellH = (viewport.height - gap * (rows - 1)) / rows;

  ids.forEach((id, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * (cellW + gap);
    const y = row * (cellH + gap);
    result.set(id, clampGeometry({ x, y, width: cellW, height: cellH }, viewport));
  });
  return result;
}

/**
 * 探测给定集合按平铺布局后是否存在两两矩形重叠（纯函数，可测）。
 *
 * 小视口下 clampGeometry 会把格子尺寸抬到 MIN_W/MIN_H；当 cellW/cellH 小于最小尺寸时，
 * 相邻格被放大后互相侵入，返回 true。渲染层据此提示「视口过小，窗口可能重叠」。
 * 矩形相交条件：a 左 < b 右 且 b 左 < a 右（y 轴同理），含相切不算重叠。
 */
export function hasTileOverlap(
  ids: ReadonlyArray<string>,
  viewport: Viewport,
  gap = DEFAULT_TILE_GAP,
): boolean {
  const layout = computeTileLayout(ids, viewport, gap);
  const geos = [...layout.values()];
  for (let i = 0; i < geos.length; i += 1) {
    for (let j = i + 1; j < geos.length; j += 1) {
      const a = geos[i];
      const b = geos[j];
      if (!a || !b) continue;
      const overlaps =
        a.x < b.x + b.width &&
        b.x < a.x + a.width &&
        a.y < b.y + b.height &&
        b.y < a.y + a.height;
      if (overlaps) return true;
    }
  }
  return false;
}

/**
 * 层叠布局：从默认位置起，每窗相对前一窗右下偏移 step，尺寸取内容类型默认；
 * 到视口边界由 clampGeometry 钳制。覆盖任意 n ≥ 1。
 */
export function computeCascadeLayout(
  ids: ReadonlyArray<string>,
  viewport: Viewport,
  step = DEFAULT_CASCADE_STEP,
): Map<string, Geometry> {
  const result = new Map<string, Geometry>();
  const n = ids.length;
  if (n === 0) return result;

  const size = DEFAULT_WINDOW_SIZES.editor;
  const base = computeDefaultPosition(size, viewport);
  ids.forEach((id, i) => {
    const x = base.x + i * step;
    const y = base.y + i * step;
    result.set(id, clampGeometry({ x, y, width: size.width, height: size.height }, viewport));
  });
  return result;
}

/** WindowManager：窗口系统唯一状态源。 */
export class WindowManager {
  private records: WindowRecord[] = [];
  private focusedId: string | null = null;
  private readonly rememberedById = new Map<string, Geometry>();
  private readonly defaultByContentType = new Map<string, Geometry>();
  private readonly listeners = new Set<Listener>();
  private cachedSnapshot: WindowManagerSnapshot | null = null;

  /** 订阅变更；返回取消订阅函数。 */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 只读快照：缓存到下次变更；返回深拷贝冻结副本，外部 mutation 不影响内部状态。 */
  snapshot(): WindowManagerSnapshot {
    if (this.cachedSnapshot !== null) return this.cachedSnapshot;
    const windows = this.records.map((r) =>
      Object.freeze({
        id: r.id,
        contentType: r.contentType,
        minimized: r.minimized,
        geometry: Object.freeze({ ...r.geometry }),
      }),
    );
    this.cachedSnapshot = { windows: Object.freeze(windows), focusedId: this.focusedId };
    return this.cachedSnapshot;
  }

  /** 注册某内容类型的自定义默认几何（实例级，不影响模块常量）。 */
  setDefaultGeometry(contentType: string, geometry: Geometry): void {
    this.defaultByContentType.set(contentType, { ...geometry });
  }

  /**
   * 打开窗口：已存在则激活（最小化窗先还原再激活）；否则按
   * 「记忆 > 内容类型默认 > 全局默认」取几何，压入数组末尾（最顶层）并设为焦点。
   */
  open(id: string, contentType: string, viewport: Viewport): WindowRecord {
    const existing = this.records.find((r) => r.id === id);
    if (existing) {
      // restore 会用 spread 生成新记录对象，故激活后需重取，不能返回过期的 existing 引用。
      if (existing.minimized) this.restore(id);
      this.activate(id);
      const updated = this.records.find((r) => r.id === id);
      return updated ?? existing;
    }
    const geometry = this.resolveGeometry(id, contentType, viewport);
    const record: WindowRecord = { id, contentType, geometry, minimized: false };
    this.records.push(record);
    this.focusedId = id;
    this.emit();
    return record;
  }

  private resolveGeometry(id: string, contentType: string, viewport: Viewport): Geometry {
    const remembered = this.rememberedById.get(id);
    if (remembered) return clampGeometry(remembered, viewport);
    const custom = this.defaultByContentType.get(contentType);
    if (custom) {
      const pos = computeDefaultPosition(custom, viewport);
      return clampGeometry({ x: pos.x, y: pos.y, width: custom.width, height: custom.height }, viewport);
    }
    return computeDefaultGeometry(contentType, viewport);
  }

  /** 关闭窗口：移除记录；焦点顺势落到最顶层非最小化窗口。会话内记忆保留（W2=C：跨 close/reopen 仍生效，跨会话持久化递延）。 */
  close(id: string): boolean {
    const idx = this.records.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    this.records.splice(idx, 1);
    if (this.focusedId === id) {
      const top = [...this.records].reverse().find((record) => !record.minimized);
      this.focusedId = top?.id ?? null;
    }
    this.emit();
    return true;
  }

  /** 仅切换焦点，不动 z 序。 */
  focus(id: string): boolean {
    if (!this.has(id)) return false;
    this.focusedId = id;
    this.emit();
    return true;
  }

  /** 仅置顶（移到数组末尾），不改焦点。 */
  raiseToTop(id: string): boolean {
    if (!this.raiseToTopInternal(id)) return false;
    this.emit();
    return true;
  }

  private raiseToTopInternal(id: string): boolean {
    const idx = this.records.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    const [record] = this.records.splice(idx, 1);
    if (record) this.records.push(record);
    return true;
  }

  /** 激活：置顶 + 聚焦（指针点击默认行为）。 */
  activate(id: string): boolean {
    if (!this.has(id)) return false;
    this.raiseToTopInternal(id);
    this.focusedId = id;
    this.emit();
    return true;
  }

  /** 向后循环聚焦（跳最小化），只改焦点不置顶。 */
  focusNext(): boolean {
    return this.cycleFocus(nextFocusableId);
  }

  /** 向前循环聚焦（跳最小化），只改焦点不置顶。 */
  focusPrev(): boolean {
    return this.cycleFocus(prevFocusableId);
  }

  private cycleFocus(picker: (records: ReadonlyArray<WindowRecord>, current: string | null) => string | null): boolean {
    const next = picker(this.records, this.focusedId);
    if (next === null) return false;
    this.focusedId = next;
    this.emit();
    return true;
  }

  /** 更新几何（拖拽/缩放后）：钳制后写入并记入会话记忆。 */
  setGeometry(id: string, geometry: Geometry, viewport: Viewport): boolean {
    const idx = this.records.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    const current = this.records[idx];
    if (!current) return false;
    const clamped = clampGeometry(geometry, viewport);
    this.records[idx] = { ...current, geometry: clamped };
    this.rememberedById.set(id, clamped);
    this.emit();
    return true;
  }

  minimize(id: string): boolean {
    return this.setMinimized(id, true);
  }

  restore(id: string): boolean {
    return this.setMinimized(id, false);
  }

  private setMinimized(id: string, minimized: boolean): boolean {
    const idx = this.records.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    const current = this.records[idx];
    if (!current) return false;
    this.records[idx] = { ...current, minimized };
    if (minimized && this.focusedId === id) {
      // 焦点窗最小化：焦点顺移到下一个可聚焦窗。无其他可聚焦窗口（唯一窗口 /
      // 最后一个可聚焦窗口）时 focusNext 返回 false 且内部不 emit，必须清空焦点并
      // 显式 emit，否则既违反「最小化窗口不可聚焦」，快照缓存也不会失效（P1 缺陷）。
      if (!this.focusNext()) {
        this.focusedId = null;
        this.emit();
      }
    } else {
      this.emit();
    }
    return true;
  }

  /** 对给定窗口集合应用平铺几何（不动 z 序/焦点）。 */
  tile(ids: ReadonlyArray<string>, viewport: Viewport): boolean {
    return this.applyLayout(computeTileLayout(ids, viewport));
  }

  /** 对给定窗口集合应用层叠几何（不动 z 序/焦点）。 */
  cascade(ids: ReadonlyArray<string>, viewport: Viewport): boolean {
    return this.applyLayout(computeCascadeLayout(ids, viewport));
  }

  private applyLayout(layout: Map<string, Geometry>): boolean {
    let applied = false;
    for (const [id, geometry] of layout) {
      const idx = this.records.findIndex((r) => r.id === id);
      if (idx === -1) continue;
      const current = this.records[idx];
      if (!current) continue;
      this.records[idx] = { ...current, geometry };
      applied = true;
    }
    if (applied) this.emit();
    return applied;
  }

  /** 派生 z-index：BASE + 在数组中的索引（末尾最大）。不存在返回 -1。 */
  getZIndex(id: string): number {
    const idx = this.records.findIndex((r) => r.id === id);
    if (idx === -1) return -1;
    return WINDOW_BASE_Z_INDEX + idx;
  }

  has(id: string): boolean {
    return this.records.some((r) => r.id === id);
  }

  get size(): number {
    return this.records.length;
  }

  private emit(): void {
    this.cachedSnapshot = null;
    for (const listener of this.listeners) listener();
  }
}
